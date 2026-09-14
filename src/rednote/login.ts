// Side-effect module: the embedded login Modal.
//
// The Modal MOVES the session's resident webview into the modal's content
// area (so the user can see the QR / password form) and then RESTORES it back
// into its hidden DOM container on close. Because the same webview element is
// reused (never re-created / removed), the browser session persists across
// login + sync. A poll loop watches login state while the modal is open and
// reports success.

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

	async onOpen(): Promise<void> {
		const contentEl = this.contentEl;
		contentEl.empty();
		contentEl.classList.add("rednote-login-modal");

		const wv = await this.session.ensureWebview();
		const container = wv.parentElement;

		// Move the webview into the modal so the user can interact with it.
		if (container) {
			contentEl.appendChild(container);
		}
		contentEl.style.minWidth = "520px";
		contentEl.style.minHeight = "700px";
		if (container) {
			container.style.display = "block";
			container.style.position = "static";
			container.style.left = "0";
			container.style.top = "0";
			container.style.width = "100%";
			container.style.height = "100%";
		}

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

		// Restore the webview container back to the hidden DOM slot so the
		// session survives the modal closing.
		const wv = this.session.getWebview();
		const container = wv?.parentElement;
		if (container) {
			container.style.display = "none";
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
