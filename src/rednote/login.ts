// Login page hosted in an Obsidian MODAL (the commercial plugin's host).
//
// Login webview scheme (aligned with the deobfuscated commercial plugin):
// every OPEN creates a FRESH <webview> element with the proven fixed inline
// style (width:100%; height:520px), mounts it DIRECTLY into the visible
// modal content, and every CLOSE destroys it. The element is never
// reparented and never parked offscreen — the guest attaches to an already
// visible, already correctly sized element, so the old "short strip" defect
// (guest viewport frozen at its attach-time size) cannot occur, and none of
// the old kick/reload/zoom workarounds exist here.
//
// Why a Modal (and not the previous workspace leaf): inside a leaf the same
// fixed-size webview rendered as a ~700x150 strip — the leaf's nested
// .workspace-leaf -> .view-content containment/overflow chain fights the
// inline size, while a plain Modal shows it full size (the commercial plugin
// hosts the identical scheme in a Modal with maxWidth 850px). The original
// reason to reject Modal — the reparent crash of a RESIDENT webview being
// moved in and out (Electron #38996/#38603) — does not apply to this scheme:
// the element is created fresh here and destroyed on close, never moved
// between parents.
//
// The SIGN webview (src/rednote/api.ts, ensureWebviewElement) is a separate,
// hidden, resident element marked data-pull-role="sign" sharing the same
// persist: partition. It never hosts the login UI. Login detection polls
// session.checkLogin(), whose partition cookie reads and page evals run
// against the sign webview, so a completed QR login up here is visible there
// immediately through the shared cookie store.

import { App, Modal, Notice } from "obsidian";
import { CHROME_UA, INDEX_URL, WEBVIEW_PARTITION, RedNoteSession } from "./api";

/** Padding (px) applied to the modal content element in onOpen. */
const CONTENT_PADDING_PX = 8;
/** Fixed login webview height (px) — 520: between the commercial plugin's 500 and our previous 560. */
const LOGIN_WEBVIEW_HEIGHT_PX = 520;
/** Modal content max width (px) — the commercial plugin's login modal cap. */
const LOGIN_MODAL_MAX_WIDTH_PX = 850;

export class RedNoteLoginModal extends Modal {
	private session: RedNoteSession;
	private onStateChange: () => void;
	/** Called from onClose so the plugin can clear its re-entry guard. */
	private onClosed: () => void;
	private statusEl: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	/** The fresh webview element created in onOpen, destroyed in onClose. */
	private wvEl: HTMLElement | null = null;
	private statusHandlers: Array<[string, EventListener]> = [];
	private watchdogTimer: number | null = null;
	private pollTimer: number | null = null;
	private pollFailures = 0;
	private finished = false;

	constructor(
		app: App,
		session: RedNoteSession,
		onStateChange: () => void,
		onClosed: () => void,
	) {
		super(app);
		this.session = session;
		this.onStateChange = onStateChange;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		// Modal width: the commercial plugin caps its login modal at 850px.
		contentEl.style.maxWidth = `${LOGIN_MODAL_MAX_WIDTH_PX}px`;
		contentEl.style.display = "flex";
		contentEl.style.flexDirection = "column";
		contentEl.style.padding = `${CONTENT_PADDING_PX}px`;

		this.statusEl = contentEl.createDiv();
		this.statusEl.style.cssText =
			"color:var(--text-muted,#888);font-size:12px;padding:0 0 6px 0;flex:none;" +
			"white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden;";
		this.statusEl.setText("正在加载小红书页面…");

		this.stageEl = contentEl.createDiv();
		this.stageEl.addClass("pull-rednote-login-stage");
		this.stageEl.style.cssText = "flex:1 1 auto;position:relative;min-height:200px;";

		// A FRESH element every open — NEVER the session's resident sign
		// webview and never a recycled one. Attributes follow the proven
		// order (useragent BEFORE partition, both BEFORE attach and src):
		// the webview is attribute-driven in this Electron build and plain
		// property assignment is never reflected (see ensureWebviewElement).
		const wv = document.createElement("webview");
		wv.setAttribute("useragent", CHROME_UA);
		wv.setAttribute("partition", WEBVIEW_PARTITION);
		// Role marker: keeps the session's partition-scoped reclaim query from
		// ever adopting THIS element as the sign webview (see api.ts).
		wv.setAttribute("data-pull-role", "login");
		// The commercial plugin's fixed sizing: a brand-new VISIBLE element at
		// a fixed height needs no kick/reload/zoom — the guest viewport is
		// correct from the very first attach.
		wv.style.cssText =
			`width:100%;height:${LOGIN_WEBVIEW_HEIGHT_PX}px;display:block;border:none;`;
		// Same element-level deny as the sign webview: our clean partition is
		// outside Obsidian's per-session permission sandbox.
		wv.addEventListener("permissionrequest", (e: Event) => {
			(e as Event & { preventDefault?: () => void }).preventDefault?.();
		});

		// Mount into the VISIBLE modal content first; only then start the
		// navigation, so the guest attaches at the final element size
		// (100% × 520px).
		this.stageEl.appendChild(wv);
		this.wvEl = wv;

		this.attachStatus(wv);
		wv.setAttribute("src", INDEX_URL);

		this.startPolling();
		// Warm the hidden sign webview (the eval target for checkLogin and the
		// page recorder) without touching the login element above.
		void this.session.ensureWebview();
	}

	onClose(): void {
		this.finished = true;
		this.stopPolling();
		this.clearWatchdog();
		this.detachStatus();
		// Destroy ONLY this modal's fresh webview element (the modal teardown
		// would remove it anyway; removing it here is explicit). The session's
		// hidden sign webview — and the login cookies in the shared partition —
		// stay untouched: there is no adopt/reclaim coupling to unwind.
		if (this.wvEl) {
			this.session.log("登录页关闭：销毁本次的登录 webview（签名 webview 不受影响）");
			this.wvEl.remove();
			this.wvEl = null;
		}
		// Let the plugin clear its re-entry guard (the modal is gone now).
		this.onClosed();
	}

	private setStatus(text: string): void {
		if (this.statusEl?.getText() === text) {
			return;
		}
		this.statusEl?.setText(text);
		this.clearWatchdog();
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer != null) {
			window.clearTimeout(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	/**
	 * Load-state listeners for THIS modal's webview only (status line). No page
	 * hooks here: the request recorder (fetch/XHR interception + warmup) is a
	 * duty of the SIGN webview and is installed through session.eval against
	 * it — kept as before on did-finish-load (idempotent).
	 */
	private attachStatus(wv: HTMLElement): void {
		this.detachStatus();
		const attach = (name: string, handler: EventListener): void => {
			wv.addEventListener(name, handler);
			this.statusHandlers.push([name, handler]);
		};
		attach("did-start-loading", () => this.setStatus("加载中…"));
		attach("dom-ready", () => this.setStatus("页面已加载 ✓"));
		attach("did-finish-load", () => {
			void this.session.installPageRecorder();
		});
		attach("did-stop-loading", () => this.setStatus("页面已加载 ✓"));
		attach("did-fail-load", (e: Event): void => {
			const ext = e as Event & { errorCode?: number; detail?: { errorCode?: number } };
			const code = ext.errorCode ?? ext.detail?.errorCode;
			this.setStatus(`⚠ 页面加载失败（code=${code ?? "?"}），请把此行反馈给开发者`);
		});
		attach("console-message", (e: Event): void => {
			const ext = e as Event & {
				level?: number;
				message?: string;
				detail?: { level?: number; message?: string };
			};
			const level = ext.level ?? ext.detail?.level;
			const msg = ext.message ?? ext.detail?.message ?? "";
			if (level === 3 || /error|failed|ERR_/i.test(msg)) {
				// XHS's own page emits unrelated errors (e.g. "ReferenceError:
				// wl is not defined"). Never clobber an already-successful
				// status; surface noise with an explicit ignorable prefix only.
				const current = this.statusEl?.textContent ?? "";
				if (current.startsWith("页面已加载 ✓") || current.startsWith("登录检测")) {
					console.log(`[pull-rednote] page console (页面噪音，可忽略): ${msg.slice(0, 120)}`);
					return;
				}
				this.setStatus(`页面噪音，可忽略：${msg.slice(0, 120)}`);
			}
		});
		this.watchdogTimer = window.setTimeout(() => {
			this.setStatus("⚠ 10 秒内页面仍未加载，webview 可能未启动，请把此行反馈给开发者");
		}, 10000);
	}

	private detachStatus(): void {
		for (const [name, handler] of this.statusHandlers) {
			this.wvEl?.removeEventListener(name, handler);
		}
		this.statusHandlers = [];
	}

	/**
	 * Unchanged login poll: session.checkLogin() reads the SHARED partition
	 * (its API call uses the partition cookie store and its page-probe evals
	 * run in the hidden sign webview), so a QR scan completed in the visible
	 * login webview is detected here without ever touching that element.
	 */
	private startPolling(): void {
		this.stopPolling();
		this.pollFailures = 0;
		const check = async (): Promise<void> => {
			if (this.finished) {
				return;
			}
			try {
				const ok = await this.session.checkLogin();
				if (ok) {
					this.finished = true;
					this.stopPolling();
					new Notice("小红书登录成功");
					this.onStateChange();
					return;
				}
				this.pollFailures += 1;
				if (this.pollFailures % 3 === 1) {
					this.setStatus(
						`页面已加载，登录检测未通过：${this.session.lastCheckInfo ?? "未知原因"}`,
					);
				}
			} catch (e) {
				console.warn(
					"[pull-rednote] login poll failed:",
					e instanceof Error ? e.message : e,
				);
			}
			this.pollTimer = window.setTimeout(check, 4000);
		};
		this.pollTimer = window.setTimeout(check, 4000);
	}

	private stopPolling(): void {
		if (this.pollTimer != null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}
}
