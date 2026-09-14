// Login page hosted in a WORKSPACE LEAF (ItemView) — the Surfing-proven host.
//
// Rationale (ADR-013): every self-managed container we tried (Modal with
// reparent, body overlay with visibility/display toggles) eventually hit an
// Electron webview lifecycle crash — webviews are fragile under custom DOM
// surgery, and Electron itself documents crashes for close-callback removals
// and reparenting. A workspace leaf hands the ENTIRE lifecycle to Obsidian:
// we write zero close/destroy code, the user closes it like any tab, and the
// reference implementation (PKM-er/Obsidian-Surfing) hosts its webviews the
// same way. Closing the leaf destroys the webview element — that is FINE:
// the login session lives in the persist: partition on disk, and the session
// lazily recreates the webview (parked offscreen) for signed sync requests
// without any re-login.

import { ItemView, Notice } from "obsidian";
import { RedNoteSession } from "./api";

export const LOGIN_LEAF_VIEW_TYPE = "pull-rednote-login";

export class RedNoteLoginView extends ItemView {
	private session: RedNoteSession;
	private onStateChange: () => void;
	private statusEl: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	private statusHandlers: Array<[string, EventListener]> = [];
	private watchdogTimer: number | null = null;
	private pollTimer: number | null = null;
	private pollFailures = 0;
	private finished = false;
	private stageSize = { w: 480, h: 640 };

	constructor(
		leaf: import("obsidian").WorkspaceLeaf,
		session: RedNoteSession,
		onStateChange: () => void,
	) {
		super(leaf);
		this.session = session;
		this.onStateChange = onStateChange;
	}

	getViewType(): string {
		return LOGIN_LEAF_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "小红书登录";
	}

	getIcon(): string {
		return "bookmark";
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.style.display = "flex";
		contentEl.style.flexDirection = "column";
		contentEl.style.padding = "8px";

		this.statusEl = contentEl.createDiv();
		this.statusEl.style.cssText =
			"color:var(--text-muted,#888);font-size:12px;padding:0 0 6px 0;flex:none;";
		this.statusEl.setText("正在加载小红书页面…");

		this.stageEl = contentEl.createDiv();
		this.stageEl.style.cssText = "flex:1 1 auto;position:relative;min-height:200px;";

		// The webview container moves into the leaf ONCE, here. The leaf's DOM
		// is owned by Obsidian for its whole lifetime — we never move or hide
		// the webview ourselves.
		const wv = this.session.ensureWebviewElement();
		const container = wv.parentElement as HTMLElement;
		this.stageEl.appendChild(container);
		container.style.position = "static";
		container.style.left = "0";
		container.style.top = "0";
		container.style.width = "100%";
		container.style.height = "100%";

		// Leaf layout settles asynchronously (and re-settles on popout/resize).
		// A single 50ms probe measured a pre-layout box and left the webview at
		// its default ~480px size in the corner of a large leaf. Retry on
		// several early ticks and on every workspace resize (onResize below).
		for (const delay of [50, 200, 600, 1500]) {
			window.setTimeout(() => {
				this.applySize();
				this.kickGuestResize();
			}, delay);
		}

		this.attachStatus();
		this.startPolling();
		void this.session.ensureWebview();
	}

	/** Workspace calls this whenever the leaf (or its popout window) resizes. */
	onResize(): void {
		this.applySize();
		this.kickGuestResize();
	}

	async onClose(): Promise<void> {
		// Stop our timers/listeners only. The webview element is destroyed
		// together with the leaf DOM by Obsidian itself (the Surfing pattern);
		// the session notices via the "destroyed" listener and lazily recreates
		// a parked webview for later signed requests — no re-login needed.
		this.finished = true;
		this.stopPolling();
		this.clearWatchdog();
		this.detachStatus();
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

	/** Size the webview in integer px from the leaf's real layout box. */
	private applySize(): void {
		const wv = this.session.getWebview();
		if (!wv || !this.stageEl) {
			return;
		}
		const box = this.stageEl.getBoundingClientRect();
		if (box.width > 40 && box.height > 40) {
			this.stageSize = {
				w: Math.floor(box.width),
				h: Math.floor(box.height),
			};
		}
		wv.style.width = `${this.stageSize.w}px`;
		wv.style.height = `${this.stageSize.h}px`;
	}

	/**
	 * Force the Electron guest to re-sync its viewport to the element size
	 * (pages that loaded under a non-visible host keep a stale tiny viewport),
	 * then zoom out slightly so the centered, non-scrolling XHS login dialog
	 * fits even shorter leaves.
	 */
	private kickGuestResize(): void {
		const wv = this.session.getWebview();
		if (!wv) {
			return;
		}
		const { w, h } = this.stageSize;
		wv.style.display = "none";
		wv.style.width = `${w}px`;
		wv.style.height = `${h}px`;
		window.setTimeout(() => {
			wv.style.display = "block";
			window.setTimeout(() => {
				const rect = wv.getBoundingClientRect();
				if (rect.height < h - 20) {
					this.setStatus(
						`⚠ webview 元素仅 ${Math.round(rect.height)}px（目标 ${h}px），请反馈此行`,
					);
				}
				wv.setZoomFactor?.(0.8);
			}, 60);
		}, 30);
	}

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
			this.kickGuestResize();
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
