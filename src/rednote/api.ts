// Side-effect module: embedded webview session + signed XHS API client.
//
// Data path (supersedes ADR-007's in-webview fetch, mirroring the verified
// reference implementation ytf606/xhs2obsidian sign-manager): requests are
// issued from the PLUGIN PROCESS via obsidian requestUrl with
//   - Cookie       : extracted from the persist:rednote-sync partition
//                    (Electron remote session; includes HttpOnly cookies),
//   - signatures   : computed locally (sign.ts, xhshow-lineage XYS_ format),
//   - x-rap-param  : captured from the webview page by installPageRecorder's
//                    interceptor + homefeed warmup (optional header; requests
//                    go out without it when capture fails).
// The webview stays resident for login + page probes + rap-param capture, but
// data requests no longer execute inside the page context.
//
// Verified against (2026-09-14):
//  - MediaCrawler (NanmiCoder/MediaCrawler) media_platform/xhs/{client,core,help,login}.py
//  - ReaJason/xhs (the library MediaCrawler's xhs module builds on) xhs/core.py
//    * favorites list : GET  /api/sns/web/v2/note/collect/page  {cursor,num,user_id,image_formats}
//    * note detail    : POST /api/sns/web/v1/feed               -> items[0].note_card
//    * login check    : GET  /api/sns/web/v2/user/me (Cookie-only) -> data.userInfo.user_id
//    * host           : edith.xiaohongshu.com
//
// This file imports obsidian; keep it OUT of unit tests (the request-shape
// helpers live in ./wire.ts, which the tests cover directly).

import { requestUrl } from "obsidian";

import {
	NotLoggedInError,
	SignError,
	type RedNoteRaw,
	type RedNoteSign,
} from "./types";
import { parseListPage, shouldContinue, type RawListData } from "./pagination";
import { mergeNoteCard } from "./extract";
// xhsSignXyw = CURRENT XYW_ (AES-128-CBC) X-S format. The legacy XYS_ variant
// (xhsSign) stays in sign.ts as a backup path — since ~2026-03 data-fetching
// APIs reject XYS_ with {success:false}.
import { xhsSign, xhsSignXyw, generateB1 } from "./sign";
import { signRequest } from "./sign-ref";
import {
	buildCollectPageParams,
	buildGetQueryString,
	extractCookieValue,
	isXhsHost,
	joinCookies,
	newXrayTraceid,
} from "./wire";

/** The partition isolates this session from Obsidian's default browser session. */
const WEBVIEW_PARTITION = "persist:rednote-sync-v2"; // v2: fresh identity — the v1 partition's a1 got server-flagged after 2 days of debug traffic
/**
 * Chrome UA matching the user's real local Chrome build. With the clean-
 * partition IPC swallow (see initCleanPartition) this attribute WORKS: the
 * sec-fetch-dest / sec-ch-ua headers survive and XHS no longer 406s the
 * requests (Obsidian's per-partition webRequest hook deletes those headers
 * and rewrites the UA — the root cause of the permanent HTTP 406s).
 */
const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/153.0.0.0 Safari/537.36";

/**
 * UA for plugin-process (requestUrl) data requests — the reference
 * implementation's Edge 142 UA, copied verbatim.
 */
const EDGE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";

/**
 * Keep our webview partition FREE of Obsidian's per-partition webRequest hooks.
 *
 * Community finding (Bryan Monge, forum thread 117394; engineered by the
 * webview-ua-override plugin): Obsidian's main process installs a
 * session.webRequest.onBeforeSendHeaders hook on every partition named by a
 * "create-browser-session" IPC message; that hook DELETES sec-fetch-dest /
 * sec-ch-ua and rewrites the UA — XHS responds HTTP 406 to such requests,
 * permanently (observed: a fresh session got 200 early, then 406 forever
 * after the hook landed, while plain Chrome on the same IP kept working).
 *
 * A partition the IPC never names never gets the hook. So we swallow the
 * create-browser-session message for OUR partition before any webview exists.
 * Must run before the first ensureWebviewElement() (called from the
 * RedNoteSession constructor).
 */
export const cleanPartitionStatus = { value: "未执行" };

export function initCleanPartition(log?: (line: string) => void): void {
	cleanPartitionStatus.value = "执行中";
	try {
		const req = (window as unknown as { require?: (m: string) => unknown }).require;
		const electron = req?.("electron") as
			| { ipcRenderer?: { send?: (channel: string, ...args: unknown[]) => void } }
			| undefined;
		const ipc = electron?.ipcRenderer;
		const origSend = ipc?.send?.bind(ipc);
		if (!ipc || !origSend || (ipc as unknown as { __pullRednotePatched?: boolean }).__pullRednotePatched) {
			cleanPartitionStatus.value = "跳过（ipcRenderer.send 不可用或已包装过）";
			return;
		}
		(ipc as unknown as { __pullRednotePatched?: boolean }).__pullRednotePatched = true;
		ipc.send = (channel: string, ...args: unknown[]): void => {
			try {
				if (
					channel === "create-browser-session" &&
					JSON.stringify(args).includes(WEBVIEW_PARTITION)
				) {
					cleanPartitionStatus.value = "已拦截 create-browser-session（钩子未安装）";
					log?.("已拦截 create-browser-session：分区保持无钩子（sec-* 头不再被删）");
					return;
				}
			} catch {
				/* fall through to the original send */
			}
			origSend(channel, ...args);
		};
		cleanPartitionStatus.value = "已包装 ipcRenderer.send（等待 create-browser-session）";
		log?.("initCleanPartition：ipcRenderer.send 已包装");
	} catch (e) {
		cleanPartitionStatus.value = `失败：${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`;
		log?.(`initCleanPartition 失败（钩子可能仍会安装）：${e instanceof Error ? e.message : String(e)}`);
	}
}

const HOST = "https://edith.xiaohongshu.com";
const INDEX_URL = "https://www.xiaohongshu.com/explore"; // explore: page-load fires a signed homefeed POST (carries x-rap-param for capture) — same landing as the reference plugin

/** A <webview> element — not typed in the bundled obsidian d.ts, so a minimal cast. */
type WebviewEl = HTMLElement & {
	executeJavaScript?: (code: string) => Promise<unknown>;
	setZoomFactor?: (factor: number) => void;
	reload?: () => void;
};

/**
 * Webview navigation-sandbox predicate — pure logic now lives in ./wire.ts
 * (re-exported here so existing importers of api.ts keep working).
 */
export { isXhsHost } from "./wire";

/**
 * Spawned-curl transport (last-resort fallback when in-process Node https is
 * 406-d by the server): the same request via a spawned curl process was
 * verified to return 200 repeatedly — the blocker discriminates something
 * about the in-process network stack, not the request itself.
 */
function curlTransport(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: string,
): Promise<{ status: number; text: string; serverHeaders: string }> {
	return new Promise((resolve) => {
		try {
			const reqquire = (window as unknown as { require?: (m: string) => unknown }).require;
			const cp = reqquire?.("child_process") as
				| { execFile?: (cmd: string, args: string[], opts: unknown, cb: (err: unknown, stdout: string) => void) => unknown }
				| undefined;
			if (!cp?.execFile) {
				resolve({ status: -1, text: "", serverHeaders: "child_process 不可用" });
				return;
			}
			const args = [
				"-s",
				"-o",
				"-",
				"-w",
				"\n__PULLHTTP__%{http_code}",
				"--max-time",
				"20",
				// Force-direct: the parent (Obsidian) process carries proxy env
				// vars that a spawned curl would otherwise HONOR — the same
				// curl binary returns 200 standalone (no env) and 406 when
				// spawned from Obsidian. --noproxy makes env proxies moot.
				"--noproxy",
				"*",
				"-X",
				method,
				url,
			];
			for (const [k, v] of Object.entries(headers)) {
				args.push("-H", `${k}: ${v}`);
			}
			if (body) {
				args.push("-d", body);
			}
			cp.execFile(
				"curl",
				args,
				{ timeout: 30_000, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
				(err: unknown, stdout: string) => {
					if (err) {
						resolve({ status: -1, text: "", serverHeaders: `exec err: ${String(err).slice(0, 80)}` });
						return;
					}
					const m = stdout.match(/__PULLHTTP__(\d+)/);
					const status = m ? Number(m[1]) : -1;
					const text = stdout.split("\n__PULLHTTP__")[0] ?? "";
					resolve({ status, text, serverHeaders: "" });
				},
			);
		} catch (e) {
			resolve({ status: -1, text: "", serverHeaders: String(e).slice(0, 80) });
		}
	});
}

/**
 * Plain Node HTTPS JSON request (desktop plugin has Node access). Replaces
 * obsidian requestUrl as the API transport: standalone probing proved the
 * identical header set + signature gets 200 via a plain HTTPS client while
 * requestUrl gets 406 (it stamps its own request identity).
 */
function nodeHttpsJson(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: string,
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		try {
			const reqquire = (window as unknown as { require?: (m: string) => unknown }).require;
			const https = reqquire?.("https") as typeof import("https") | undefined;
			if (!https) {
				reject(new Error("Node https 模块不可用"));
				return;
			}
			const u = new URL(url);
			const req = https.request(
				{
					hostname: u.hostname,
					path: u.pathname + u.search,
					method,
					headers,
					timeout: 20_000,
					// Fresh per-request agent: never inherit any env/global
					// proxy agent the host process may have configured.
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
				reject(new Error("请求超时（20s）"));
			});
			if (body) {
				req.write(body);
			}
			req.end();
		} catch (e) {
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

/**
 * Extract the target URL from a webview navigation event's `detail`.
 * Returns undefined when no URL is present (e.g. a bare Event), in which case
 * the caller treats it as "not off-domain" and does nothing.
 */
function navEventUrl(e: Event): string | undefined {
	const detail = (e as CustomEvent<unknown>).detail;
	if (detail && typeof detail === "object") {
		const url = (detail as { url?: unknown }).url;
		if (typeof url === "string") {
			return url;
		}
	}
	return undefined;
}

/** Thrown when a page request fails after one retry (non-login error). */
export class FetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FetchError";
	}
}

/**
 * Owns the resident webview, login state, and the signed data pipeline.
 *
 * The webview is created on first use and is NEVER removed from the DOM
 * (parked offscreen via position:fixed as a direct child of document.body).
 * Removing it would drop the session and require a re-login. `destroy()`
 * removes it only on plugin unload. The login modal borrows the container
 * temporarily and MUST re-parent it back to document.body in its onClose()
 * (see RedNoteLoginModal): Obsidian may detach the modal DOM after close,
 * and a webview left inside that subtree would be destroyed with it.
 */
export class RedNoteSession {
	private container: HTMLElement | null = null;
	private webview: WebviewEl | null = null;
	private readyPromise: Promise<void> | null = null;

	constructor() {
		// MUST happen before the first webview creation so our partition is
		// never named by create-browser-session (see initCleanPartition).
		initCleanPartition((line) => this.log(line));
	}

	/**
	 * Ensure a resident webview exists and is loaded with the XHS homepage.
	 * Idempotent: returns the existing (ready) webview if one is present.
	 *
	 * The webview is mounted in a container attached to `document` and kept
	 * alive (hidden offscreen) so the browser session (cookies + page JS)
	 * persists across sync runs.
	 */
	ensureWebview(): Promise<WebviewEl> {
		this.ensureWebviewElement();
		return this.readyPromise!.then(() => this.webview as WebviewEl);
	}

	/**
	 * Synchronously create and mount the resident webview if it does not exist
	 * yet, WITHOUT waiting for the page to load. The login modal needs this so
	 * it can show the (sized) webview box immediately instead of an empty white
	 * modal for as long as the XHS homepage takes to load (bounded by the 30s
	 * safety timeout below). `ensureWebview()` still awaits load readiness for
	 * the data pipeline.
	 */
	ensureWebviewElement(): WebviewEl {
		if (this.webview) {
			return this.webview;
		}
		// RECLAIM before creating: after a destroy/recreate cycle the login
		// leaf may still hold a LIVE webview of ours while this method would
		// create a SECOND one — the split (visible page vs. eval target) made
		// every check talk to the wrong page (observed: DOM webview×2).
		const existing = document.querySelector(
			`webview[partition="${WEBVIEW_PARTITION}"]`,
		) as WebviewEl | null;
		if (existing) {
			this.log("reclaim: adopting existing live webview from the document");
			this.webview = existing;
			this.container = existing.parentElement;
			// The reclaimed page is already loaded (best effort — a queued
			// executeJavaScript would wait for load anyway).
			this.readyPromise = Promise.resolve();
			return existing;
		}
		const el = document.createElement("webview") as WebviewEl;
		// CRITICAL (white-screen root cause): Electron's <webview> is ATTRIBUTE-
		// driven (attributeChangedCallback). Plain property assignment
		// (el.src = …, el.partition = …) is NOT reflected to attributes in this
		// Electron build, so the navigation never started and the webview stayed
		// on about:blank — the all-white login modal. Always use setAttribute.
		// ORDER (per the webview-ua-override write-up): useragent BEFORE
		// partition, both BEFORE attach/src — with the clean partition the
		// attribute now actually applies and XHS sees a genuine Chrome UA.
		el.setAttribute("useragent", CHROME_UA);
		el.setAttribute("partition", WEBVIEW_PARTITION);
		// NOTE: allowpopups is intentionally NOT set. Electron treats boolean
		// webview attributes by PRESENCE (any value, including "false", means
		// enabled), so setAttribute("allowpopups", "false") would have been
		// inverted. Absent = popups disabled, which is what we want.
		// The clean (unhooked) partition also skips Obsidian's session-level
		// permission sandbox — deny everything at the element level instead.
		el.addEventListener("permissionrequest", (e: Event) => {
			(e as Event & { preventDefault?: () => void }).preventDefault?.();
		});
		// Adaptive size: cap to the host window so the login page always fits
		// (small Obsidian windows used to crop the QR code area).
		el.style.width = "min(480px, 85vw)";
		el.style.height = "min(640px, 70vh)";
		el.style.display = "block";
		el.style.border = "none";

		const container = document.createElement("div");
		// CRITICAL (white-screen root cause): do NOT hide the container with
		// display:none. A <webview> created (and src'd) inside a display:none
		// subtree gets a 0x0 guest view that never re-lays-out after the
		// container is reparented into the login modal — the guest stays
		// unrendered and the modal shows an all-white box. Hide it offscreen
		// with position:fixed instead so the guest always has a real layout.
		container.style.position = "fixed";
		container.style.left = "-99999px";
		container.style.top = "0";
		container.style.width = "1200px";
		container.style.height = "800px";
		container.appendChild(el);
		document.body.appendChild(container);

		this.container = container;
		this.webview = el;

		// Load observability: surface the webview's loading lifecycle in the
		// developer console so a real-device white screen can be diagnosed
		// without guessing (start/stop, failure codes, guest console output).
		el.addEventListener("did-start-loading", () => {
			console.log("[pull-rednote] webview did-start-loading");
		});
		el.addEventListener("did-stop-loading", () => {
			console.log("[pull-rednote] webview did-stop-loading");
		});
		el.addEventListener("dom-ready", () => {
			console.log("[pull-rednote] webview dom-ready");
		});
		// Install the recorder + x-rap-param interceptor AFTER the full load —
		// dom-ready was TOO EARLY: XHS's signing wrapper patches window.fetch
		// during app hydration, and a warmup fired before that goes out
		// unsigned (no x-rap-param ever produced). did-finish-load means the
		// page (incl. its app JS) has loaded. Re-install is idempotent.
		el.addEventListener("did-finish-load", () => {
			void this.installPageRecorder();
		});
		el.addEventListener("did-fail-load", (e: Event) => {
			// Electron exposes these fields directly on the event; some builds
			// wrap them in detail — read both defensively.
			const ext = e as Event & {
				errorCode?: number;
				errorDescription?: string;
				validatedURL?: string;
				isMainFrame?: boolean;
				detail?: { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
			};
			const code = ext.errorCode ?? ext.detail?.errorCode;
			const desc = ext.errorDescription ?? ext.detail?.errorDescription;
			const url = ext.validatedURL ?? ext.detail?.validatedURL;
			const main = ext.isMainFrame ?? ext.detail?.isMainFrame;
			console.log(
				`[pull-rednote] webview did-fail-load code=${code} desc=${desc} url=${url} isMainFrame=${main}`,
			);
		});
		el.addEventListener("console-message", (e: Event) => {
			const ext = e as Event & {
				message?: string;
				lineNumber?: number;
				sourceId?: string;
				detail?: { message?: string; lineNumber?: number; sourceId?: string };
			};
			const msg = ext.message ?? ext.detail?.message;
			const line = ext.lineNumber ?? ext.detail?.lineNumber;
			const src = ext.sourceId ?? ext.detail?.sourceId;
			console.log(`[pull-rednote] webview console: ${msg} (${src ?? ""}:${line ?? ""})`);
		});

		// Navigation sandbox (see note below): keep the webview confined to XHS
		// domains. This is a best-effort hardening against open-redirect style
		// exfiltration of the logged-in session; it is NOT a security boundary
		// for the credentials themselves.

		// (1) Popup path — valid: new-window fires BEFORE the popup is created
		//     and CAN be cancelled with preventDefault. allowpopups=false adds a
		//     second layer that blocks window.open popups entirely.
		el.addEventListener("new-window", (e: Event) => {
			const url = navEventUrl(e);
			if (typeof url === "string" && !isXhsHost(url)) {
				(e as CustomEvent<unknown>).preventDefault?.();
			}
		});

		// (2) Main-frame same-window navigation. On Electron's <webview>,
		//     `will-navigate` is NOT a cancellable element event (that is a CDP /
		//     main-process callback) — the element fires `did-navigate` /
		//     `did-navigate-in-page` AFTER the navigation has already happened,
		//     and those cannot be cancelled. The practical mitigation is to
		//     detect an off-domain current URL and immediately load the XHS home
		//     page back, so any hijacked page is only briefly visible.
		//     (If a build does emit a cancellable will-navigate we still listen
		//     for it and preventDefault as a bonus — it never fires on the
		//     standard element, so it is harmless.)
		// Pull the frame back home ONLY on a deferred, rate-limited schedule,
		// and ONLY via setAttribute("src") — never loadURL(), which Surfing (the
		// community reference) avoids entirely, and never synchronously inside
		// a navigation event callback (Chromium CHECK / host 0x80000003 crash).
		let lastBackHome = 0;
		const forceBackHome = () => {
			const now = Date.now();
			if (now - lastBackHome < 1500) {
				return;
			}
			lastBackHome = now;
			window.setTimeout(() => {
				el.setAttribute("src", INDEX_URL);
			}, 250);
		};
		const watchNavigation = (name: string, cancellable: boolean) => {
			el.addEventListener(name, (e: Event) => {
				const url = navEventUrl(e);
				if (typeof url === "string" && !isXhsHost(url)) {
					if (cancellable) {
						(e as CustomEvent<unknown>).preventDefault?.();
						// Even if cancelled, re-assert home in case the nav
						// partially went through.
						forceBackHome();
					} else {
						forceBackHome();
					}
				}
			});
		};
		watchNavigation("will-navigate", true);
		watchNavigation("did-navigate", false);
		watchNavigation("did-navigate-in-page", false);

		// Surfing pattern, CONDITIONAL: if THIS element is destroyed, drop the
		// session refs so the next ensure* recreates. The guard matters: the
		// login view may swap in a NEWER element while an older one dies, and
		// an unconditional clear here used to null out the LIVE element's refs,
		// causing an endless destroy→recreate→swap loop (the page kept
		// reloading and the QR could never complete a scan).
		el.addEventListener("destroyed", () => {
			if (this.webview !== el) {
				return;
			}
			this.log("webview destroyed - will recreate on next use");
			console.log("[pull-rednote] webview destroyed - will recreate on next use");
			this.container = null;
			this.webview = null;
			this.readyPromise = null;
			// Fresh page -> let readRapParam() capture again (the warmup is
			// re-armed by installPageRecorder on the next page's dom-ready).
			this.rapParamCache = null;
		});

		this.readyPromise = new Promise<void>((resolve) => {
			el.addEventListener("did-finish-load", () => resolve(), { once: true });
			// A failed MAIN-frame load never reaches did-finish-load; resolve
			// anyway so callers fail fast with a clear sign/fetch error instead
			// of hanging for the full safety timeout. Subframe failures (ads,
			// trackers) must not resolve readiness.
			el.addEventListener("did-fail-load", (e: Event) => {
				const ext = e as Event & { isMainFrame?: boolean; detail?: { isMainFrame?: boolean } };
				const main = ext.isMainFrame ?? ext.detail?.isMainFrame;
				if (main !== false) {
					resolve();
				}
			});
			// Safety: resolve even if the event never fires (e.g. blocked nav),
			// after a bounded wait, so callers don't hang forever.
			window.setTimeout(() => resolve(), 30000);
		});

		// Attribute form (NOT el.src = …): property assignment is not reflected
		// to the webview's attributes and never triggers the navigation.
		el.setAttribute("src", INDEX_URL);
		return el;
	}

	/** The resident webview element (or null if never created). */
	getWebview(): WebviewEl | null {
		return this.webview;
	}

	/** Whether a webview is currently mounted and ready. */
	isAlive(): boolean {
		return this.webview !== null;
	}

	/**
	 * Remove the resident webview from the DOM. Called on plugin unload only.
	 * This intentionally destroys the session (next use requires re-login).
	 */
	destroy(): void {
		this.container?.remove();
		this.container = null;
		this.webview = null;
		this.readyPromise = null;
		this.rapParamCache = null;
	}

	/**
	 * Execute JS inside the webview page context and return the resolved value.
	 * Used to grab XHS's own signing output and to issue signed fetches.
	 */
	async eval<T = unknown>(code: string): Promise<T> {
		const wv = await this.ensureWebview();
		if (!wv.executeJavaScript) {
			throw new SignError("webview.executeJavaScript 不可用，无法在页面上下文执行请求");
		}
		return (await wv.executeJavaScript(code)) as T;
	}

	/**
	 * Full Cookie header value for edith.xiaohongshu.com requests.
	 *
	 * PRIMARY: the persist:rednote-sync partition's cookie store via Electron's
	 * remote session — includes HttpOnly cookies (web_session) that
	 * document.cookie can never see.
	 * FALLBACK (degraded, reason logged): document.cookie inside the webview —
	 * non-HttpOnly cookies only, so requests built from it may not authenticate.
	 * Returns "" when both paths fail.
	 */
	async getCookieString(): Promise<string> {
		try {
			const req = (window as unknown as { require?: (m: string) => unknown }).require;
			const electron = req?.("electron") as
				| {
						remote?: {
							session?: {
								fromPartition?: (partition: string) => {
									cookies: {
										get: (filter: { url: string }) => Promise<Array<{ name: string; value: string }>>;
									};
								};
							};
						};
				  }
				| undefined;
			const fromPartition = electron?.remote?.session?.fromPartition;
			if (!fromPartition) {
				this.log("getCookieString：electron.remote.session 不可用，降级 document.cookie");
			} else {
				const cookies = await fromPartition(WEBVIEW_PARTITION).cookies.get({
					url: "https://www.xiaohongshu.com",
				});
				if (Array.isArray(cookies) && cookies.length > 0) {
					const names = cookies.map((c) => String(c.name));
					this.log(
						`getCookieString：分区取得 ${cookies.length} 个 cookie，web_session=${names.includes("web_session") ? "有" : "无"}，a1=${names.includes("a1") ? "有" : "无"}`,
					);
					// TEMPORARY diagnostic dump (removed after the egress
					// experiment): lets the parent run a standalone Node probe
					// with the exact session cookies. debug.log is local-only.
					this.log(`COOKIE_DUMP:${joinCookies(cookies.map((c) => ({ name: String(c.name), value: String(c.value) })))}`);
					return joinCookies(
						cookies.map((c) => ({ name: String(c.name), value: String(c.value) })),
					);
				}
				this.log("getCookieString：分区 cookie 为空（未登录或读取被拒），降级 document.cookie");
			}
		} catch (e) {
			this.log(
				`getCookieString：分区 cookie 读取失败（${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}），降级 document.cookie`,
			);
		}
		try {
			const raw = await this.eval<string>("String(document.cookie || \"\")");
			if (typeof raw === "string" && raw.length > 0) {
				return raw;
			}
		} catch (e) {
			this.log(
				`getCookieString：document.cookie 读取也失败：${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`,
			);
		}
		return "";
	}

	/**
	 * Memoized x-rap-param capture (see installPageRecorder for the producer).
	 * First call polls window.__capturedRapParam every 400ms for up to 10s;
	 * the outcome (value OR "not captured") is cached so later requests don't
	 * re-stall. The cache resets whenever the webview is destroyed/recreated
	 * (fresh page -> fresh capture chance via the one-shot warmup).
	 */
	private rapParamCache: string | null = null;

	async readRapParam(): Promise<string> {
		if (this.rapParamCache !== null) {
			return this.rapParamCache;
		}
		// The recorder (which carries the x-rap-param hooks + warmup) must be
		// installed on the CURRENT webview element — after a destroy/reclaim
		// cycle a fresh element exists without any hooks, and the warmup would
		// fire into an unhooked page (observed: 10s timeout, no capture).
		await this.installPageRecorder();
		const deadline = Date.now() + 10_000;
		let rewarmed = false;
		while (Date.now() < deadline) {
			try {
				const v = await this.eval<string>('String(window.__capturedRapParam || "")');
				if (typeof v === "string" && v.length > 0) {
					this.log("readRapParam：已截获 x-rap-param，后续请求将携带");
					this.rapParamCache = v;
					return v;
				}
			} catch {
				// Page not ready / eval failed: keep polling until the deadline.
			}
			// Re-warm once mid-poll: XHS's wrapper may attach after our first
			// attempt; a second homefeed POST through the now-patched fetch
			// produces x-rap-param.
			if (!rewarmed && Date.now() > deadline - 6_500) {
				rewarmed = true;
				await this.installPageRecorder({ rewarm: true });
			}
			await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
		}
		this.log("readRapParam：10s 内未截获 x-rap-param，请求不带该头照发");
		this.rapParamCache = "";
		return "";
	}

	/**
	 * Signed headers for the plugin-process path — now produced by the
	 * VERBATIM port of ytf606/xhs2obsidian's signing (see ./sign-ref.ts,
	 * MIT): a redbook-lineage implementation whose signatures the XHS server
	 * accepts, unlike our previous xhshow-derived signer (perpetual 406).
	 * It takes the FULL cookie string and synthesizes its own fingerprint b1.
	 */
	private async signForNodeRequest(
		cookieString: string,
		method: "GET" | "POST",
		uri: string,
		data: Record<string, unknown> | null,
	): Promise<Record<string, string>> {
		if (!cookieString) {
			throw new SignError("无 Cookie 可用于签名（未登录或分区读取失败）");
		}
		const headers = signRequest(uri, method, cookieString, data ?? undefined);
		return { ...headers } as Record<string, string>;
	}

	/**
	 * Generate signed request headers.
	 *
	 * Preferred path (2026): pure LOCAL signing (see ./sign.ts, the algorithm
	 * MediaCrawler uses via xhshow). Verified 2026-09 that the XHS page no
	 * longer exposes window._webmsxyw & al., so the page-function probe below
	 * is only a FALLBACK.
	 *
	 * Inputs:
	 *  - a1: read from document.cookie inside the webview (set even logged-out).
	 *  - b1: in a real XHS page b1 lives in localStorage.getItem("b1") (see
	 *    MediaCrawler help.py comments), NOT in cookies. We read it from
	 *    localStorage; if absent (page not ready / fresh partition) we synthesize
	 *    one locally exactly the way MediaCrawler's xhshow library does.
	 */
	async getSign(
		method: "GET" | "POST",
		uri: string,
		data: Record<string, unknown> | null,
	): Promise<RedNoteSign> {
		// (1) Best-effort cookie/localStorage read inside the page context.
		let a1 = "";
		let b1 = "";
		try {
			const raw = await this.eval<string>(`(() => {
				let a1 = "";
				const m = document.cookie.match(/(?:^|; )a1=([^;]*)/);
				if (m) { try { a1 = decodeURIComponent(m[1]); } catch (e) { a1 = m[1]; } }
				let b1v = "";
				try { b1v = (window.localStorage && window.localStorage.getItem("b1")) || ""; } catch (e) {}
				return JSON.stringify({ a1: a1, b1: b1v });
			})()`);
			const p = raw ? (JSON.parse(raw) as { a1?: unknown; b1?: unknown }) : null;
			if (p) {
				if (typeof p.a1 === "string") a1 = p.a1;
				if (typeof p.b1 === "string") b1 = p.b1;
			}
		} catch (e) {
			console.warn(
				"[pull-rednote] cookie/b1 read failed:",
				e instanceof Error ? e.message : e,
			);
		}

		// (2) LOCAL signing (primary) — XYS_ format: the page's OWN successful
		// requests (observed live via the setRequestHeader hook on this exact
		// webview session) still use X-S=XYS_…, so the earlier "XYS_ is
		// rejected" theory was wrong — our 406s came from request-shape
		// differences (missing x-xray-traceid etc.), not the X-S format.
		if (a1) {
			try {
				const sign = xhsSign(uri, method, data, a1, b1 || generateB1());
				return sign;
			} catch (e) {
				console.warn(
					"[pull-rednote] local sign failed:",
					e instanceof Error ? e.message : e,
				);
			}
		} else {
			console.warn("[pull-rednote] no a1 cookie in webview page; local sign unavailable");
		}

		// (3) Fallback: probe XHS's own page signing function (legacy path).
		const legacy = await this.tryPageSign(method, uri, data);
		if (legacy) {
			return legacy;
		}
		throw new SignError(
			"本地与页面签名均不可用：无法读取 a1 cookie 且页面无签名函数。请重新打开登录窗口并确认页面完全加载后再同步。",
		);
	}

	/**
	 * Legacy fallback: invoke XHS's own page JS signing function
	 * (community-documented as window._webmsxyw, plus a few renamed variants).
	 * Absent on 2026 pages, but harmless to try and keeps a second opinion.
	 */
	private async tryPageSign(
		method: "GET" | "POST",
		uri: string,
		data: Record<string, unknown> | null,
	): Promise<RedNoteSign | null> {
		const payload = JSON.stringify(data ?? {});
		const code = `
			(() => {
				function norm(r) {
					if (!r || typeof r !== 'object') return null;
					const gs = r['x-s'] ?? r['X-S'] ?? r.xs;
					const gt = r['x-t'] ?? r['X-T'] ?? r.xt;
					const gc = r['x-s-common'] ?? r['X-S-Common'];
					const gb = r['x-b3-traceid'] ?? r['X-B3-Traceid'];
					if (!gs || !gt) return null;
					return { 'X-S': gs, 'X-T': gt, 'x-s-common': gc || '', 'X-B3-Traceid': gb || '' };
				}
				function tryCall(fn, uri, data, m) {
					try {
						let r = null;
						if (m === 'POST') {
							r = fn(uri, data);
							if (!r) r = fn(uri, JSON.stringify(data));
						} else {
							r = fn(uri, data);
							if (!r) r = fn(uri);
						}
						return norm(r);
					} catch (e) { return null; }
				}
				const cands = ['_webmsxyw','_webmsk','_wxhshow','_sign','_webSign'];
				for (const name of cands) {
					const fn = window[name];
					if (typeof fn === 'function') {
						const out = tryCall(fn, ${JSON.stringify(uri)}, ${payload}, ${JSON.stringify(method)});
						if (out) return JSON.stringify(out);
					}
				}
				return JSON.stringify(null);
			})()
		`;
		try {
			const result = await this.eval<string | null>(code);
			const parsed = result ? JSON.parse(result) : null;
			if (parsed && parsed["X-S"] && parsed["X-T"]) {
				return parsed as RedNoteSign;
			}
		} catch (e) {
			console.warn(
				"[pull-rednote] page sign probe failed:",
				e instanceof Error ? e.message : e,
			);
		}
		return null;
	}

	/**
	 * Issue a signed request and return the parsed `data` field of the XHS
	 * response envelope.
	 *
	 * Transport is now the PLUGIN PROCESS (nodeRequest below — obsidian
	 * requestUrl + partition Cookie + local signature + captured x-rap-param);
	 * the previous in-webview page-context fetch path was removed. See the
	 * module header for the new pipeline.
	 *
	 * On an unauthenticated response it throws NotLoggedInError so the caller
	 * can guide the user to re-login.
	 */
	async request(
		method: "GET" | "POST",
		uri: string,
		data: Record<string, unknown> | null,
		opts: { unsigned?: boolean } = {},
	): Promise<Record<string, unknown>> {
		return this.nodeRequest(method, uri, data, opts);
	}

	/**
	 * Plugin-process request pipeline (reference: ytf606/xhs2obsidian
	 * sign-manager): obsidian requestUrl transport + partition Cookie +
	 * Origin/Referer/UA headers + the five signature headers + optional
	 * captured x-rap-param. The GET query string and the signed content string
	 * are composed by the SAME ordered helpers (wire.ts), so the server
	 * reconstructs exactly the string that was signed.
	 *
	 * The REQ log (status/code/success) and the error mapping
	 * (NotLoggedInError / FetchError / 300011/300012 risk-control codes) keep
	 * the semantics of the previous page-context implementation.
	 */
	async nodeRequest(
		method: "GET" | "POST",
		uri: string,
		data: Record<string, unknown> | null,
		opts: { unsigned?: boolean } = {},
	): Promise<Record<string, unknown>> {
		const cookieString = await this.getCookieString();
		const headers: Record<string, string> = {
			"Cookie": cookieString,
			"Origin": "https://www.xiaohongshu.com",
			"Referer": "https://www.xiaohongshu.com/",
			"User-Agent": EDGE_UA,
		};
		// The reference sends Content-Type on EVERY request (GETs included).
		headers["Content-Type"] = "application/json;charset=UTF-8";
		if (!opts.unsigned) {
			const sign = await this.signForNodeRequest(cookieString, method, uri, data);
			headers["x-s"] = sign["x-s"] ?? "";
			headers["x-t"] = sign["x-t"] ?? "";
			headers["x-s-common"] = sign["x-s-common"] ?? "";
			headers["x-b3-traceid"] = sign["x-b3-traceid"] ?? "";
			headers["x-xray-traceid"] = sign["x-xray-traceid"] ?? "";
			// Optional: captured from the page (see installPageRecorder). When
			// interception fails, the request goes out WITHOUT this header.
			const rap = await this.readRapParam();
			if (rap) {
				headers["x-rap-param"] = rap;
			}
		}

		// Build the full URL and body. For GET, the query string MUST be
		// encoded exactly like the signed content string (xhsQueryEscape =
		// Python quote(safe=",")) and in the same order, or the server
		// reconstructs a different string and rejects the signature.
		let fullUrl = HOST + uri;
		let body: string | undefined;
		if (method === "GET" && data) {
			const qs = buildGetQueryString(data);
			if (qs) {
				fullUrl = `${fullUrl}?${qs}`;
			}
		} else if (method === "POST" && data) {
			body = JSON.stringify(data);
		}

		// One REQ line per request in debug.log (session.log), including every
		// failure/exception branch below — the sync path stays fully traceable.
		const reqTag = `REQ ${method} ${uri.slice(0, 60)}`;
		let resp: { status: number; json: Record<string, unknown> | null; text?: string } | null =
			null;
		try {
			// TRANSPORT: raw Node https, NOT obsidian requestUrl — a standalone
			// probe proved identical headers+signature get HTTP 200 via a plain
			// HTTPS client while requestUrl gets 406 (it stamps its own
			// request identity, which XHS rejects). If the in-process Node
			// stack still gets 406 (Obsidian-process environment difference,
			// under investigation), fall back to a spawned curl — the same
			// request via curl was verified to return 200 repeatedly.
			let r = await nodeHttpsJson(fullUrl, method, headers, body);
			if (r.status === 406) {
				const envP = (window as unknown as { process?: { env?: Record<string, string | undefined> } })
					.process?.env ?? {};
				const envRelay = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]
					.filter((k) => envP[k])
					.join(",");
				this.log(
					`${reqTag} -> 406 (Node https)，尝试 curl 兜底（进程代理env：${envRelay || "无"}）`,
				);
				const c = await curlTransport(fullUrl, method, headers, body);
				if (c.status > 0 && c.status !== 406) {
					this.log(`${reqTag} -> curl 兜底生效 HTTP ${c.status}`);
					r = c;
				} else {
					this.log(
						`${reqTag} -> curl 兜底仍 ${c.status}（服务端头：${c.serverHeaders}）`,
					);
				}
			}
			let json: Record<string, unknown> | null = null;
			try {
				json = JSON.parse(r.text) as Record<string, unknown> | null;
			} catch {
				/* non-JSON body — surfaced through the text branch below */
			}
			resp = { status: r.status, json, text: r.text };
		} catch (e) {
			this.log(`${reqTag} -> EXC ${e instanceof Error ? e.message : String(e)}`);
			throw e;
		}
		if (!resp) {
			this.log(`${reqTag} -> ERR 无返回`);
			throw new FetchError(`请求 ${uri} 无返回`);
		}

		const status = resp.status;
		{
			const j = resp.json;
			const codeStr = j && j.code != null ? String(j.code) : "-";
			const successStr = j && j.success != null ? String(j.success) : "-";
			this.log(`${reqTag} -> HTTP${status} code=${codeStr} success=${successStr}`);
		}
		if (status === 401 || status === 403) {
			throw new NotLoggedInError("登录已失效，请重新登录");
		}

		const json: Record<string, unknown> | null = resp.json;
		if (json && typeof json === "object") {
			const codeStr = json.code != null ? String(json.code) : "";
			// 300011 security limit / 300012 IP block (per MediaCrawler client)
			if (codeStr === "300012" || codeStr === "300011") {
				throw new FetchError(
					`小红书返回限制码 ${codeStr}（IP 风控 / 账号安全限制），请稍后重试`,
				);
			}
			if (json.success === true) {
				return (json.data ?? json) as Record<string, unknown>;
			}
			// Not-logged-in style response (auth-checking URIs). Observed
			// envelope for logged-out checks is {"code":-1,"success":false}
			// with NO msg — so treat ANY success:false on auth-checking URIs as
			// NotLoggedInError instead of requiring a msg heuristic.
			const isAuthy =
				uri.includes("user/selfinfo") ||
				uri.includes("user/me") ||
				uri.includes("collect/page") ||
				uri.includes("/feed");
			if (isAuthy && json.success === false) {
				throw new NotLoggedInError(`登录已失效：${json.msg || "接口要求登录"}`);
			}
			throw new FetchError(
				`接口 ${uri} 返回失败：${json.msg ?? JSON.stringify(json).slice(0, 200)}`,
			);
		}
		throw new FetchError(
			`接口 ${uri} 返回非 JSON（HTTP ${status}）：${String(resp.text ?? "").slice(0, 120)}`,
		);
	}

	/**
	 * Check login state via the unsigned /api/sns/web/v2/user/me endpoint
	 * (Cookie header alone — reference sign-manager): data.userInfo.user_id
	 * present means logged in. Any API-channel failure falls through to the
	 * page probe (below), which stays as the fallback.
	 */
	/**
	 * Last login-check outcome for UI surfacing (null = no recorded reason).
	 * Cleared at the start of every checkLogin() call.
	 */
	lastCheckInfo: string | null = null;

	/**
	 * Page-side login probe (second opinion): an unsigned selfinfo cannot
	 * distinguish "not logged in" from "unsigned request rejected" — both
	 * return {code:-1,success:false}. The PAGE itself knows: XHS SSR pages
	 * embed login state in window.__INITIAL_STATE__ and logged-in pages carry
	 * the avatar/sidebar chrome. Returns {ok, info} for UI surfacing.
	 */
	/**
	 * Install (idempotently) the page-request recorder PLUS the x-rap-param
	 * interceptor (reference: ytf606/xhs2obsidian). Three hooks push any value
	 * named x-rap-param into window.__capturedRapParam for readRapParam() to
	 * poll: Headers.prototype.set/append, window.fetch (init headers), and
	 * XMLHttpRequest.prototype.setRequestHeader. A ONE-SHOT warmup (guarded by
	 * window.__pullWarmupDone so polling never re-fires it) POSTs to
	 * homefeed with credentials, coaxing XHS's own request wrapper into
	 * emitting x-rap-param. Hooks both fetch and XHR: XHS's organic calls go
	 * through XHR/axios — a fetch-only hook misses them (learned the hard
	 * way). Called on dom-ready, before the page's organic request burst.
	 */
	async installPageRecorder(opts: { rewarm?: boolean } = {}): Promise<void> {
		const code = `(() => {
			${opts.rewarm ? 'try { delete window.__pullWarmupDone; } catch (eRew) {}' : ""}
			if (window.__pullHooked) { return "already"; }
			window.__pullHooked = true;
			window.__pullReqs = [];
			const mark = function (url, via) {
				const e = { u: String(url).slice(0, 90), s: 0, v: via };
				window.__pullReqs.push(e);
				return e;
			};
			window.__capturedRapParam = window.__capturedRapParam || "";
			const RAP = "x-rap-param";
			const noteRap = function (v) {
				try {
					if (typeof v === "string" && v && window.__capturedRapParam !== v) {
						window.__capturedRapParam = v;
					}
				} catch (errR) {}
			};
			try {
				const ohs = Headers.prototype.set;
				Headers.prototype.set = function (n, v) {
					try { if (String(n).toLowerCase() === RAP) { noteRap(String(v)); } } catch (errH) {}
					return ohs.apply(this, arguments);
				};
				const oha = Headers.prototype.append;
				Headers.prototype.append = function (n, v) {
					try { if (String(n).toLowerCase() === RAP) { noteRap(String(v)); } } catch (errH2) {}
					return oha.apply(this, arguments);
				};
			} catch (errH3) {}
			try {
				const of = window.fetch;
				window.fetch = function () {
					const a = arguments;
					const url = String(a[0]);
					try {
						const h = a[1] && a[1].headers;
						if (h) {
							if (typeof Headers !== "undefined" && h instanceof Headers) {
								const rv = h.get(RAP);
								if (rv) { noteRap(rv); }
							} else if (typeof h === "object") {
								for (const hk in h) {
									if (String(hk).toLowerCase() === RAP) { noteRap(String(h[hk])); }
								}
							}
						}
					} catch (errF) {}
					if (url.indexOf("edith.xiaohongshu.com") >= 0) {
						const e = mark(url, "fetch");
						return of.apply(this, a).then(function (r) { e.s = r.status; return r; });
					}
					return of.apply(this, a);
				};
			} catch (err) {}
			try {
				const ox = XMLHttpRequest.prototype.open;
				const os = XMLHttpRequest.prototype.send;
				const osh = XMLHttpRequest.prototype.setRequestHeader;
				XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
					try { if (String(n).toLowerCase() === RAP) { noteRap(String(v)); } } catch (errX) {}
					try {
						if (this.__pullUrl && this.__pullUrl.indexOf("edith.xiaohongshu.com") >= 0) {
							if (!window.__pullHdrs) { window.__pullHdrs = {}; }
							if (!(n in window.__pullHdrs)) { window.__pullHdrs[n] = String(v).slice(0, 18); }
						}
					} catch (err) {}
					return osh.apply(this, arguments);
				};
				XMLHttpRequest.prototype.open = function (mth, url) {
					try { this.__pullUrl = String(url); } catch (err) {}
					return ox.apply(this, arguments);
				};
				XMLHttpRequest.prototype.send = function () {
					const self = this;
					try {
						if (this.__pullUrl && this.__pullUrl.indexOf("edith.xiaohongshu.com") >= 0) {
							const e = mark(this.__pullUrl, "xhr");
							this.addEventListener("loadend", function () {
								try { e.s = self.status; } catch (err2) {}
							});
						}
					} catch (err3) {}
					return os.apply(this, arguments);
				};
			} catch (err4) {}
			try {
				if (!window.__pullWarmupDone) {
					window.__pullWarmupDone = true;
					// EXACT homefeed payload from the reference implementation —
					// XHS's wrapper only signs/rap's requests it recognizes; a
					// bare "{}" body was ignored (no capture ever happened).
					const warmBody = JSON.stringify({
						cursor_score: "", num: 1, refresh_type: 1, note_index: 0,
						unread_begin_note_id: "", unread_end_note_id: "", unread_note_count: 0,
						category: "homefeed_recommend", search_key: "",
					});
					const warmInit = { method: "POST", credentials: "include", headers: { "content-type": "application/json;charset=UTF-8" }, body: warmBody };
					window.fetch("https://edith.xiaohongshu.com/api/sns/web/v1/homefeed", warmInit).catch(function () {});
				}
			} catch (errW) {}
			return "installed";
		})()`;
		try {
			await this.eval<string>(code);
		} catch {
			/* recorder / interceptor is best-effort diagnostics */
		}
	}

	async checkLoginViaPage(): Promise<{ ok: boolean; info: string }> {
		// Fully defensive: XHS pages can make window.__INITIAL_STATE__ access
		// throw (guarded getters), and an eval that rejects surfaces as a
		// GUEST_VIEW_MANAGER_CALL error. Every access is wrapped so the eval
		// always resolves with a JSON summary.
		const code = `(() => {
			const out = { hasUserData: false, userKeys: "", cookieA1: false, stateKeys: "PROBE_ERROR", loggedIn: "absent", pageReqs: "", pageHdrs: "" };
			// Page-request recorder: hook fetch ONCE and remember the status of
			// every edith API call the PAGE ITSELF makes. If the page's own
			// requests also get 406, the block is webview-session-wide (device/
			// fingerprint level); if they succeed, only OUR constructed
			// requests differ. This single signal discriminates the two.
			try {
				if (!window.__pullHooked) {
					window.__pullHooked = true;
					window.__pullReqs = [];
					const of = window.fetch;
					window.fetch = function () {
						const a = arguments;
						const url = String(a[0]);
						if (url.indexOf("edith.xiaohongshu.com") >= 0) {
							const e = { u: url.slice(0, 90), s: 0 };
							window.__pullReqs.push(e);
							return of.apply(this, a).then(function (r) { e.s = r.status; return r; });
						}
						return of.apply(this, a);
					};
				}
				out.pageReqs = (window.__pullReqs || []).slice(-6)
					.map(function (e) { return (e.s || "?") + "<" + e.u.slice(28, 62) + ">"; })
					.join(" ; ");
				out.pageHdrs = Object.keys(window.__pullHdrs || {})
					.map(function (k) { return k + "=" + window.__pullHdrs[k]; })
					.join(" , ")
					.slice(0, 200);
			} catch (e) { out.pageReqs = "HOOK_ERR"; }
			try { out.cookieA1 = /(?:^|; )a1=/.test(document.cookie); } catch (e) {}
			try {
				const st = window.__INITIAL_STATE__ || {};
				out.stateKeys = Object.keys(st).slice(0, 12).join(",");
				const user = st.user || {};
				const keys = Object.keys(user);
				out.userKeys = keys.slice(0, 6).join(",");
				// DO NOT use JSON.stringify(user) as the signal: the XHS user
				// object is not serializable (circular / guarded getters), the
				// stringify throws and used to leave hasUserData false even on
				// a logged-in page. The authoritative signal is the explicit
				// loggedIn boolean field.
				out.hasUserData = keys.length > 0;
				try {
					const lv = user.loggedIn;
					out.loggedIn = lv === true ? "true" : lv === false ? "false" : String(lv).slice(0, 12);
				} catch (e2) { out.loggedIn = "throw"; }
			} catch (e) {
				out.stateKeys = "PROBE_THROW:" + String(e).slice(0, 60);
			}
			return JSON.stringify(out);
		})()`;
		try {
			const raw = await this.eval<string>(code);
			const p = raw
				? (JSON.parse(raw) as {
						hasUserData?: boolean;
						userKeys?: string;
						cookieA1?: boolean;
						stateKeys?: string;
						loggedIn?: string;
						pageReqs?: string;
						pageHdrs?: string;
					})
				: null;
			if (!p) {
				return { ok: false, info: "页面探测无返回" };
			}
			const stateKeys = (p.stateKeys ?? "").slice(0, 80);
			if (p.pageHdrs) {
				this.log(`页面成功请求的头样例：${p.pageHdrs}`);
			}
			this.log(`页面自身请求记录：${p.pageReqs || "（暂无）"}`);
			const info =
				`页面侧 loggedIn=${p.loggedIn ?? "?"}，INITIAL_STATE.user=${p.userKeys || "无"}` +
				`，a1=${p.cookieA1 ? "有" : "无"}` +
				`，state keys=${stateKeys || "无"}` +
				`，页面请求=${p.pageReqs ? p.pageReqs.slice(0, 120) : "无"}`;
			// loggedIn === true is the authoritative signal; fall back to
			// hasUserData only when the field is absent (unexpected shape).
			const ok = p.loggedIn === "true" || (p.loggedIn !== "false" && Boolean(p.hasUserData));
			return { ok, info };
		} catch (e) {
			return { ok: false, info: `页面探测失败：${e instanceof Error ? e.message : String(e)}` };
		}
	}

	/**
	 * Structured login check. Each stage appends a labeled part to
	 * lastCheckInfo so the status line / debug log shows WHICH stage said
	 * what (a hung stage is identifiable by its missing label).
	 */
	/** Optional debug sink (main.ts wires this to debug.log in the plugin dir). */
	logger: ((line: string) => void) | null = null;

	log(line: string): void {
		const ts = new Date().toISOString().slice(11, 23);
		const text = `[${ts}] ${line}`;
		if (this.logger) {
			try {
				this.logger(text);
			} catch {
				/* logging must never break the caller */
			}
		}
		console.log(`[pull-rednote] ${text}`);
	}

	async checkLogin(): Promise<boolean> {
		// API channel: unsigned GET /api/sns/web/v2/user/me (Cookie header
		// alone). No signature is needed, so a missing/unavailable signer can
		// never break login detection. Any failure falls through to the page
		// probe, which remains the fallback.
		this.lastCheckInfo = null;
		const parts: string[] = [];
		try {
			const data = await this.request("GET", "/api/sns/web/v2/user/me", {}, { unsigned: true });
			const userInfo = data?.userInfo as Record<string, unknown> | undefined;
			if (
				userInfo &&
				typeof userInfo === "object" &&
				userInfo.user_id != null &&
				String(userInfo.user_id).length > 0
			) {
				return true;
			}
			parts.push("接口=响应无 user_id");
		} catch (e) {
			if (e instanceof NotLoggedInError) {
				parts.push("接口=拒");
			} else {
				parts.push(
					`接口=错:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`,
				);
				console.warn("[pull-rednote] checkLogin user/me failed:", e);
			}
		}
		parts.push("页面探测…");
		const page = await this.checkLoginViaPage();
		if (page.ok) {
			this.lastCheckInfo = `接口未确认但页面已登录（${page.info}）`;
			this.log(`checkLogin -> true（${this.lastCheckInfo}）`);
			return true;
		}
		parts.push(`页面=否（${page.info.slice(0, 90)}）`);
		this.lastCheckInfo = parts.join("；");
		this.log(`checkLogin -> false：${this.lastCheckInfo}`);
		return false;
	}

	/**
	 * Log out: ask XHS to invalidate the session server-side (the exit
	 * endpoint is the only way to kill the httpOnly web_session cookie),
	 * expire every locally readable cookie, then drop the webview element so
	 * the next use starts from a fresh page.
	 */
	async logout(): Promise<void> {
		this.log("logout: 开始（服务端 exit + 本地 cookie 过期 + webview 重建）");
		try {
			const code = `fetch("https://edith.xiaohongshu.com/api/sns/web/v1/login/exit", {method:"POST", credentials:"include", headers:{"content-type":"application/json;charset=UTF-8"}}).then(r => String(r.status)).catch(e => String(e).slice(0, 80))`;
			const res = await this.eval<string>(code);
			this.log(`logout: 服务端 exit 接口返回 ${res}`);
			console.log("[pull-rednote] logout exit endpoint:", res);
		} catch (e) {
			console.warn("[pull-rednote] logout exit endpoint failed:", e);
		}
		try {
			const clear = `(() => {
				document.cookie.split(";").forEach((c) => {
					const n = c.split("=")[0].trim();
					if (!n) return;
					document.cookie = n + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.xiaohongshu.com";
					document.cookie = n + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
				});
				return String(document.cookie.length);
			})()`;
			await this.eval<string>(clear);
		} catch {
			// Non-fatal: the server-side exit above is the authoritative logout.
		}
		this.destroy();
	}

	/**
	 * Fetch the current user id (needed as the `user_id` for the collect list).
	 * Derived from selfinfo.
	 */
	async getSelfUserId(): Promise<string> {
		// PRIMARY: read the user id from the PAGE's SSR state — zero API
		// requests. selfinfo is the endpoint we hammered for hours during
		// debugging and it now returns 406 unconditionally for this session,
		// but the logged-in page already carries the user id in
		// __INITIAL_STATE__.user (userInfo / userPageData).
		try {
			const code = `(() => {
				const out = { uid: "" };
				try {
					const u = (window.__INITIAL_STATE__ || {}).user || {};
					// SSR values are Vue ref wrappers (observed keys: __v_isRef,
					// _rawValue, _value) — unwrap before reading fields.
					const unref = (o) => (!o || typeof o !== "object") ? o : (o._rawValue !== undefined ? o._rawValue : (o.value !== undefined ? o.value : o));
					const ui = unref(u.userInfo);
					const upd = unref(u.userPageData);
					const cands = [
						ui && (ui.user_id || ui.userId),
						upd && (upd.user_id || upd.userId),
						u.user_id,
					];
					for (const c of cands) {
						if (c != null && String(c).length > 0) { out.uid = String(c); break; }
					}
					if (!out.uid) {
						const uk = Object.keys(ui || {}).slice(0, 14).join(",");
						out.uid = "MISS:" + (uk || Object.keys(u.userInfo || {}).slice(0, 12).join(","));
					}
				} catch (e) { out.uid = "THROW:" + String(e).slice(0, 50); }
				return JSON.stringify(out);
			})()`;
			const raw = await this.eval<string>(code);
			const p = raw ? (JSON.parse(raw) as { uid?: string }) : null;
			const uid = p?.uid ?? "";
			if (uid && !uid.startsWith("MISS:") && !uid.startsWith("THROW:")) {
				this.log(`getSelfUserId：从页面 SSR 状态取得 user_id=${uid.slice(0, 8)}…`);
				return uid;
			}
			this.log(`getSelfUserId：页面 SSR 未取到 user_id（${uid.slice(0, 80)}），回退 selfinfo 接口`);
		} catch (e) {
			this.log(`getSelfUserId：页面读取失败，回退 selfinfo 接口：${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
		}
		// FALLBACK: signed selfinfo (SIGNED ONLY — unsigned is guaranteed 406).
		let data: Record<string, unknown>;
		try {
			data = await this.request("GET", "/api/sns/web/v1/user/selfinfo", {}, {});
		} catch (e) {
			this.log(`getSelfUserId 请求失败：${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
			return "";
		}
		const result = (data?.result ?? data) as Record<string, unknown> | undefined;
		const basic = (result?.basic_info ?? result) as Record<string, unknown> | undefined;
		const candidates = [basic?.user_id, result?.user_id, data?.user_id];
		const uid = candidates.find((v) => v != null && String(v).length > 0);
		if (uid == null) {
			this.log(
				`getSelfUserId 未找到 user_id，selfinfo data 形状：${JSON.stringify(data).slice(0, 300)}`,
			);
			return "";
		}
		return String(uid);
	}

	/**
	 * Fetch one page of the favorites list.
	 * Endpoint (verified): GET /api/sns/web/v2/note/collect/page
	 *
	 * Query order matches the reference implementation: optional cursor ->
	 * num -> user_id -> image_formats=jpg,webp,avif (commas literal). The
	 * same ordered object feeds both the signed content string and the URL.
	 */
	async fetchFavoritesPage(
		userId: string,
		cursor: string,
	): Promise<{ items: RedNoteRaw[]; has_more: boolean; next_cursor: string }> {
		const data = (await this.request(
			"GET",
			"/api/sns/web/v2/note/collect/page",
			buildCollectPageParams(userId, cursor),
		)) as unknown as RawListData;
		const page = parseListPage(data);
		return page;
	}

	/**
	 * Fetch a single note's detail.
	 * Endpoint (verified): POST /api/sns/web/v1/feed -> items[0].note_card
	 */
	async fetchNoteDetail(
		noteId: string,
		xsecToken: string,
		xsecSource: string,
	): Promise<Record<string, unknown> | null> {
		const source = xsecSource || "pc_collect";
		const data = await this.request("POST", "/api/sns/web/v1/feed", {
			source_note_id: noteId,
			image_formats: ["jpg", "webp", "avif"],
			extra: { need_body_topic: 1 },
			xsec_source: source,
			xsec_token: xsecToken || "",
		});
		const items = data?.items as Array<Record<string, unknown>> | undefined;
		if (!items || items.length === 0) {
			return null;
		}
		const first = items[0] ?? null;
		return (first?.note_card as Record<string, unknown>) ?? null;
	}

	/**
	 * Merge a list card with its fetched detail. (Detail fetch is done by the
	 * caller / pipeline; this is a thin passthrough kept for clarity.)
	 */
	mergeCard(card: RedNoteRaw, detail: Record<string, unknown> | null | undefined): RedNoteRaw {
		return mergeNoteCard(card, detail);
	}

	/** Should the pagination loop continue after this page? */
	static shouldContinue = shouldContinue;
}

/** Helper for selfinfo typing. */
interface user_selfinfo {
	user_id?: unknown;
}

/**
 * Sleep helper for polite pacing between requests (1–3s per contract).
 */
export async function randomDelay(minMs = 1000, maxMs = 3000): Promise<void> {
	const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
	await new Promise((r) => window.setTimeout(r, ms));
}

/**
 * Run a pipeline step with a single retry on FetchError (not on SignError /
 * NotLoggedInError, which are terminal and should surface immediately).
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof SignError || e instanceof NotLoggedInError) {
			throw e;
		}
		// One retry after a short backoff.
		await new Promise((r) => window.setTimeout(r, 1500));
		return fn();
	}
}
