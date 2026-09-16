// Side-effect module: media (images / video) downloading into the vault (M3).
//
// Network: plain Node https first (same proven transport as api.ts's
// nodeHttpsJson), falling back to a spawned curl (--noproxy "*" — the same
// fallback the signed API requests use when the in-process stack is blocked).
// Headers carry the reference EDGE_UA + Referer https://www.xiaohongshu.com/
// because the XHS image CDN may check both.
//
// Writes go through the Obsidian DataAdapter (adapter.writeBinary) — disk
// truth, index-independent, exactly like sync.ts's adapter.write.
//
// The pure helpers (extension inference, target naming) are exported for unit
// tests; this module imports NOTHING from obsidian at runtime (`import type`
// is erased), so tests can import it safely.

import type { DataAdapter } from "obsidian";

/** UA for CDN downloads — same value as api.ts's EDGE_UA (kept in wire.ts). */
import { EDGE_UA } from "./wire";

/** Headers every media download carries (CDN may validate UA/Referer). */
const MEDIA_HEADERS: Record<string, string> = {
	"User-Agent": EDGE_UA,
	"Referer": "https://www.xiaohongshu.com/",
};

/** Hard cap per downloaded file (protects against runaway video buffers). */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Find an already-stored media file for the seq-th image: any `"{seq}.{ext}"`
 * name in the note's media dir qualifies, whatever the extension is. This is
 * what makes extension-less CDN URLs idempotent: a previous run may have
 * stored the file under a Content-Type-refined name (e.g. `2.jpg` for a URL
 * whose provisional inference said `.webp`) — the seq match reuses it without
 * a new download. Pure; unit-tested.
 *
 * @param names Basenames of the files in the note's media dir.
 * @param seq   1-based image position.
 */
export function findExistingMediaName(names: Iterable<string>, seq: number): string | null {
	const prefix = `${seq}.`;
	for (const n of names) {
		if (typeof n === "string" && n.startsWith(prefix)) {
			const ext = n.slice(prefix.length);
			// Bounded alphanumeric extension guard — "{seq}." + short ext only.
			if (/^[A-Za-z0-9]{1,8}$/.test(ext)) {
				return n;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Extensions recognized from a URL path / a Content-Type header. */
const URL_EXTS = ["webp", "jpg", "jpeg", "png", "gif", "avif", "bmp", "heic"];

const CONTENT_TYPE_EXT: Record<string, string> = {
	"image/webp": ".webp",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/avif": ".avif",
	"image/bmp": ".bmp",
	"image/heic": ".heic",
};

/**
 * Infer a download extension from the image URL.
 * Strips query/fragment, then the CDN resize suffix (`…!nd_dft_wlteh_webp_3` /
 * `…!nc_n_webp_mw_1` are style selectors, not extensions), then matches the
 * file extension. Returns "" when the URL carries no recognizable extension
 * (the caller then falls back to Content-Type, defaulting to .webp).
 */
export function extFromUrl(url: string): string {
	try {
		const clean = (url ?? "").split("?")[0]?.split("#")[0] ?? "";
		const lastSeg = clean.slice(clean.lastIndexOf("/") + 1);
		const base = lastSeg.split("!")[0] ?? "";
		const dot = base.lastIndexOf(".");
		if (dot < 0) {
			return "";
		}
		const ext = base.slice(dot + 1).toLowerCase();
		return URL_EXTS.includes(ext) ? `.${ext}` : "";
	} catch {
		return "";
	}
}

/** Map a Content-Type header to an extension ("" when unknown). */
export function extFromContentType(contentType: string | undefined): string {
	if (!contentType) {
		return "";
	}
	const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return CONTENT_TYPE_EXT[mime] ?? "";
}

/**
 * Final extension for an image: URL extension first; when the URL has none,
 * the response Content-Type; otherwise the .webp default (M3 contract).
 */
export function resolveImageExtension(url: string, contentType?: string): string {
	return extFromUrl(url) || extFromContentType(contentType) || ".webp";
}

/** Media file name for the i-th image (1-based, per image_list order). */
export function imageFileName(seq: number, ext: string): string {
	return `${seq}${ext || ".webp"}`;
}

/** Video file name under the note's media dir (fixed, M3 contract). */
export const VIDEO_FILE_NAME = "video.mp4";

/** Strip leading/trailing slashes from a vault path fragment. */
function cleanPathFragment(p: string): string {
	return (p ?? "").replace(/^\/+|\/+$/g, "");
}

/**
 * Vault-relative media dir for one note: `{mediaFolder}/{note_id}`.
 */
export function mediaDirFor(mediaFolder: string, noteId: string): string {
	const folder = cleanPathFragment(mediaFolder);
	const id = cleanPathFragment(noteId);
	return folder ? (id ? `${folder}/${id}` : folder) : id;
}

/** Full vault-relative path of a media file under a note's media dir. */
export function noteMediaPath(mediaFolder: string, noteId: string, fileName: string): string {
	const dir = mediaDirFor(mediaFolder, noteId);
	return dir ? `${dir}/${fileName}` : fileName;
}

// ---------------------------------------------------------------------------
// Side-effect helpers (network + adapter writes)
// ---------------------------------------------------------------------------

export interface DownloadResult {
	ok: boolean;
	/** HTTP status (0/-1 on transport failure); 200 on success. */
	status: number;
	data?: Buffer;
	contentType?: string;
	/** Which transport produced the result. */
	via: "https" | "curl" | "none";
	error?: string;
}

/** Node Buffer -> plain ArrayBuffer (adapter.writeBinary takes ArrayBuffer). */
function toArrayBuffer(b: Buffer): ArrayBuffer {
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function nodeHttps(): typeof import("https") | null {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		return (req?.("https") as typeof import("https") | undefined) ?? null;
	} catch {
		return null;
	}
}

interface ChildProcess {
	execFile?: (
		cmd: string,
		args: string[],
		opts: unknown,
		cb: (err: unknown, stdout: Buffer) => void,
	) => unknown;
}

function childProcess(): ChildProcess | null {
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		return (req?.("child_process") as ChildProcess | undefined) ?? null;
	} catch {
		return null;
	}
}

/** Same marker protocol as api.ts's curlTransport, but binary-safe. */
const CURL_STATUS_MARKER = "\n__PULLHTTP__";

/**
 * Plain Node HTTPS GET collecting the body as a Buffer. Fresh per-request
 * agent: never inherits any env/global proxy of the host process.
 *
 * Settle discipline (M3 review fix): the promise settles EXACTLY once, via
 * the `settled` guard. The size-overflow branch settles BEFORE destroying the
 * request (destroy() alone may fire no further event, which previously left
 * the promise — and the whole sync — hanging); res "close"/"aborted" are a
 * last-resort settle for streams that end without "end"/"error".
 * `maxBytes` is injectable so tests can exercise the overflow path cheaply.
 */
export function httpsGet(
	url: string,
	timeoutMs: number,
	maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<DownloadResult> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (r: DownloadResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(r);
		};
		const https = nodeHttps();
		if (!https) {
			settle({ ok: false, status: 0, via: "https", error: "Node https 模块不可用" });
			return;
		}
		try {
			const u = new URL(url);
			const req = https.request(
				{
					hostname: u.hostname,
					path: u.pathname + u.search,
					method: "GET",
					headers: MEDIA_HEADERS,
					timeout: timeoutMs,
					agent: false,
				},
				(res) => {
					const status = res.statusCode ?? 0;
					const contentType = res.headers["content-type"];
					const chunks: Buffer[] = [];
					let total = 0;
					let overflow = false;
					res.on("data", (c: Buffer) => {
						if (overflow || settled) {
							return;
						}
						total += c.length;
						if (total > maxBytes) {
							overflow = true;
							// Settle FIRST (the overflow verdict is final), THEN tear
							// down — destroy() may emit nothing further.
							settle({
								ok: false,
								status,
								via: "https",
								error: `文件超过 ${maxBytes} 字节上限`,
							});
							try {
								req.destroy();
							} catch {
								/* teardown is best-effort; already settled */
							}
							return;
						}
						chunks.push(c);
					});
					res.on("end", () => {
						if (overflow) {
							return; // already settled by the overflow branch
						}
						settle({
							ok: status === 200,
							status,
							contentType,
							data: Buffer.concat(chunks),
							via: "https",
							error: status === 200 ? undefined : `HTTP ${status}`,
						});
					});
					res.on("error", (e: Error) => {
						if (overflow) {
							return; // already settled by the overflow branch
						}
						settle({ ok: false, status, via: "https", error: e.message });
					});
					// Last-resort settle: a stream that dies without "end"/"error"
					// (destroyed mid-body, socket aborted) must not hang the sync.
					const onDead = (): void => {
						if (overflow) {
							return;
						}
						settle({ ok: false, status, via: "https", error: "连接提前关闭" });
					};
					res.on("close", onDead);
					res.on("aborted", onDead);
				},
			);
			req.on("error", (e: Error) => {
				settle({ ok: false, status: 0, via: "https", error: e.message });
			});
			req.on("timeout", () => {
				try {
					req.destroy();
				} catch {
					/* already settled below regardless */
				}
				settle({ ok: false, status: 0, via: "https", error: `请求超时（${timeoutMs / 1000}s）` });
			});
			req.end();
		} catch (e) {
			settle({
				ok: false,
				status: 0,
				via: "https",
				error: e instanceof Error ? e.message : String(e),
			});
		}
	});
}

/**
 * Spawned-curl fallback (binary-safe: execFile with encoding "buffer", status
 * appended by -w and split off the tail of stdout). --noproxy "*" mirrors
 * api.ts's curlTransport so env proxies never hijack the request.
 */
function curlGet(url: string, timeoutSec: number): Promise<DownloadResult> {
	return new Promise((resolve) => {
		const cp = childProcess();
		if (!cp?.execFile) {
			resolve({ ok: false, status: 0, via: "curl", error: "child_process 不可用" });
			return;
		}
		const args = [
			"-s",
			"-o",
			"-",
			"-w",
			CURL_STATUS_MARKER + "%{http_code}",
			"--max-time",
			String(timeoutSec),
			"--noproxy",
			"*",
			url,
		];
		for (const [k, v] of Object.entries(MEDIA_HEADERS)) {
			args.push("-H", `${k}: ${v}`);
		}
		cp.execFile(
			"curl",
			args,
			{
				timeout: (timeoutSec + 10) * 1000,
				maxBuffer: MAX_DOWNLOAD_BYTES,
				encoding: "buffer",
			},
			(err: unknown, stdout: Buffer) => {
				if (err) {
					resolve({ ok: false, status: 0, via: "curl", error: `exec err: ${String(err).slice(0, 120)}` });
					return;
				}
				const marker = Buffer.from(CURL_STATUS_MARKER, "utf8");
				const cut = stdout.lastIndexOf(marker);
				if (cut < 0) {
					resolve({ ok: false, status: 0, via: "curl", error: "curl 无状态输出" });
					return;
				}
				const status = Number(stdout.slice(cut + marker.length).toString("utf8").trim());
				const body = stdout.slice(0, cut);
				resolve({
					ok: status === 200,
					status,
					data: body,
					via: "curl",
					error: status === 200 ? undefined : `HTTP ${status}`,
				});
			},
		);
	});
}

/**
 * Download one media URL: Node https first; on any failure (including 406 /
 * expired-token 403 / network error) retry once via spawned curl.
 */
export async function downloadMedia(
	url: string,
	log: (line: string) => void,
	timeoutMs = 30_000,
): Promise<DownloadResult> {
	const short = url.slice(0, 90);
	let r = await httpsGet(url, timeoutMs);
	if (r.ok) {
		log(`媒体下载 OK（https）HTTP ${r.status} ${short}`);
		return r;
	}
	log(`媒体下载 https 失败（${r.error ?? r.status}），curl 兜底：${short}`);
	r = await curlGet(url, Math.max(30, Math.round(timeoutMs / 1000)));
	if (r.ok) {
		log(`媒体下载 OK（curl 兜底）HTTP ${r.status} ${short}`);
		return r;
	}
	log(`媒体下载失败（https+curl 均失败，状态 ${r.status}）：${r.error ?? ""} ${short}`);
	return r;
}

// ---------------------------------------------------------------------------
// Per-note media sync orchestration
// ---------------------------------------------------------------------------

export interface NoteMediaPlan {
	/** Vault-relative media root, e.g. "RedNote/Media". */
	mediaFolder: string;
	noteId: string;
	/** Image CDN URLs in image_list order. */
	imageUrls: string[];
	/** Video master URL (video notes only). */
	videoUrl: string;
	/** Video download toggle (default off; off = never touched). */
	downloadVideos: boolean;
}

export interface NoteMediaResult {
	/** Local vault-relative path per image (null = download failed, keep remote URL). */
	imageLocal: (string | null)[];
	/** Local video path, or null (not downloaded / failed / toggle off). */
	videoLocal: string | null;
	downloaded: number;
	skippedExisting: number;
	failed: number;
}

/** Ensure the note's media dir (and parents) exists via the adapter. */
async function ensureMediaDir(adapter: DataAdapter, dir: string): Promise<void> {
	if (!dir || dir === "/") {
		return;
	}
	const parts = dir.split("/").filter((p) => p.length > 0);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) {
			await adapter.mkdir(current);
		}
	}
}

/**
 * Download one note's media per the M3 contract:
 *  - images -> `{mediaFolder}/{note_id}/1.ext, 2.ext, …` (image_list order);
 *    existing files are skipped (gap-fill on rewrites, never re-downloaded);
 *    a single failed image never aborts the note (falls back to remote URL).
 *  - video  -> only when `downloadVideos` is on; `{mediaFolder}/{note_id}/video.mp4`.
 */
export async function syncNoteMedia(
	plan: NoteMediaPlan,
	adapter: DataAdapter,
	log: (line: string) => void,
): Promise<NoteMediaResult> {
	const result: NoteMediaResult = {
		imageLocal: [],
		videoLocal: null,
		downloaded: 0,
		skippedExisting: 0,
		failed: 0,
	};
	const dir = mediaDirFor(plan.mediaFolder, plan.noteId);
	if ((plan.imageUrls.length > 0 || (plan.downloadVideos && plan.videoUrl)) && dir) {
		try {
			await ensureMediaDir(adapter, dir);
		} catch (e) {
			log(`媒体目录创建失败（${dir}）：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// List the note's media dir ONCE (M3 review fix): any existing
	// `"{seq}.{ext}"` file reuses its seq slot without a network request —
	// this makes extension-less CDN URLs idempotent across runs (the stored
	// name may carry a Content-Type-refined extension that this run's
	// URL-based inference cannot predict). When the listing fails, fall back
	// to the per-path exists() probe as before.
	let dirFileNames: Set<string> | null = null;
	if (dir) {
		try {
			const listed = await adapter.list(dir);
			dirFileNames = new Set(
				(listed.files ?? []).map((f) => f.slice(f.lastIndexOf("/") + 1)),
			);
		} catch (e) {
			log(`媒体目录列举失败，退回逐路径探测：${e instanceof Error ? e.message : String(e)}`);
			dirFileNames = null;
		}
	}

	// Images, numbered 1..n in image_list order.
	for (let i = 0; i < plan.imageUrls.length; i++) {
		const url = plan.imageUrls[i];
		const seq = i + 1;
		let local: string | null = null;
		if (!url) {
			result.imageLocal.push(null);
			continue;
		}
		try {
			// Seq-slot reuse (see dirFileNames above) — no request is made when
			// any `N.<ext>` file already exists for this image position.
			const existingName = dirFileNames ? findExistingMediaName(dirFileNames, seq) : null;
			if (existingName && dir) {
				local = `${dir}/${existingName}`;
				result.skippedExisting += 1;
				log(`媒体已存在，跳过下载：${local}`);
				result.imageLocal.push(local);
				continue;
			}
			// Provisional target from the URL alone; without a dir listing the
			// existence check must run before any network traffic so gap-fill
			// skips stay free.
			let ext = resolveImageExtension(url);
			let target = noteMediaPath(plan.mediaFolder, plan.noteId, imageFileName(seq, ext));
			if (!dirFileNames && dir && (await adapter.exists(target))) {
				result.skippedExisting += 1;
				log(`媒体已存在，跳过下载：${target}`);
				local = target;
			} else {
				const dl = await downloadMedia(url, log);
				if (dl.ok && dl.data) {
					// Refine the extension when the URL carried none.
					const refined = resolveImageExtension(url, dl.contentType);
					if (refined !== ext) {
						ext = refined;
						target = noteMediaPath(plan.mediaFolder, plan.noteId, imageFileName(seq, ext));
						// With a listing we already know no `seq.*` file exists, so
						// the refined name cannot collide; re-probe only in the
						// degraded (no-listing) fallback.
						if (!dirFileNames && dir && (await adapter.exists(target))) {
							result.skippedExisting += 1;
							log(`媒体已存在，跳过下载：${target}`);
							local = target;
							continue;
						}
					}
					await adapter.writeBinary(target, toArrayBuffer(dl.data));
					result.downloaded += 1;
					local = target;
					log(`媒体已写入：${target}（${dl.data.length} 字节，经 ${dl.via}）`);
				} else {
					result.failed += 1;
					// REQ-style trace is already emitted by downloadMedia.
				}
			}
		} catch (e) {
			result.failed += 1;
			log(
				`媒体处理异常（不中断整篇）：${e instanceof Error ? e.message : String(e)}`,
			);
		}
		result.imageLocal.push(local);
	}

	// Video: only when the toggle is ON (off = current behavior, link only).
	if (plan.downloadVideos && plan.videoUrl) {
		try {
			const target = noteMediaPath(plan.mediaFolder, plan.noteId, VIDEO_FILE_NAME);
			if (dir && (await adapter.exists(target))) {
				result.skippedExisting += 1;
				result.videoLocal = target;
				log(`视频已存在，跳过下载：${target}`);
			} else {
				// Videos are large: extend the transport timeouts.
				const dl = await downloadMedia(plan.videoUrl, log, 120_000);
				if (dl.ok && dl.data) {
					await adapter.writeBinary(target, toArrayBuffer(dl.data));
					result.downloaded += 1;
					result.videoLocal = target;
					log(`视频已写入：${target}（${dl.data.length} 字节，经 ${dl.via}）`);
				} else {
					result.failed += 1;
				}
			}
		} catch (e) {
			result.failed += 1;
			log(`视频处理异常（不中断整篇）：${e instanceof Error ? e.message : String(e)}`);
		}
	}

	return result;
}
