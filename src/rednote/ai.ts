// M4.1 AI image analysis (plugin executor track, ADR-009 / ADR-018 修订):
//  - PURE helpers (request-body build, response parse, local-image-path
//    extraction, frontmatter `ai_sections` probe, AI-section merge, batch
//    split, base64 encode) — unit-tested in tests/ai.test.ts;
//  - ONE side-effect entry `analyzeImages` (Node https transport, modeled on
//    api.ts's nodeHttpsJson but deliberately independent per task contract:
//    60s timeout, never throws — API failures return { error }).
//
// Frontmatter/AI-section writing reuses the ADR-006 contract:
//   frontmatter `ai_model` + `ai_sections` (list, `image_analysis` marker),
//   body `## 🤖 AI 摘要` section with a `### 图片分析` subsection.
// The AI section tail-preservation rule (markdown.ts splitAiSection /
// appendAiSection) is honored: appending never touches content above the
// AI heading, and an existing `### 图片分析` block is REPLACED in place so
// repeated runs stay idempotent.

/** Chinese prompt sent with every image batch (task contract wording). */
export const IMAGE_ANALYSIS_PROMPT =
	"请分析这组小红书笔记图片，输出：1) 图片内容概述；2) 图中关键文字（OCR）；3) 要点列表。" +
	"用简洁中文回答，总长度不超过 200 字。";

/** Frontmatter section marker written by this module. */
export const AI_SECTION_IMAGE = "image_analysis";

/** The `## 🤖 AI 摘要` heading (kept in sync with markdown.ts's constant). */
const AI_HEADING = "## 🤖 AI 摘要";
/** The `### 图片分析` subsection heading. */
const IMAGE_SUBHEADING = "### 图片分析";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * MIME type for a local image path by extension ("" = unknown).
 */
export function imageMimeFromPath(path: string): string {
	const m = (path ?? "").toLowerCase().match(/\.([a-z0-9]+)$/);
	switch (m?.[1]) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "bmp":
			return "image/bmp";
		default:
			return "";
	}
}

/**
 * Base64-encode an ArrayBuffer without Node Buffer (runs in the Obsidian
 * renderer too). Chunked String.fromCharCode keeps the stack safe for
 * multi-hundred-KB images. Pure.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/**
 * Build the OpenAI-compatible /chat/completions request body for a vision
 * call: a text prompt plus one image_url data URI per image. Pure.
 *
 * @param model         Model name; "" omits the field (server default).
 * @param prompt        Text prompt.
 * @param imageDataUris Full data URIs ("data:image/jpeg;base64,...").
 */
export function buildVisionRequestBody(
	model: string,
	prompt: string,
	imageDataUris: string[],
): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [
		{ type: "text", text: prompt },
	];
	for (const uri of imageDataUris) {
		content.push({ type: "image_url", image_url: { url: uri } });
	}
	const body: Record<string, unknown> = {
		messages: [{ role: "user", content }],
	};
	if (model) {
		body["model"] = model;
	}
	return body;
}

/**
 * Parse an OpenAI-compatible chat completion response body (raw text) into
 * the assistant message content. Returns { error } for any non-conforming
 * payload (HTTP-layer status is handled by the caller). Pure, never throws.
 */
export function parseChatCompletion(
	raw: string,
): { text: string } | { error: string } {
	try {
		const data = JSON.parse(raw) as {
			choices?: Array<{ message?: { content?: unknown } }>;
			error?: { message?: unknown } | string;
		};
		const apiError = data?.error;
		if (apiError) {
			const msg =
				typeof apiError === "string" ? apiError : String(apiError?.message ?? "未知错误");
			return { error: `接口返回错误：${msg}` };
		}
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content === "string" && content.length > 0) {
			return { text: content };
		}
		return { error: "响应中没有 choices[0].message.content" };
	} catch {
		return { error: `响应不是合法 JSON：${raw.slice(0, 120)}` };
	}
}

/**
 * Extract LOCAL media image paths embedded in a rendered note body:
 * markdown images `![](...)` whose target starts with `mediaPrefix`
 * (e.g. "RedNote/Media"). Remote URLs are ignored. Order-preserving,
 * deduplicated. Pure.
 */
export function extractLocalImagePaths(markdown: string, mediaPrefix: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown ?? "")) !== null) {
		const raw = m[1];
		if (raw === undefined) {
			continue;
		}
		let p = raw;
		try {
			p = decodeURIComponent(p);
		} catch {
			/* keep raw path */
		}
		if (!p.startsWith(mediaPrefix) || seen.has(p)) {
			continue;
		}
		seen.add(p);
		out.push(p);
	}
	return out;
}

/**
 * Lightweight frontmatter probe (NO yaml dependency per task contract):
 * does this note's `ai_sections` frontmatter already contain
 * `image_analysis`? Handles both block-list and inline-list forms and
 * tolerates quoted values. Pure.
 */
export function frontmatterHasImageAnalysis(content: string): boolean {
	if (!content) {
		return false;
	}
	const fm = matchFrontmatter(content);
	if (!fm) {
		return false;
	}
	const lines = fm.body.split(/\r?\n/);
	let inSections = false;
	for (const line of lines) {
		if (/^ai_sections:/.test(line)) {
			const inline = line.slice("ai_sections:".length).trim();
			if (inline) {
				// Inline form: ai_sections: [transcript, image_analysis]
				return inline.includes(AI_SECTION_IMAGE);
			}
			inSections = true;
			continue;
		}
		if (inSections) {
			const item = line.match(/^\s+-\s*(.+)$/);
			if (item) {
				const val = item[1] ?? "";
				if (val.trim().replace(/^["']|["']$/g, "") === AI_SECTION_IMAGE) {
					return true;
				}
				continue;
			}
			inSections = false;
		}
	}
	return false;
}

/** A guarded frontmatter match (noUncheckedIndexedAccess-safe). */
interface FrontmatterMatch {
	open: string;
	body: string;
	close: string;
	rest: string;
}

function matchFrontmatter(content: string): FrontmatterMatch | null {
	const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
	if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
		return null;
	}
	return { open: m[1], body: m[2], close: m[3], rest: content.slice(m[0].length) };
}

function rebuildFrontmatter(fm: FrontmatterMatch, newBody: string): string {
	return `${fm.open}${newBody}${fm.close}${fm.rest}`;
}

/**
 * Set (replace or append) a single-line frontmatter field on a note that
 * HAS frontmatter. Pure; returns content unchanged when there is no
 * frontmatter block.
 */
function setFrontmatterLine(content: string, key: string, line: string): string {
	const fm = matchFrontmatter(content);
	if (!fm) {
		return content;
	}
	const re = new RegExp(`^${key}:.*$`, "m");
	if (re.test(fm.body)) {
		return rebuildFrontmatter(fm, fm.body.replace(re, line));
	}
	return rebuildFrontmatter(fm, `${fm.body}\n${line}`);
}

/** YAML scalar escape consistent with markdown.ts's yamlScalar. */
function yamlScalar(value: string): string {
	return `"${(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Add `image_analysis` to the note's `ai_sections` frontmatter without
 * disturbing other markers (block list gains a list item; inline list gains
 * an element; absent key gains a fresh block list). Pure. Caller guarantees
 * the marker is not already present.
 */
function addImageAnalysisMarker(content: string): string {
	const fm = matchFrontmatter(content);
	if (!fm) {
		return content;
	}
	const body = fm.body;
	const secRe = /^ai_sections:.*$/m;
	if (!secRe.test(body)) {
		return rebuildFrontmatter(fm, `${body}\nai_sections:\n  - ${AI_SECTION_IMAGE}`);
	}
	const matched = body.match(secRe);
	const existing = matched?.[0] ?? "";
	const inline = existing.slice("ai_sections:".length).trim();
	if (inline) {
		const inner = inline.replace(/^\[/, "").replace(/\]$/, "").trim();
		const replacement = `ai_sections: [${inner ? `${inner}, ` : ""}${AI_SECTION_IMAGE}]`;
		return rebuildFrontmatter(fm, body.replace(secRe, replacement));
	}
	// Block form: append the item right after the `ai_sections:` line,
	// before whatever (non-list) line follows the block.
	const lines = body.split(/\r?\n/);
	const idx = lines.findIndex((l) => /^ai_sections:/.test(l));
	let end = idx + 1;
	while (end < lines.length && /^\s+-\s/.test(lines[end] ?? "")) {
		end += 1;
	}
	lines.splice(end, 0, `  - ${AI_SECTION_IMAGE}`);
	return rebuildFrontmatter(fm, lines.join("\n"));
}

/**
 * Append (or replace) the `### 图片分析` subsection inside the note's
 * `## 🤖 AI 摘要` section, creating the section at EOF when absent, and
 * update frontmatter `ai_model` / `ai_sections`. Pure.
 *
 * Idempotent: a second application with the same text produces the same
 * file. Everything ABOVE the AI heading (the original note body) is never
 * modified; other AI subsections (e.g. `### 视频转写`) before the image
 * block are preserved verbatim.
 */
export function applyImageAnalysis(
	content: string,
	model: string,
	text: string,
): string {
	let out = content ?? "";
	if (!out.startsWith("---")) {
		// No frontmatter (unexpected): still append the section at EOF.
		out = `${out.replace(/\n*$/, "\n")}\n`;
	} else {
		out = setFrontmatterLine(out, "ai_model", `ai_model: ${yamlScalar(model)}`);
		if (!frontmatterHasImageAnalysis(out)) {
			out = addImageAnalysisMarker(out);
		}
	}

	const block = `${IMAGE_SUBHEADING}\n${text.replace(/\n*$/, "\n")}`;
	const headingIdx = out.indexOf(`\n${AI_HEADING}`);
	const startsWithHeading = out.startsWith(AI_HEADING);
	if (headingIdx < 0 && !startsWithHeading) {
		return `${out.replace(/\n*$/, "\n")}\n${AI_HEADING}\n\n${block}`;
	}
	const at = startsWithHeading && headingIdx < 0 ? 0 : headingIdx + 1;
	const head = out.slice(0, at);
	const aiBody = out.slice(at);
	// Replace an existing 图片分析 subsection (up to the next `### ` or EOF),
	// otherwise append at the end of the AI section.
	const subIdx = aiBody.indexOf(`\n${IMAGE_SUBHEADING}`);
	if (subIdx >= 0) {
		let next = aiBody.length;
		const following = aiBody.slice(subIdx + 1).indexOf("\n### ");
		if (following >= 0) {
			next = subIdx + 1 + following + 1;
		}
		const rest = aiBody.slice(next).replace(/^\n+/, "");
		return rest
			? `${head}${aiBody.slice(0, subIdx + 1)}${block}\n${rest}`
			: `${head}${aiBody.slice(0, subIdx + 1)}${block}`;
	}
	return `${head}${aiBody.replace(/\n*$/, "\n")}\n${block}`;
}

/**
 * Split items into batches of at most `size` (size < 1 -> one batch).
 * Pure.
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
	const s = Number.isFinite(size) && size >= 1 ? Math.floor(size) : items.length || 1;
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += s) {
		out.push(items.slice(i, i + s));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Side effects (transport + file IO)
// ---------------------------------------------------------------------------

/**
 * Plain Node POST of a JSON body. Protocol-aware: an http:// base URL (e.g. a
 * LAN-hosted model service like http://192.168.x.x:8010/v1) MUST go through
 * the http module — forcing https turned every request into ECONNREFUSED on
 * :443 (observed on first real-device run). https:// URLs use the https
 * module as before. 60s timeout, fresh agent per request.
 */
function httpsPostJson(
	url: string,
	headers: Record<string, string>,
	body: string,
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		try {
			const reqquire = (window as unknown as { require?: (m: string) => unknown })
				.require;
			const u = new URL(url);
			const isTls = u.protocol === "https:";
			const mod = reqquire?.(isTls ? "https" : "http") as
				| typeof import("https")
				| typeof import("http")
				| undefined;
			if (!mod) {
				reject(new Error("Node http(s) 模块不可用"));
				return;
			}
			const req = mod.request(
				{
					hostname: u.hostname,
					port: u.port || (isTls ? 443 : 80),
					path: u.pathname + u.search,
					method: "POST",
					headers,
					timeout: 60_000,
					agent: false,
				},
				(res) => {
					let d = "";
					res.on("data", (c: Buffer) => {
						d += c.toString("utf8");
					});
					res.on("end", () => {
						resolve({ status: res.statusCode ?? 0, text: d });
					});
				},
			);
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy();
				reject(new Error("请求超时（60s）"));
			});
			req.write(body);
			req.end();
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

/** Minimal adapter surface used here (subset of Obsidian's DataAdapter). */
export interface AiVaultAdapter {
	readBinary(path: string): Promise<ArrayBuffer>;
	exists(path: string): Promise<boolean>;
}

/**
 * Analyze one note's local images via an OpenAI-compatible vision endpoint.
 * NEVER throws and NEVER returns a rejected promise: any failure (missing
 * image, transport, HTTP, parse) comes back as `{ error }` so the sync /
 * backfill pipelines can log-and-skip per note.
 *
 * @param baseUrl    e.g. "https://api.example.com/v1" (/chat/completions appended).
 * @param apiKey     Bearer token ("" = no Authorization header).
 * @param model      Model name ("" = server default).
 * @param imagePaths Vault-relative local image paths.
 * @param adapter    Vault adapter (readBinary/exists).
 */
export async function analyzeImages(
	baseUrl: string,
	apiKey: string,
	model: string,
	imagePaths: string[],
	adapter: AiVaultAdapter,
): Promise<{ text: string } | { error: string }> {
	try {
		const uris: string[] = [];
		for (const p of imagePaths) {
			const mime = imageMimeFromPath(p);
			if (!mime) {
				return { error: `不支持的图片格式：${p}` };
			}
			if (!(await adapter.exists(p))) {
				return { error: `本地图片不存在：${p}` };
			}
			const buf = await adapter.readBinary(p);
			uris.push(`data:${mime};base64,${arrayBufferToBase64(buf)}`);
		}
		if (uris.length === 0) {
			return { error: "没有可分析的图片" };
		}
		const body = JSON.stringify(
			buildVisionRequestBody(model, IMAGE_ANALYSIS_PROMPT, uris),
		);
		const url = `${(baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			// Explicit Content-Length: without it Node switches to chunked
			// transfer-encoding, which many simple model servers cannot parse
			// (observed: HTTP 400 "invalid JSON char 0" + ECONNRESET).
			"Content-Length": String(Buffer.byteLength(body, "utf8")),
		};
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}
		const res = await httpsPostJson(url, headers, body);
		if (res.status < 200 || res.status >= 300) {
			return { error: `HTTP ${res.status}：${res.text.slice(0, 200)}` };
		}
		return parseChatCompletion(res.text);
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}
