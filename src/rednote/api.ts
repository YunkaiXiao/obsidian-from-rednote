// Side-effect module: embedded webview session + signed XHS API client.
//
// Data path (per ADR-007): the API requests are issued from INSIDE the
// already-loaded Xiaohongshu webview page context, so cookies and the browser
// signing are handled by XHS's own front-end JS. This avoids reimplementing the
// signature algorithm and survives algorithm changes.
//
// Verified against (2026-09-14):
//  - MediaCrawler (NanmiCoder/MediaCrawler) media_platform/xhs/{client,core,help,login}.py
//  - ReaJason/xhs (the library MediaCrawler's xhs module builds on) xhs/core.py
//    * favorites list : GET  /api/sns/web/v2/note/collect/page  {user_id,num,cursor}
//    * note detail    : POST /api/sns/web/v1/feed               -> items[0].note_card
//    * login check    : GET  /api/sns/web/v1/user/selfinfo      -> data.result.success
//    * host           : edith.xiaohongshu.com
//    * UA             : stable Chrome (MediaCrawler core.py user_agent)
//
// This file imports obsidian; keep it OUT of unit tests (tests only touch the
// pure modules).

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
import { xhsSignXyw, generateB1, xhsQueryEscape } from "./sign";

/** The partition isolates this session from Obsidian's default browser session. */
const WEBVIEW_PARTITION = "persist:rednote-sync";
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
const INDEX_URL = "https://www.xiaohongshu.com";
/** Allowed host suffixes for in-webview navigation (XHS domains only). */
const ALLOWED_HOSTS = [
	"www.xiaohongshu.com",
	"edith.xiaohongshu.com",
	"xiaohongshu.com",
	"rednote.com",
	"xhscdn.com",
];

/** A <webview> element — not typed in the bundled obsidian d.ts, so a minimal cast. */
type WebviewEl = HTMLElement & {
	executeJavaScript?: (code: string) => Promise<unknown>;
	setZoomFactor?: (factor: number) => void;
	reload?: () => void;
};

export function isXhsHost(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
	} catch {
		return false;
	}
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

		// (2) LOCAL signing (primary) — XYW_ (AES-128-CBC) format, required by
		// data-fetching APIs since ~2026-03 (XYS_ gets {success:false}).
		if (a1) {
			try {
				const sign = xhsSignXyw(uri, method, data, a1, b1 || generateB1());
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
	 * Issue a signed request from inside the webview page context.
	 * Returns the parsed `data` field of the XHS response envelope.
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
		const headers: Record<string, string> = {
			accept: "application/json, text/plain, */*",
			"content-type": "application/json;charset=UTF-8",
		};
		// Signing requires a page-context function (window._webmsxyw & al.) that
		// is not guaranteed to exist at any given moment. Callers that do NOT
		// need signatures (selfinfo responds to cookies alone — MediaCrawler's
		// pong check) pass { unsigned: true } so a missing sign function cannot
		// break login detection.
		if (!opts.unsigned) {
			const sign = await this.getSign(method, uri, data);
			headers["X-S"] = sign["X-S"];
			headers["X-T"] = sign["X-T"];
			headers["x-s-common"] = sign["x-s-common"];
			headers["X-B3-Traceid"] = sign["X-B3-Traceid"];
		}

		// Build the full URL. For GET, the query string MUST be encoded exactly
		// like the signed content string (xhsQueryEscape = Python
		// quote(safe=",")) or the server reconstructs a different string and
		// rejects the signature. This matches MediaCrawler's _build_query_string.
		let fullUrl = HOST + uri;
		const body: string | undefined =
			method === "POST" && data ? JSON.stringify(data) : undefined;

		const init: Record<string, unknown> = {
			method,
			headers,
			credentials: "include",
		};
		if (method === "GET" && data) {
			const qs = Object.entries(data)
				.map(([k, v]) => `${k}=${xhsQueryEscape(String(v))}`)
				.join("&");
			fullUrl = `${fullUrl}?${qs}`;
		} else if (method === "POST" && body !== undefined) {
			init.body = body;
		}

		const code = `
			(() => {
				return fetch(${JSON.stringify(fullUrl)}, ${JSON.stringify(init)}).then(async (resp) => {
					let text = await resp.text();
					let json = null;
					try { json = JSON.parse(text); } catch (e) {}
					return JSON.stringify({ status: resp.status, json: json, text: text.slice(0, 500) });
				});
			})()
		`;
		// One REQ line per request in debug.log (session.log), including every
		// failure/exception branch below — the sync path stays fully traceable.
		const reqTag = `REQ ${method} ${uri.slice(0, 60)}`;
		let parsed: { status: number; json: Record<string, unknown> | null; text?: string } | null = null;
		try {
			const raw = await this.eval<string>(code);
			parsed = raw ? JSON.parse(raw) : null;
		} catch (e) {
			this.log(`${reqTag} -> EXC ${e instanceof Error ? e.message : String(e)}`);
			throw e;
		}
		if (!parsed) {
			this.log(`${reqTag} -> ERR 无返回`);
			throw new FetchError(`请求 ${uri} 无返回`);
		}

		const status = parsed.status as number;
		{
			const j = parsed.json;
			const codeStr = j && j.code != null ? String(j.code) : "-";
			const successStr = j && j.success != null ? String(j.success) : "-";
			this.log(`${reqTag} -> HTTP${status} code=${codeStr} success=${successStr}`);
		}
		if (status === 401 || status === 403) {
			throw new NotLoggedInError("登录已失效，请重新登录");
		}

		const json: Record<string, unknown> | null = parsed.json;
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
			// Not-logged-in style response (selfinfo / list with no result.success).
			// Observed envelope for logged-out selfinfo is {"code":-1,"success":false}
			// with NO msg — so treat ANY success:false on auth-checking URIs as
			// NotLoggedInError instead of requiring a msg heuristic.
			const isAuthy =
				uri.includes("user/selfinfo") ||
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
			`接口 ${uri} 返回非 JSON（HTTP ${status}）：${String(parsed.text ?? "").slice(0, 120)}`,
		);
	}

	/**
	 * Check login state via the selfinfo endpoint (verified in MediaCrawler
	 * client.pong / query_self: success when data.result.success is true).
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
	 * Install (idempotently) the page-request recorder: hooks BOTH fetch and
	 * XMLHttpRequest so the statuses of the PAGE'S OWN edith API calls are
	 * captured. XHS's organic calls go through XHR/axios — a fetch-only hook
	 * misses them (learned the hard way). Called on dom-ready, before the
	 * page's organic request burst.
	 */
	async installPageRecorder(): Promise<void> {
		const code = `(() => {
			if (window.__pullHooked) { return "already"; }
			window.__pullHooked = true;
			window.__pullReqs = [];
			const mark = function (url, via) {
				const e = { u: String(url).slice(0, 90), s: 0, v: via };
				window.__pullReqs.push(e);
				return e;
			};
			try {
				const of = window.fetch;
				window.fetch = function () {
					const a = arguments;
					const url = String(a[0]);
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
			return "installed";
		})()`;
		try {
			await this.eval<string>(code);
		} catch {
			/* recorder is best-effort diagnostics */
		}
	}

	async checkLoginViaPage(): Promise<{ ok: boolean; info: string }> {
		// Fully defensive: XHS pages can make window.__INITIAL_STATE__ access
		// throw (guarded getters), and an eval that rejects surfaces as a
		// GUEST_VIEW_MANAGER_CALL error. Every access is wrapped so the eval
		// always resolves with a JSON summary.
		const code = `(() => {
			const out = { hasUserData: false, userKeys: "", cookieA1: false, stateKeys: "PROBE_ERROR", loggedIn: "absent", pageReqs: "" };
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
					})
				: null;
			if (!p) {
				return { ok: false, info: "页面探测无返回" };
			}
			const stateKeys = (p.stateKeys ?? "").slice(0, 80);
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
		// SIGNED ONLY: unsigned selfinfo is a guaranteed HTTP 406 in 2026 —
		// every unsigned attempt is pure risk-control noise (hours of 2s
		// polling with unsigned-first eventually got the whole session 406-
		// blocked on the server side). The page probe remains the fallback.
		this.lastCheckInfo = null;
		const parts: string[] = [];
		try {
			const data = await this.request("GET", "/api/sns/web/v1/user/selfinfo", {}, {});
			const result = (data?.result ?? data) as Record<string, unknown> | undefined;
			if (result?.success === true) {
				return true;
			}
			if (
				result?.success === undefined &&
				(result?.basic_info != null || result?.user_id != null)
			) {
				return true;
			}
			parts.push("签名=响应无登录标记");
		} catch (e) {
			if (e instanceof NotLoggedInError) {
				parts.push("签名=拒");
			} else {
				parts.push(
					`签名=错:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`,
				);
				console.warn("[pull-rednote] checkLogin signed failed:", e);
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
		// SIGNED ONLY (unsigned selfinfo is a guaranteed 406 / risk noise).
		let data: Record<string, unknown>;
		try {
			data = await this.request("GET", "/api/sns/web/v1/user/selfinfo", {}, {});
		} catch (e) {
			this.log(`getSelfUserId 请求失败：${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
			return "";
		}
		// Tolerant extraction across known/possible 2026 envelope shapes; when
		// nothing matches, log the REAL payload shape so the next round can
		// adapt precisely (this used to silently return "" and the sync threw
		// NotLoggedInError 3ms after a successful HTTP 200).
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
	 */
	async fetchFavoritesPage(
		userId: string,
		cursor: string,
	): Promise<{ items: RedNoteRaw[]; has_more: boolean; next_cursor: string }> {
		const data = (await this.request("GET", "/api/sns/web/v2/note/collect/page", {
			user_id: userId,
			num: 30,
			cursor,
		})) as unknown as RawListData;
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
