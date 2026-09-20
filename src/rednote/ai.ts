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
	"你收到的是一个小红书笔记的全部图片。请按以下步骤输出：\n" +
	"1. 【图中文字】逐张完整转录图中可见的全部文字（OCR，保留原文，含图中标注/水印文字；每张图用「图N：」开头；某张图无文字则写「图N：（无文字）」）\n" +
	"2. 【图片内容概述】这组图片整体展示了什么\n" +
	"3. 【要点】3-5 条要点\n" +
	"全文中文，简洁。";

/** Frontmatter section marker written by this module. */
export const AI_SECTION_IMAGE = "image_analysis";

/** Frontmatter section marker for video transcription (M4 video track). */
export const AI_SECTION_VIDEO = "video_transcript";

/** The `## 🤖 AI 摘要` heading (kept in sync with markdown.ts's constant). */
const AI_HEADING = "## 🤖 AI 摘要";
/** The `### 图片分析` subsection heading. */
const IMAGE_SUBHEADING = "### 图片分析";
/** The `### 视频转写` subsection heading. */
const VIDEO_SUBHEADING = "### 视频转写";

/** Chinese prompt sent with every video transcription call (task contract wording). */
export const VIDEO_ANALYSIS_PROMPT =
	"你会收到完整视频（含画面与音频）。请输出：\n" +
	"1) 完整中文/原文语音转录稿（口语原样）；2) 三句话摘要；\n" +
	"3. 【关键时刻】3-5 个值得截图的时间点，JSON 数组格式 " +
	'[{"t": 秒, "why": "理由"}]，放在输出末尾的 ```json 代码块中';

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
 * Build the OpenAI-compatible /chat/completions request body for a video
 * call (qwen-style): a text prompt plus one `video_url` content item with the
 * direct video URL. Pure.
 *
 * @param model    Model name; "" omits the field (server default).
 * @param prompt   Text prompt.
 * @param videoUrl    Direct video URL (CDN-signed link).
 * @param audioBase64 Optional base64 of the video's audio track (mp3). When
 *                    present (and only when videoBase64 is absent), a
 *                    qwen-style `audio_url` item (data URI) is appended after
 *                    the video_url item.
 * @param videoBase64 Optional base64 of the FULL video (mp4). When present,
 *                    the video_url item's url becomes a
 *                    `data:video/mp4;base64,...` data URI (full-video direct
 *                    upload; the model natively handles A/V in one request)
 *                    and audioBase64 is NOT appended.
 */
export function buildVideoRequestBody(
	model: string,
	prompt: string,
	videoUrl: string,
	audioBase64?: string,
	videoBase64?: string,
): Record<string, unknown> {
	const videoUrlValue = videoBase64
		? `data:video/mp4;base64,${videoBase64}`
		: videoUrl;
	const content: Array<Record<string, unknown>> = [
		{ type: "text", text: prompt },
		{ type: "video_url", video_url: { url: videoUrlValue } },
	];
	if (audioBase64 && !videoBase64) {
		content.push({
			type: "audio_url",
			audio_url: { url: `data:audio/mp3;base64,${audioBase64}` },
		});
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
 * (e.g. "RedNote/Media"). Remote URLs are ignored. Embed targets are written
 * vault-absolute ("/RedNote/Media/...") for Obsidian link resolution — the
 * leading "/" is stripped here so the result is the vault-relative ADAPTER
 * path. Order-preserving, deduplicated. Pure.
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
		// Vault-absolute embed ("/RedNote/Media/...") -> adapter-relative.
		p = p.replace(/^\/+/, "");
		if (!p.startsWith(mediaPrefix) || seen.has(p)) {
			continue;
		}
		seen.add(p);
		out.push(p);
	}
	return out;
}

/**
 * Read a single-line frontmatter field value (double-quoted or bare).
 * Returns "" when absent. Pure.
 */
export function frontmatterStringValue(content: string, key: string): string {
	const fm = matchFrontmatter(content);
	if (!fm) {
		return "";
	}
	const m = fm.body.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	const raw = (m?.[1] ?? "").trim();
	return raw.replace(/^["']|["']$/g, "");
}

/**
 * Lightweight frontmatter probe (NO yaml dependency per task contract):
 * does this note's `ai_sections` frontmatter already contain the given
 * section marker? Handles both block-list and inline-list forms and
 * tolerates quoted values. Pure.
 */
export function frontmatterHasSection(content: string, section: string): boolean {
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
				return inline.includes(section);
			}
			inSections = true;
			continue;
		}
		if (inSections) {
			const item = line.match(/^\s+-\s*(.+)$/);
			if (item) {
				const val = item[1] ?? "";
				if (val.trim().replace(/^["']|["']$/g, "") === section) {
					return true;
				}
				continue;
			}
			inSections = false;
		}
	}
	return false;
}

/**
 * `frontmatterHasSection(content, "image_analysis")` — kept for the existing
 * callers. Pure.
 */
export function frontmatterHasImageAnalysis(content: string): boolean {
	return frontmatterHasSection(content, AI_SECTION_IMAGE);
}

/**
 * Does the note's frontmatter declare `type: video`? Tolerates quoting.
 * Pure.
 */
export function frontmatterTypeIsVideo(content: string): boolean {
	if (!content) {
		return false;
	}
	const fm = matchFrontmatter(content);
	if (!fm) {
		return false;
	}
	return /^type:\s*["']?video["']?\s*$/m.test(fm.body);
}

/**
 * Extract the direct video URL from a rendered note body: the
 * `[▶ 观看视频](url)` / `[▶ 视频](url)` markdown link. Only remote http(s)
 * URLs count — a local media path means the video was downloaded (M3) and
 * cannot be fed to the AI as a link. Pure.
 */
export function extractVideoNoteUrl(markdown: string): string {
	const re = /\[▶ (?:观看视频|视频)\]\(([^)\s]+)\)/;
	const m = (markdown ?? "").match(re);
	const url = m?.[1] ?? "";
	return /^https?:\/\//.test(url) ? url : "";
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
 * Add a section marker to the note's `ai_sections` frontmatter without
 * disturbing other markers (block list gains a list item; inline list gains
 * an element; absent key gains a fresh block list). Pure. Caller guarantees
 * the marker is not already present.
 */
function addSectionMarker(content: string, section: string): string {
	const fm = matchFrontmatter(content);
	if (!fm) {
		return content;
	}
	const body = fm.body;
	const secRe = /^ai_sections:.*$/m;
	if (!secRe.test(body)) {
		return rebuildFrontmatter(fm, `${body}\nai_sections:\n  - ${section}`);
	}
	const matched = body.match(secRe);
	const existing = matched?.[0] ?? "";
	const inline = existing.slice("ai_sections:".length).trim();
	if (inline) {
		const inner = inline.replace(/^\[/, "").replace(/\]$/, "").trim();
		const replacement = `ai_sections: [${inner ? `${inner}, ` : ""}${section}]`;
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
	lines.splice(end, 0, `  - ${section}`);
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
	return applyAiSubsection(content, model, AI_SECTION_IMAGE, IMAGE_SUBHEADING, text);
}

/**
 * M4 (video track): append (or replace) the `### 视频转写` subsection inside
 * the note's `## 🤖 AI 摘要` section and update frontmatter `ai_model` /
 * `ai_sections` (+`video_transcript` marker). Pure and idempotent; any
 * existing `### 图片分析` block is preserved verbatim (and vice versa — the
 * image applier preserves an existing `### 视频转写`).
 */
export function applyVideoTranscript(
	content: string,
	model: string,
	text: string,
): string {
	return applyAiSubsection(content, model, AI_SECTION_VIDEO, VIDEO_SUBHEADING, text);
}

/** One AI-suggested key frame of a video note. */
export interface VideoKeyMoment {
	/** Seconds into the video. */
	t: number;
	/** One-sentence reason. */
	why: string;
}

/** The `### 关键帧` subsection heading. */
const KEYFRAMES_SUBHEADING = "### 关键帧";

/**
 * Normalize one raw key-moment item: `t` may be a number or a timestamp
 * string ("SS" / "M:SS" / "MM:SS" / "H:MM:SS", normalized to seconds);
 * `why` must be a non-empty string. Unparseable items are dropped. Pure.
 */
function normalizeKeyMomentItem(item: unknown): VideoKeyMoment | null {
	const it = item as { t?: unknown; why?: unknown } | null;
	if (!it || typeof it !== "object") {
		return null;
	}
	let t: number;
	if (typeof it.t === "number") {
		t = it.t;
	} else if (typeof it.t === "string") {
		const s = it.t.trim();
		if (/^\d+(\.\d+)?$/.test(s)) {
			t = Number(s);
		} else {
			const parts = s.split(":").map((p) => p.trim());
			if (
				parts.length < 2 ||
				parts.length > 3 ||
				!parts.every((p) => /^\d+$/.test(p))
			) {
				return null;
			}
			t = 0;
			for (const p of parts) {
				t = t * 60 + Number(p);
			}
		}
	} else {
		return null;
	}
	if (typeof it.why !== "string" || !it.why.trim()) {
		return null;
	}
	return Number.isFinite(t) && t >= 0 ? { t, why: it.why.trim() } : null;
}

/**
 * Best-effort textual repair of a near-JSON key-moments block before
 * JSON.parse: single-quoted keys/values -> double quotes, trailing commas
 * removed. Pure, never throws.
 */
function repairJsonKeyMoments(body: string): string {
	let out = (body ?? "").replace(/'([^'\\\n]*)'\s*:/g, '"$1":');
	out = out.replace(/:\s*'([^'\\\n]*)'/g, ': "$1"');
	out = out.replace(/,(\s*[}\]])/g, "$1");
	return out;
}

/** Safe JSON.parse -> unknown[] (empty on any failure). */
function tryParseKeyMoments(body: string): unknown[] {
	try {
		const parsed = JSON.parse(body) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * Last-resort regex mining of `{"t": ..., "why": ...}` items from a block
 * that could not be JSON.parse'd even after repairs (e.g. single-quoted
 * values, MM:SS string timestamps mixed with prose). Pure.
 */
function mineKeyMoments(body: string): VideoKeyMoment[] {
	const out: VideoKeyMoment[] = [];
	const objRe = /\{[^{}]*\}/g;
	let m: RegExpExecArray | null;
	while ((m = objRe.exec(body ?? "")) !== null) {
		const obj = m[0];
		const tMatch = obj.match(/['"]?t['"]?\s*:\s*("?[\d:]+"?)/);
		const whyMatch = obj.match(/['"]?why['"]?\s*:\s*'([^']*)'|['"]?why['"]?\s*:\s*"([^"]*)"/);
		if (!tMatch || !whyMatch) {
			continue;
		}
		const tRaw = (tMatch[1] ?? "").replace(/^"|"$/g, "");
		const why = whyMatch[1] ?? whyMatch[2] ?? "";
		out.push(normalizeKeyMomentItem({ t: tRaw, why }) as VideoKeyMoment);
	}
	return out.filter((x): x is VideoKeyMoment => x !== null);
}

/** Cap on the number of key moments honored per video. */
const MAX_KEY_MOMENTS = 8;

/**
 * Extract the trailing ```json code block's key-moments array from a video
 * transcription text. Tolerant:
 * - string timestamps ("MM:SS" ...) are normalized to seconds;
 * - single-quoted values / trailing commas are repaired before JSON.parse;
 * - items that still fail to normalize are dropped (valid ones kept);
 * - when parsing fully fails, items are regex-mined from the raw block and
 *   returned as `fallback` (text-only listing; no frame extraction).
 * The ```json block is ALWAYS stripped from the returned text so raw JSON
 * never reaches the note. Pure, never throws.
 */
export function parseVideoKeyMoments(
	text: string,
): {
	text: string;
	keyMoments: VideoKeyMoment[];
	/** Text-only fallback items, present only when structured parsing failed. */
	fallback?: VideoKeyMoment[];
} {
	const source = text ?? "";
	const re = /```json\s*([\s\S]*?)```/;
	const m = source.match(re);
	const body = m?.[1];
	if (!body) {
		return { text: source, keyMoments: [] };
	}
	let moments = tryParseKeyMoments(body)
		.map(normalizeKeyMomentItem)
		.filter((x): x is VideoKeyMoment => x !== null);
	if (moments.length === 0) {
		moments = tryParseKeyMoments(repairJsonKeyMoments(body))
			.map(normalizeKeyMomentItem)
			.filter((x): x is VideoKeyMoment => x !== null);
	}
	let fallback: VideoKeyMoment[] | undefined;
	if (moments.length === 0) {
		const mined = mineKeyMoments(body);
		if (mined.length > 0) {
			fallback = mined.slice(0, MAX_KEY_MOMENTS);
		}
	} else if (moments.length > MAX_KEY_MOMENTS) {
		moments = moments.slice(0, MAX_KEY_MOMENTS);
	}
	const stripped = source.replace(re, "").replace(/\n+$/, "\n");
	return fallback
		? { text: stripped, keyMoments: [], fallback }
		: { text: stripped, keyMoments: moments };
}

/**
 * Render the text-only fallback listing for key moments whose json block
 * could not be parsed: one `- 第 X 秒：理由` line per item. Returns "" for an
 * empty list. Pure.
 */
export function renderKeyMomentsFallback(
	moments: readonly VideoKeyMoment[],
): string {
	const items = (moments ?? []).filter(
		(m): m is VideoKeyMoment => !!m && typeof m.t === "number" && typeof m.why === "string",
	);
	if (items.length === 0) {
		return "";
	}
	const lines = items.map((m) => `- 第 ${m.t} 秒：${m.why}`);
	return `关键时刻（文字版）：\n${lines.join("\n")}`;
}

/**
 * Render the `### 关键帧` subsection body: one embed line per extracted
 * frame, embed targets vault-absolute ("/{mediaFolder}/{noteId}/kf-...").
 * Returns "" for an empty moment list. Pure.
 */
export function renderKeyFramesSection(
	keyMoments: readonly VideoKeyMoment[],
	noteId: string,
	mediaFolder: string,
): string {
	const moments = keyMoments ?? [];
	if (moments.length === 0) {
		return "";
	}
	const cleanFolder = (mediaFolder ?? "").replace(/^\/+|\/+$/g, "");
	const lines = moments.map((km, i) => {
		const path = `/${cleanFolder}/${noteId}/kf-${i + 1}-${km.t}s.jpg`;
		return `- ![关键帧${km.t}s](${path})（${km.why}）`;
	});
	return `${KEYFRAMES_SUBHEADING}\n${lines.join("\n")}`;
}

/**
 * Append (or replace) the `### 关键帧` subsection immediately after the
 * `### 视频转写` block (or at the end of the AI section when no transcript
 * block exists). Pure and idempotent. Returns content unchanged when the
 * rendered section is empty.
 */
export function applyKeyFrames(
	content: string,
	keyMoments: readonly VideoKeyMoment[],
	noteId: string,
	mediaFolder: string,
): string {
	const block = renderKeyFramesSection(keyMoments, noteId, mediaFolder);
	if (!block) {
		return content;
	}
	let out = content ?? "";
	// Replace an existing 关键帧 block (up to the next `### ` / EOF).
	const existingIdx = out.indexOf(`\n${KEYFRAMES_SUBHEADING}`);
	if (existingIdx >= 0) {
		let next = out.length;
		const following = out.slice(existingIdx + 1).indexOf("\n### ");
		if (following >= 0) {
			next = existingIdx + 1 + following + 1;
		}
		return `${out.slice(0, existingIdx + 1)}${block}\n${out.slice(next).replace(/^\n+/, "")}`;
	}
	// Insert after the 视频转写 block when present.
	const videoIdx = out.indexOf(`\n${VIDEO_SUBHEADING}`);
	if (videoIdx >= 0) {
		let insertAt = out.length;
		const following = out.slice(videoIdx + 1).indexOf("\n### ");
		if (following >= 0) {
			insertAt = videoIdx + 1 + following + 1;
		}
		return `${out.slice(0, insertAt).replace(/\n*$/, "\n")}\n${block}\n${out.slice(insertAt).replace(/^\n+/, "")}`;
	}
	return `${out.replace(/\n*$/, "\n")}\n${block}`;
}

/**
 * Shared implementation for both AI appliers: write the `model` frontmatter,
 * add `section` to `ai_sections` when missing, then append (or replace) the
 * `subheading` subsection inside the AI section. Pure.
 */
function applyAiSubsection(
	content: string,
	model: string,
	section: string,
	subheading: string,
	text: string,
): string {
	let out = content ?? "";
	if (!out.startsWith("---")) {
		// No frontmatter (unexpected): still append the section at EOF.
		out = `${out.replace(/\n*$/, "\n")}\n`;
	} else {
		out = setFrontmatterLine(out, "ai_model", `ai_model: ${yamlScalar(model)}`);
		if (!frontmatterHasSection(out, section)) {
			out = addSectionMarker(out, section);
		}
	}

	const block = `${subheading}\n${text.replace(/\n*$/, "\n")}`;
	const headingIdx = out.indexOf(`\n${AI_HEADING}`);
	const startsWithHeading = out.startsWith(AI_HEADING);
	if (headingIdx < 0 && !startsWithHeading) {
		return `${out.replace(/\n*$/, "\n")}\n${AI_HEADING}\n\n${block}`;
	}
	const at = startsWithHeading && headingIdx < 0 ? 0 : headingIdx + 1;
	const head = out.slice(0, at);
	const aiBody = out.slice(at);
	// Replace an existing subsection with this heading (up to the next
	// `### ` or EOF), otherwise append at the end of the AI section.
	const subIdx = aiBody.indexOf(`\n${subheading}`);
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

/** Max full-video payload handed to the model API: 40MB of mp4 bytes. */
const VIDEO_MAX_BYTES = 40 * 1024 * 1024;

/**
 * Download the FULL video as base64 (mp4) via a plain Node http(s) GET:
 * no ffmpeg involved — the complete file is pulled into an in-memory buffer
 * and base64-encoded for a single-request full-video data-URI upload
 * (user-verified: the LAN model service natively handles A/V this way).
 * Protocol-aware like httpsPostJson (http:// LAN bases MUST use the http
 * module). 120s timeout, 40MB size cap, fresh agent per request. Returns
 * null on any failure (transport, timeout, over-size) and reports the reason
 * via `log` — callers then fall back to the audio-track/remote-URL path.
 * NEVER throws.
 */
export async function fetchVideoBase64(
	videoUrl: string,
	log?: (line: string) => void,
): Promise<string | null> {
	if (!videoUrl) {
		return null;
	}
	return new Promise((resolve) => {
		let settled = false;
		const done = (b: string | null): void => {
			if (!settled) {
				settled = true;
				resolve(b);
			}
		};
		try {
			const reqquire = (window as unknown as { require?: (m: string) => unknown })
				.require;
			const u = new URL(videoUrl);
			const isTls = u.protocol === "https:";
			const mod = reqquire?.(isTls ? "https" : "http") as
				| typeof import("https")
				| typeof import("http")
				| undefined;
			if (!mod) {
				log?.("完整视频下载：Node http(s) 模块不可用，降级抽帧/音轨模式");
				done(null);
				return;
			}
			const req = mod.request(
				{
					hostname: u.hostname,
					port: u.port || (isTls ? 443 : 80),
					path: u.pathname + u.search,
					method: "GET",
					timeout: 120_000,
					agent: false,
				},
				(res) => {
					// Follow one redirect level (CDN links commonly 30x).
					const status = res.statusCode ?? 0;
					if (status >= 300 && status < 400) {
						const loc = res.headers.location;
						res.resume();
						if (typeof loc === "string" && loc) {
							try {
								const redirectUrl = new URL(loc, videoUrl).toString();
								fetchVideoBase64(redirectUrl, log).then(done);
								return;
							} catch {
								/* fall through to error below */
							}
						}
						log?.(`完整视频下载：HTTP ${status} 重定向无效，降级抽帧/音轨模式`);
						done(null);
						return;
					}
					if (status < 200 || status >= 300) {
						res.resume();
						log?.(`完整视频下载：HTTP ${status}，降级抽帧/音轨模式`);
						done(null);
						return;
					}
					const chunks: Buffer[] = [];
					let total = 0;
					res.on("data", (c: Buffer) => {
						total += c.length;
						if (total > VIDEO_MAX_BYTES) {
							req.destroy();
							log?.(
								`视频超过 40MB 上限，降级抽帧模式`,
							);
							done(null);
							return;
						}
						chunks.push(c);
					});
					res.on("end", () => {
						if (total > VIDEO_MAX_BYTES) {
							done(null);
							return;
						}
						if (total === 0) {
							log?.("完整视频下载：响应为空，降级抽帧/音轨模式");
							done(null);
							return;
						}
						done(Buffer.concat(chunks).toString("base64"));
					});
					res.on("error", () => {
						log?.("完整视频下载：响应读取失败，降级抽帧/音轨模式");
						done(null);
					});
				},
			);
			req.on("error", () => {
				log?.("完整视频下载：请求失败，降级抽帧/音轨模式");
				done(null);
			});
			req.on("timeout", () => {
				req.destroy();
				log?.("完整视频下载：请求超时（120s），降级抽帧/音轨模式");
				done(null);
			});
			req.end();
		} catch (e) {
			log?.(
				`完整视频下载失败（降级抽帧/音轨模式）：${e instanceof Error ? e.message : String(e)}`,
			);
			done(null);
		}
	});
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

/**
 * Transcribe + summarize one video note via an OpenAI-compatible endpoint
 * using the qwen-style `video_url` content item with the direct CDN link.
 * Shares analyzeImages' transport/timeout/error/parse handling: never throws,
 * failures come back as `{ error }`. No adapter needed — the video is not
 * downloaded, the URL is passed straight through.
 *
 * On success the trailing ```json key-moments block (per VIDEO_ANALYSIS_PROMPT)
 * is parsed out of the text: `keyMoments` carries the parsed array (absent
 * when the model returned none / a malformed block) and `text` has the block
 * stripped so only prose reaches the note.
 */
export async function analyzeVideo(
	baseUrl: string,
	apiKey: string,
	model: string,
	videoUrl: string,
	audioBase64?: string,
	videoBase64?: string,
): Promise<
	| { text: string; keyMoments?: VideoKeyMoment[]; fallback?: VideoKeyMoment[] }
	| { error: string }
> {
	try {
		if (!videoUrl && !videoBase64) {
			return { error: "没有可分析的视频链接" };
		}
		const body = JSON.stringify(
			buildVideoRequestBody(
				model,
				VIDEO_ANALYSIS_PROMPT,
				videoUrl,
				audioBase64,
				videoBase64,
			),
		);
		const url = `${(baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			// Explicit Content-Length (see analyzeImages: chunked encoding breaks
			// simple model servers).
			"Content-Length": String(Buffer.byteLength(body, "utf8")),
		};
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}
		const res = await httpsPostJson(url, headers, body);
		if (res.status < 200 || res.status >= 300) {
			return { error: `HTTP ${res.status}：${res.text.slice(0, 200)}` };
		}
		const parsedChat = parseChatCompletion(res.text);
		if ("error" in parsedChat) {
			return parsedChat;
		}
		const { text, keyMoments, fallback } = parseVideoKeyMoments(parsedChat.text);
		if (keyMoments.length > 0) {
			return { text, keyMoments };
		}
		return fallback && fallback.length > 0 ? { text, fallback } : { text };
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------------------------------------------------------------------------
// Key-frame extraction (ffmpeg)
// ---------------------------------------------------------------------------

/** Minimal adapter surface for key-frame writes (subset of DataAdapter). */
export interface KeyFramesVaultAdapter {
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	exists(path: string): Promise<boolean>;
}

let ffmpegAvailableCache: boolean | null = null;

/** Reset the cached ffmpeg probe (test hook). */
export function resetFfmpegProbe(): void {
	ffmpegAvailableCache = null;
}

/**
 * One-shot ffmpeg availability probe (`where`/`which`), cached for the
 * session. Never throws.
 */
export function isFfmpegAvailable(): boolean {
	if (ffmpegAvailableCache !== null) {
		return ffmpegAvailableCache;
	}
	try {
		const req = (window as unknown as { require?: (m: string) => unknown })
			.require;
		const cp = req?.("child_process") as typeof import("child_process") | undefined;
		if (!cp) {
			ffmpegAvailableCache = false;
			return false;
		}
		const cmd = process.platform === "win32" ? "where" : "which";
		const r = cp.spawnSync(cmd, ["ffmpeg"], { windowsHide: true });
		ffmpegAvailableCache = r.status === 0;
	} catch {
		ffmpegAvailableCache = false;
	}
	return ffmpegAvailableCache;
}

function nodeRequire(): {
	fs: typeof import("fs");
	os: typeof import("os");
	cp: typeof import("child_process");
} | null {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown })
			.require;
		const fs = req?.("fs") as typeof import("fs") | undefined;
		const os = req?.("os") as typeof import("os") | undefined;
		const cp = req?.("child_process") as
			| typeof import("child_process")
			| undefined;
		if (!fs || !os || !cp) {
			return null;
		}
		return { fs, os, cp };
	} catch {
		return null;
	}
}

/** Run one ffmpeg frame extraction (60s timeout). Never throws. */
function ffmpegExtractFrame(
	cp: typeof import("child_process"),
	videoUrl: string,
	atSeconds: number,
	outPath: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean): void => {
			if (!settled) {
				settled = true;
				resolve(ok);
			}
		};
		try {
			// Argument-ARRAY spawn (no shell): URL / paths can never be
			// interpreted as shell syntax.
			const child = cp.spawn(
				"ffmpeg",
				[
					"-ss",
					String(atSeconds),
					"-i",
					videoUrl,
					"-frames:v",
					"1",
					"-q:v",
					"3",
					"-y",
					outPath,
				],
				{ windowsHide: true },
			);
			const timer = setTimeout(() => {
				child.kill();
				done(false);
			}, 60_000);
			child.on("error", () => {
				clearTimeout(timer);
				done(false);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				done(code === 0);
			});
		} catch {
			done(false);
		}
	});
}

/** Max audio payload handed to the model API (guard against RAM / request
 * body blowups on very long videos): 20MB of mp3 bytes. */
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Extract a video's audio track as base64 mp3 via ffmpeg, streaming to stdout
 * (`ffmpeg -i {url} -vn -acodec libmp3lame -q:a 5 -f mp3 pipe:1`): no temp
 * file is written. 60s timeout, argument-array spawn (no shell). Returns null
 * on any failure (ffmpeg unavailable, non-zero exit, timeout, over-size
 * payload) and reports the reason via `log` — callers then fall back to
 * video-only analysis. NEVER throws.
 */
export async function extractAudioBase64(
	videoUrl: string,
	log?: (line: string) => void,
): Promise<string | null> {
	if (!videoUrl) {
		return null;
	}
	if (!isFfmpegAvailable()) {
		log?.("音轨抽取：ffmpeg 不可用，跳过（仅视频通道）");
		return null;
	}
	const mods = nodeRequire();
	if (!mods) {
		log?.("音轨抽取：Node child_process 模块不可用，跳过（仅视频通道）");
		return null;
	}
	try {
		const buf = await new Promise<Buffer | null>((resolve) => {
			let settled = false;
			const done = (b: Buffer | null): void => {
				if (!settled) {
					settled = true;
					resolve(b);
				}
			};
			const child = mods.cp.spawn(
				"ffmpeg",
				[
					"-i",
					videoUrl,
					"-vn",
					"-acodec",
					"libmp3lame",
					"-q:a",
					"5",
					"-f",
					"mp3",
					"pipe:1",
				],
				{ windowsHide: true },
			);
			const chunks: Buffer[] = [];
			let total = 0;
			const timer = setTimeout(() => {
				child.kill();
				done(null);
			}, 60_000);
			child.stdout?.on("data", (c: Buffer) => {
				total += c.length;
				if (total > AUDIO_MAX_BYTES) {
					child.kill();
					return;
				}
				chunks.push(c);
			});
			child.on("error", () => {
				clearTimeout(timer);
				done(null);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (total > AUDIO_MAX_BYTES) {
					log?.(
						`音轨抽取：音频超过 ${AUDIO_MAX_BYTES} 字节上限，放弃（仅视频通道）`,
					);
					done(null);
					return;
				}
				done(code === 0 && total > 0 ? Buffer.concat(chunks) : null);
			});
		});
		if (!buf) {
			log?.("音轨抽取：ffmpeg 未能提取音轨（仅视频通道）");
			return null;
		}
		return buf.toString("base64");
	} catch (e) {
		log?.(
			`音轨抽取失败（仅视频通道）：${e instanceof Error ? e.message : String(e)}`,
		);
		return null;
	}
}

/**
 * Extract the AI-suggested key frames of a video into the vault media folder:
 * per moment t, `ffmpeg -ss {t} -i {videoUrl} -frames:v 1 -q:v 3 {tmp}` (the
 * -ss BEFORE -i = stream seek, only the needed range is downloaded), the temp
 * file is then written via the adapter to
 * `{mediaFolder}/{noteId}/kf-{i}-{t}s.jpg` (vault-relative, 1-based i).
 * Skips moments whose target file already exists (idempotent re-runs); a
 * failed frame never aborts the rest. When ffmpeg is unavailable (or key
 * moments are empty) nothing is extracted — the caller then writes no
 * 关键帧 section. NEVER throws; per-frame failures are reported via `log`.
 */
export async function extractKeyFrames(
	videoUrl: string,
	noteId: string,
	mediaFolder: string,
	keyMoments: readonly VideoKeyMoment[],
	adapter: KeyFramesVaultAdapter,
	log?: (line: string) => void,
): Promise<{ ffmpeg: boolean; frames: VideoKeyMoment[] }> {
	if (!keyMoments || keyMoments.length === 0 || !videoUrl) {
		return { ffmpeg: isFfmpegAvailable(), frames: [] };
	}
	if (!isFfmpegAvailable()) {
		log?.("关键帧抽取：ffmpeg 不可用，跳过");
		return { ffmpeg: false, frames: [] };
	}
	const mods = nodeRequire();
	if (!mods) {
		log?.("关键帧抽取：Node fs/os/child_process 模块不可用，跳过");
		return { ffmpeg: true, frames: [] };
	}
	const { fs, os, cp } = mods;
	const cleanFolder = (mediaFolder ?? "").replace(/^\/+|\/+$/g, "");
	const frames: VideoKeyMoment[] = [];
	const sep = process.platform === "win32" ? "\\" : "/";
	const tmpDir = os.tmpdir();
	for (let i = 0; i < keyMoments.length; i++) {
		const km = keyMoments[i];
		if (!km || !Number.isFinite(km.t)) {
			continue;
		}
		const target = `${cleanFolder}/${noteId}/kf-${i + 1}-${km.t}s.jpg`;
		try {
			if (await adapter.exists(target)) {
				frames.push(km);
				log?.(`关键帧抽取：已存在，跳过 ${target}`);
				continue;
			}
			const tmpOut = `${tmpDir}${sep}kf-${noteId}-${i + 1}-${km.t}s.jpg`;
			const ok = await ffmpegExtractFrame(cp, videoUrl, km.t, tmpOut);
			if (!ok) {
				log?.(`关键帧抽取：ffmpeg 失败（t=${km.t}s），跳过该帧`);
				continue;
			}
			const buf = fs.readFileSync(tmpOut);
			await adapter.writeBinary(
				target,
				buf.buffer.slice(
					buf.byteOffset,
					buf.byteOffset + buf.byteLength,
				) as ArrayBuffer,
			);
			try {
				fs.unlinkSync(tmpOut);
			} catch {
				/* temp cleanup is best-effort */
			}
			frames.push(km);
			log?.(`关键帧抽取：已写入 ${target}`);
		} catch (e) {
			log?.(
				`关键帧抽取：单帧失败（t=${km.t}s，继续）：${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	return { ffmpeg: true, frames };
}
