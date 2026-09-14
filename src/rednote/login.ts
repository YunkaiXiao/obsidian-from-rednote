// Self-managed persistent login overlay (NOT an Obsidian Modal).
//
// Rationale (ADR-012): Electron has a documented crash class where moving or
// removing a live <webview> inside a close callback crashes the HOST process
// (0x80000003 APPCRASH — observed 3x on Obsidian 1.13.7 when our old
// Modal-based login reparented the webview container in onClose; matches
// Electron fixed issues #38996 / #38603). Surfing — the community reference
// for embedding pages in Obsidian — never hosts webviews in Modals and never
// reparents live webview nodes.
//
// Therefore this login "window" is a plain div attached to document.body for
// the WHOLE plugin lifetime. Open/close only toggles visibility CSS: the DOM
// structure never changes and the webview is never reparented or removed
// (until plugin unload). Hiding uses visibility:hidden (NOT display:none,
// which collapses the Electron guest layout — see the earlier white screen).

import { Notice } from "obsidian";
import { RedNoteSession } from "./api";

export class RedNoteLoginOverlay {
	private session: RedNoteSession;
	private onResult: (logged: boolean) => void;
	private root: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private statusHandlers: Array<[string, EventListener]> = [];
	private watchdogTimer: number | null = null;
	private pollTimer: number | null = null;
	private finished = false;
	/** Stage size in integer pixels (JS-computed; no CSS min()/vw/vh so nothing
	 * depends on CSS math resolution inside the webview chain). */
	private stageSize = { w: 480, h: 640 };

	constructor(session: RedNoteSession, onResult: (logged: boolean) => void) {
		this.session = session;
		this.onResult = onResult;
	}

	/** Show the login window (idempotent; builds the DOM exactly once). */
	show(): void {
		if (!this.root) {
			this.build();
		}
		this.finished = false;
		this.applySize();
		(this.root as HTMLElement).style.visibility = "visible";
		// The page may have loaded while the overlay was hidden; Chromium skips
		// compositing for invisible subtrees, so the guest viewport can be stuck
		// at a stale tiny size (page rendered as a thin scrollable strip).
		// Force a guest viewport re-sync every time we become visible.
		this.kickGuestResize();
		this.attachStatus();
		this.startPolling();
		// Kick off / await the page load (no-op when already loaded).
		void this.session.ensureWebview();
	}

	hide(): void {
		if (this.root) {
			this.root.style.visibility = "hidden";
		}
		this.stopPolling();
		this.clearWatchdog();
		this.detachStatus();
		// Report final login state (async; failures read as "not logged in").
		void this.session
			.checkLogin()
			.then((logged) => this.onResult(logged))
			.catch(() => this.onResult(false));
	}

	/** Remove the overlay from the DOM. Plugin-unload only. */
	dispose(): void {
		this.stopPolling();
		this.clearWatchdog();
		this.detachStatus();
		this.root?.remove();
		this.root = null;
		this.statusEl = null;
	}

	private build(): void {
		const root = document.body.createDiv();
		root.style.cssText =
			"position:fixed;left:0;top:0;width:100vw;height:100vh;" +
			"visibility:hidden;z-index:var(--layer-modal,999);";
		// Click on the dark backdrop closes the window (same UX as a modal).
		root.addEventListener("click", (e: MouseEvent) => {
			if (e.target === root) {
				this.hide();
			}
		});

		const card = root.createDiv();
		// Near-full-window card: the XHS login layout needs the space, and a
		// wide viewport also makes XHS serve its proper desktop layout.
		card.style.cssText =
			"position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);" +
			"width:calc(100vw - 24px);height:calc(100vh - 24px);" +
			"background:var(--background-primary,#fff);" +
			"border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.45);padding:12px;";
		card.addEventListener("click", (e: MouseEvent) => e.stopPropagation());

		const titlebar = card.createDiv();
		titlebar.style.cssText =
			"display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";
		const title = titlebar.createEl("span");
		title.setText("小红书登录");
		title.style.cssText = "font-weight:600;";
		const closeBtn = titlebar.createEl("button");
		closeBtn.setText("关闭");
		closeBtn.addEventListener("click", () => this.hide());

		this.statusEl = card.createDiv();
		this.statusEl.style.cssText =
			"color:var(--text-muted,#888);font-size:12px;padding:0 0 6px 0;";
		this.statusEl.setText("正在加载小红书页面…");

		const stage = card.createDiv();
		stage.style.position = "relative";
		this.stageEl = stage;

		// The webview container moves into the stage ONCE, here at build time —
		// never again on open/close. Its parent chain (body > root > card >
		// stage) lives for the plugin's whole lifetime.
		const wv = this.session.ensureWebviewElement();
		const container = wv.parentElement as HTMLElement;
		stage.appendChild(container);
		container.style.position = "static";
		container.style.left = "0";
		container.style.top = "0";
		container.style.width = "100%";
		container.style.height = "100%";
		// Sizing is applied by applySize()/kickGuestResize() in integer px.
		// Electron webviews collapse with percent-only sizing, and CSS min()
		// here adds nothing but resolution variables — see kickGuestResize for
		// the guest-viewport sync problem.

		this.root = root;
	}

	/** Compute the stage size from the current window and apply it in px.
	 * Near-full-window: only the title bar, status line and card padding are
	 * reserved. */
	private applySize(): void {
		this.stageSize = {
			w: Math.max(320, window.innerWidth - 48),
			h: Math.max(360, window.innerHeight - 110),
		};
		if (this.stageEl) {
			this.stageEl.style.width = `${this.stageSize.w}px`;
			this.stageEl.style.height = `${this.stageSize.h}px`;
		}
	}

	/**
	 * Force the Electron guest to re-sync its viewport to the element size.
	 * A page loaded while the overlay was visibility:hidden gets a stale tiny
	 * guest viewport (rendered as a thin scrollable strip); toggling the
	 * element height by a few px makes Chromium push a real resize to the
	 * guest process. Called on every show() and after dom-ready.
	 */
	private kickGuestResize(): void {
		const wv = this.session.getWebview();
		if (!wv) {
			return;
		}
		const { w, h } = this.stageSize;
		wv.style.width = `${w}px`;
		wv.style.height = `${Math.max(0, h - 4)}px`;
		window.setTimeout(() => {
			wv.style.height = `${h}px`;
			// Zoom AFTER the guest attached (setZoomFactor before load is
			// silently ignored by Electron). 0.8 buys ~25% extra page space for
			// the centered, non-scrolling XHS login dialog.
			wv.setZoomFactor?.(0.8);
		}, 60);
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
		this.clearWatchdog();
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer != null) {
			window.clearTimeout(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	/** Wire the webview load lifecycle into the visible status line. */
	private attachStatus(): void {
		this.detachStatus();
		const wv = this.session.getWebview();
		if (!wv) {
			return;
		}
		const attach = (name: string, handler: EventListener): void => {
			wv.addEventListener(name, handler);
			this.statusHandlers.push([name, handler]);
		};
		attach("did-start-loading", () => this.setStatus("加载中…"));
		attach("dom-ready", () => {
			this.setStatus("页面已加载 ✓");
			// Guest just (re)attached — its viewport may be stale. Re-sync.
			this.kickGuestResize();
		});
		attach("did-stop-loading", () => this.setStatus("页面已加载 ✓"));
		attach("did-fail-load", (e: Event): void => {
			const ext = e as Event & { errorCode?: number; detail?: { errorCode?: number } };
			const code = ext.errorCode ?? ext.detail?.errorCode;
			this.setStatus(`⚠ 页面加载失败（code=${code ?? "?"}），请把此行反馈给开发者`);
		});
		// Surface guest-page errors (e.g. the QR endpoint failing) so they are
		// diagnosable without DevTools.
		attach("console-message", (e: Event): void => {
			const ext = e as Event & {
				level?: number;
				message?: string;
				detail?: { level?: number; message?: string };
			};
			const level = ext.level ?? ext.detail?.level;
			const msg = ext.message ?? ext.detail?.message ?? "";
			if (level === 3 || /error|failed|ERR_/i.test(msg)) {
				this.setStatus(`⚠ 页面报错：${msg.slice(0, 120)}`);
			}
		});
		this.watchdogTimer = window.setTimeout(() => {
			this.setStatus("⚠ 10 秒内页面仍未加载，webview 可能未启动，请把此行反馈给开发者");
		}, 10000);
	}

	private detachStatus(): void {
		const wv = this.session.getWebview();
		if (wv) {
			for (const [name, handler] of this.statusHandlers) {
				wv.removeEventListener(name, handler);
			}
		}
		this.statusHandlers = [];
	}

	/** Poll for login success while the window is visible. */
	private startPolling(): void {
		this.stopPolling();
		const check = async (): Promise<void> => {
			if (this.finished || !this.root || this.root.style.visibility === "hidden") {
				return;
			}
			try {
				const ok = await this.session.checkLogin();
				if (ok) {
					this.finished = true;
					this.stopPolling();
					new Notice("小红书登录成功");
					// Brief confirmation, then close (visibility only — no DOM change).
					window.setTimeout(() => this.hide(), 800);
					return;
				}
			} catch (e) {
				// A signing/network hiccup while polling must not stop the
				// poller — but log it so the failure reason is diagnosable.
				console.warn(
					"[pull-rednote] login poll failed:",
					e instanceof Error ? e.message : e,
				);
			}
			this.pollTimer = window.setTimeout(check, 2000);
		};
		this.pollTimer = window.setTimeout(check, 2000);
	}

	private stopPolling(): void {
		if (this.pollTimer != null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}
}
