// Side-effect module: the embedded login Modal.
//
// The Modal MOVES the session's resident webview into the modal's content
// area (so the user can see the QR / password form) and then RESTORES it on
// close by RE-parenting its container back to document.body and parking it
// offscreen there (position:fixed). Reparenting back is mandatory: Obsidian
// may detach the modal DOM after onClose, and a webview left inside it would
// be torn down with it, dropping the browser session. Because the same
// webview element is reused (never re-created / removed), the session
// persists across login + sync. A poll loop watches login state while the
// modal is open and reports success.

import { Modal, Notice } from "obsidian";
import { RedNoteSession } from "./api";

export class RedNoteLoginModal extends Modal {
	private session: RedNoteSession;
	private onResult: (logged: boolean) => void;
	private pollTimer: number | null = null;
	private finished = false;
	/** Load-status wiring (visible line in the modal + cleanup on close). */
	private statusHandlers: Array<[string, EventListener]> = [];
	private watchdogTimer: number | null = null;

	/**
	 * @param app       Obsidian app.
	 * @param session   The shared resident-webview session.
	 * @param onResult  Called when login is confirmed or the modal closes.
	 */
	constructor(app: import("obsidian").App, session: RedNoteSession, onResult: (logged: boolean) => void) {
		super(app);
		this.session = session;
		this.onResult = onResult;
	}

	onOpen(): void {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.classList.add("rednote-login-modal");

		// CRITICAL (white-screen fix): create/mount the webview SYNCHRONOUSLY,
		// before any await, so the modal immediately shows a sized box. The
		// previous code did `await session.ensureWebview()` first, which waits
		// for the XHS homepage to finish loading (up to a 30s safety cap) and
		// left the freshly opened modal completely blank in the meantime.
		const wv = this.session.ensureWebviewElement();
		const container = wv.parentElement;

		// Visible load status so a failure is diagnosable WITHOUT DevTools.
		const status = contentEl.createDiv();
		status.style.cssText =
			"color:var(--text-muted);font-size:12px;padding:0 0 6px 0;";
		status.setText("正在加载小红书页面…");
		const setStatus = (text: string) => {
			status.setText(text);
			if (this.watchdogTimer != null) {
				window.clearTimeout(this.watchdogTimer);
				this.watchdogTimer = null;
			}
		};
		const onFail = (e: Event): void => {
			const ext = e as Event & { errorCode?: number; detail?: { errorCode?: number } };
			const code = ext.errorCode ?? ext.detail?.errorCode;
			setStatus(`⚠ 页面加载失败（code=${code ?? "?"}），请把此行反馈给开发者`);
		};
		const attach = (name: string, handler: EventListener): void => {
			wv.addEventListener(name, handler);
			this.statusHandlers.push([name, handler]);
		};
		attach("did-start-loading", () => setStatus("加载中…"));
		attach("dom-ready", () => setStatus("页面已加载 ✓"));
		attach("did-stop-loading", () => setStatus("页面已加载 ✓"));
		attach("did-fail-load", onFail);
		// Surface guest-page errors (e.g. QR endpoint failures) in the status
		// line so they are diagnosable without opening DevTools.
		attach("console-message", (e: Event): void => {
			const ext = e as Event & {
				level?: number;
				message?: string;
				detail?: { level?: number; message?: string };
			};
			const level = ext.level ?? ext.detail?.level;
			const msg = ext.message ?? ext.detail?.message ?? "";
			if (level === 3 || /error|failed|ERR_/i.test(msg)) {
				setStatus(`⚠ 页面报错：${msg.slice(0, 120)}`);
			}
		});
		this.watchdogTimer = window.setTimeout(() => {
			status.setText("⚠ 10 秒内页面仍未加载，webview 可能未启动，请把此行反馈给开发者");
		}, 10000);

		// Explicit modal size: the webview itself has fixed px size (480x640,
		// see ensureWebviewElement); give contentEl a definite height too, so
		// the container's percentage sizes resolve instead of collapsing to 0.
		// Adaptive modal size: big enough for the XHS login page, but capped by
		// the Obsidian window so the QR area is never cropped in small windows.
		contentEl.style.width = "min(540px, 90vw)";
		contentEl.style.height = "min(720px, 80vh)";
		contentEl.style.minWidth = "min(540px, 90vw)";
		contentEl.style.minHeight = "min(720px, 80vh)";

		// Move the webview into the modal so the user can interact with it,
		// and CLEAR the offscreen parking styles from the move-in path.
		if (container) {
			contentEl.appendChild(container);
			container.style.display = "block";
			container.style.position = "static";
			container.style.left = "0";
			container.style.top = "0";
			container.style.width = "100%";
			container.style.height = "100%";
		}

		// Kick off the page load (no-op if already loading/loaded). Not awaited:
		// the user watches the page load live and the poll loop below detects
		// the login regardless.
		void this.session.ensureWebview();

		// Poll for login success while the modal is open.
		this.startPolling();
	}

	private async startPolling(): Promise<void> {
		// Stop any previous poller.
		this.stopPolling();
		const check = async (): Promise<void> => {
			if (this.finished) return;
			try {
				const ok = await this.session.checkLogin();
				if (ok) {
					this.finished = true;
					this.stopPolling();
					new Notice("小红书登录成功");
					// Give the user a brief moment to see the confirmation,
					// then close and restore the webview to its hidden slot.
					window.setTimeout(() => {
						this.onResult(true);
						this.close();
					}, 800);
					return;
				}
			} catch {
				// A signing/network hiccup while polling should not stop the
				// poller; keep trying.
			}
			if (!this.finished) {
				this.pollTimer = window.setTimeout(check, 2000);
			}
		};
		this.pollTimer = window.setTimeout(check, 2000);
	}

	private stopPolling(): void {
		if (this.pollTimer != null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	onClose(): void {
		this.finished = true;
		this.stopPolling();
		if (this.watchdogTimer != null) {
			window.clearTimeout(this.watchdogTimer);
			this.watchdogTimer = null;
		}
		const wvForStatus = this.session.getWebview();
		if (wvForStatus) {
			for (const [name, handler] of this.statusHandlers) {
				wvForStatus.removeEventListener(name, handler);
			}
		}
		this.statusHandlers = [];

		// Restore the webview: RE-parent its container back to document.body
		// FIRST, then park it offscreen there. Obsidian may detach the modal
		// DOM after onClose; a webview left inside the modal would be
		// destroyed with it, dropping the session (violating RedNoteSession's
		// "never removed from the DOM" contract). appendChild to body is safe
		// in both cases — whether or not the framework later detaches the
		// modal subtree, the container now lives directly under body. It is
		// also idempotent (re-appending an already-parked container is a
		// no-op move within body). Keep it RENDERED offscreen (position:fixed)
		// — never display:none, which zeroes the Electron guest view layout
		// and caused the login white screen.
		const wv = this.session.getWebview();
		const container = wv?.parentElement;
		if (container) {
			document.body.appendChild(container);
			container.style.display = "block";
			container.style.position = "fixed";
			container.style.left = "-99999px";
			container.style.top = "0";
			container.style.width = "1200px";
			container.style.height = "800px";
		}

		// Report final state (login may already have been confirmed).
		void this.session.checkLogin().then((logged) => {
			this.onResult(logged);
		}).catch(() => {
			this.onResult(false);
		});
	}
}
