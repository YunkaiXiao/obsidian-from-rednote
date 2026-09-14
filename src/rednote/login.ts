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

		// Explicit modal size: the webview itself has fixed px size (480x640,
		// see ensureWebviewElement); give contentEl a definite height too, so
		// the container's percentage sizes resolve instead of collapsing to 0.
		contentEl.style.width = "540px";
		contentEl.style.height = "720px";
		contentEl.style.minWidth = "540px";
		contentEl.style.minHeight = "720px";

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
