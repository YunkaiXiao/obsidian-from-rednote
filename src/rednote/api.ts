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

/** The partition isolates this session from Obsidian's default browser session. */
const WEBVIEW_PARTITION = "persist:rednote-sync";
// NOTE: no useragent override on purpose. Per community analysis of
// obsidian.asar 1.13.7, Obsidian installs a session.webRequest hook per
// partition that rewrites the User-Agent header AFTER the webview attribute
// would apply, so the attribute is unreliable here anyway (see
// webview-ua-override plugin write-up). Surfing (reference implementation)
// sets no useragent either. Fewer moving parts, one less crash variable.

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
		const el = document.createElement("webview") as WebviewEl;
		// CRITICAL (white-screen root cause): Electron's <webview> is ATTRIBUTE-
		// driven (attributeChangedCallback). Plain property assignment
		// (el.src = …, el.partition = …) is NOT reflected to attributes in this
		// Electron build, so the navigation never started and the webview stayed
		// on about:blank — the all-white login modal. Always use setAttribute.
		// partition MUST be set before attach/src: it selects the persistent
		// session the login cookies will live in.
		el.setAttribute("partition", WEBVIEW_PARTITION);
		// NOTE: allowpopups is intentionally NOT set. Electron treats boolean
		// webview attributes by PRESENCE (any value, including "false", means
		// enabled), so setAttribute("allowpopups", "false") would have been
		// inverted. Absent = popups disabled, which is what we want.
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

		// Surfing pattern: if the webview is ever destroyed out from under us
		// (e.g. its node got moved to another document by Obsidian workspace
		// machinery), invalidate our references so the next ensure* call
		// recreates it from scratch. We NEVER move a live webview ourselves.
		el.addEventListener("destroyed", () => {
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
	 * Generate signed request headers by invoking XHS's own page JS.
	 *
	 * Community-documented function is `window._webmsxyw`. We also try a small
	 * set of known alternate signatures in case the symbol was renamed. If none
	 * is present we throw SignError (caller shows a Notice, no silent failure).
	 */
	async getSign(
		method: "GET" | "POST",
		uri: string,
		data: Record<string, unknown> | null,
	): Promise<RedNoteSign> {
		// Build a small, self-contained JS snippet that locates XHS's own
		// signing function and produces the four signed headers.
		//
		// ASSUMPTION (NEEDS_VERIFICATION): the page exposes a signing function
		// callable as fn(uri, data) returning { x-s, x-t, x-s-common,
		// x-b3-traceid } — the community-documented symbol is window._webmsxyw
		// (see MediaCrawler + community notes). We try a small set of likely
		// symbol names; if none yields a valid signature we throw SignError
		// (the caller shows a Notice — no silent failure), per the contract.
		// The exact call signature (and whether GET/POST differ) is not
		// confirmed without a logged-in XHS session and must be re-checked.
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
		const result = await this.eval<string | null>(code);
		const parsed = result ? JSON.parse(result) : null;
		if (!parsed || !parsed["X-S"] || !parsed["X-T"]) {
			throw new SignError(
				"无法在页面中定位小红书签名函数（window._webmsxyw 等），签名不可用。请重新打开登录窗口并确认页面完全加载后再同步。",
			);
		}
		return parsed;
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

		// Build the full URL. For GET, the query string must be encoded the same
		// way the sign was computed (browser behavior, commas not encoded) to
		// match MediaCrawler's _build_query_string.
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
				.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
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
		const raw = await this.eval<string>(code);
		const parsed = raw ? JSON.parse(raw) : null;
		if (!parsed) {
			throw new FetchError(`请求 ${uri} 无返回`);
		}

		const status = parsed.status as number;
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
	async checkLoginViaPage(): Promise<{ ok: boolean; info: string }> {
		const code = `(() => {
			const st = (window.__INITIAL_STATE__ || {});
			const user = st.user || {};
			const keys = Object.keys(user);
			const hasUserData = keys.length > 0 && JSON.stringify(user).length > 10;
			const cookieA1 = /(?:^|; )a1=/.test(document.cookie);
			return JSON.stringify({ hasUserData, userKeys: keys.slice(0, 6).join(","), cookieA1 });
		})()`;
		try {
			const raw = await this.eval<string>(code);
			const p = raw ? (JSON.parse(raw) as { hasUserData?: boolean; userKeys?: string; cookieA1?: boolean }) : null;
			if (!p) {
				return { ok: false, info: "页面探测无返回" };
			}
			const info = `页面侧 INITIAL_STATE.user=${p.userKeys || "无"}，a1=${p.cookieA1 ? "有" : "无"}`;
			return { ok: Boolean(p.hasUserData), info };
		} catch (e) {
			return { ok: false, info: `页面探测失败：${e instanceof Error ? e.message : String(e)}` };
		}
	}

	async checkLogin(): Promise<boolean> {
		// UNSIGNED first: a successful QR login was misreported as "not logged
		// in" because the signed path died at the (optional) page sign function
		// before the request was ever sent. selfinfo is cookie-only (pong).
		this.lastCheckInfo = null;
		let apiSaysNo = false;
		for (const unsigned of [true, false]) {
			try {
				const data = await this.request("GET", "/api/sns/web/v1/user/selfinfo", {}, { unsigned });
				const result = (data?.result ?? data) as Record<string, unknown> | undefined;
				// Tolerant response shapes: MediaCrawler documents
				// {data:{result:{success:true,...}}}; a 2026 variant may put the
				// user info directly under data without result.success.
				if (result?.success === true) {
					return true;
				}
				if (
					result?.success === undefined &&
					(result?.basic_info != null || result?.user_id != null)
				) {
					return true;
				}
				this.lastCheckInfo = "selfinfo 响应不含登录成功标记";
				apiSaysNo = true;
				break;
			} catch (e) {
				if (e instanceof NotLoggedInError) {
					// Ambiguous in 2026: unsigned selfinfo returns this same
					// envelope whether logged out OR merely unsigned. Confirm
					// with the page itself before believing it.
					apiSaysNo = true;
					this.lastCheckInfo = e.message;
					break;
				}
				this.lastCheckInfo = `selfinfo 请求失败（unsigned=${unsigned}）：${
					e instanceof Error ? e.message : String(e)
				}`;
				console.warn(
					`[pull-rednote] checkLogin attempt (unsigned=${unsigned}) failed:`,
					e instanceof Error ? e.message : e,
				);
			}
		}
		if (apiSaysNo) {
			const page = await this.checkLoginViaPage();
			if (page.ok) {
				this.lastCheckInfo = `接口未确认但页面已登录（${page.info}）`;
				return true;
			}
			this.lastCheckInfo = `${this.lastCheckInfo ?? ""}；${page.info}`;
		}
		return false;
	}

	/**
	 * Fetch the current user id (needed as the `user_id` for the collect list).
	 * Derived from selfinfo.
	 */
	async getSelfUserId(): Promise<string> {
		let data: Record<string, unknown>;
		try {
			data = await this.request("GET", "/api/sns/web/v1/user/selfinfo", {}, { unsigned: true });
		} catch {
			data = await this.request("GET", "/api/sns/web/v1/user/selfinfo", {});
		}
		const result = (data?.result ?? data) as Record<string, unknown> | undefined;
		const basic = (result?.basic_info ?? result) as Record<string, user_selfinfo> | undefined;
		const uid = basic?.user_id ?? (result as Record<string, unknown> | undefined)?.user_id;
		return typeof uid === "string" ? uid : "";
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
