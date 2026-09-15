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

/** Padding (px) applied to the leaf content element in onOpen. */
const CONTENT_PADDING_PX = 8;
/** Fallback status-line height (px) if the real box is not measurable yet. */
const STATUS_LINE_HEIGHT_PX = 28;

export class RedNoteLoginView extends ItemView {
	private session: RedNoteSession;
	private onStateChange: () => void;
	private statusEl: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	/** The webview element actually staged in this leaf (may differ from the
	 * session's current one after a lazy recreation — see the poller). */
	private wvEl: HTMLElement | null = null;
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
		contentEl.style.padding = `${CONTENT_PADDING_PX}px`;

		this.statusEl = contentEl.createDiv();
		this.statusEl.style.cssText =
			"color:var(--text-muted,#888);font-size:12px;padding:0 0 6px 0;flex:none;" +
			"white-space:pre-wrap;word-break:break-all;max-height:72px;overflow:hidden;";
		this.statusEl.setText("正在加载小红书页面…");

		this.stageEl = contentEl.createDiv();
		this.stageEl.addClass("pull-rednote-login-stage");
		this.stageEl.style.cssText = "flex:1 1 auto;position:relative;min-height:200px;";

		// The webview container moves into the leaf ONCE, here. The leaf's DOM
		// is owned by Obsidian for its whole lifetime — we never move or hide
		// the webview ourselves.
		const wv = this.session.ensureWebviewElement();
		const container = wv.parentElement as HTMLElement;
		this.stageEl.appendChild(container);
		this.wvEl = wv;
		// Clear the offscreen PARKING styles the session set when it created
		// the container (position:fixed; left:-99999px; 1200x800). Inline
		// styles beat every class rule, so leaving them in place would keep
		// the login page invisible / mis-sized inside the leaf. applySize()
		// writes real px width/height below.
		container.style.position = "static";
		container.style.left = "auto";
		container.style.top = "auto";
		container.style.width = "";
		container.style.height = "";
		container.addClass("pull-rednote-login-container");
		wv.addClass("pull-rednote-login-webview");

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

	/**
	 * Size the webview in integer px from the leaf's REAL layout box
	 * (this.contentEl — not the stage, whose own box can be collapsed by CSS).
	 * Height = content box minus the status line. The result is written as
	 * inline px to all three layers (stage, container, webview) so no CSS
	 * rule can shrink the visible page to a thin strip.
	 */
	/** The webview element actually inside this leaf's stage (preferred), or
	 * the session's current one. Sizing the staged element matters: after a
	 * lazy recreation the session's current webview may be a DIFFERENT
	 * (parked, invisible) element while the leaf still shows the old one. */
	private stagedWebview(): (HTMLElement & { setZoomFactor?: (f: number) => void }) | null {
		const inStage = this.stageEl?.querySelector("webview") as
			| (HTMLElement & { setZoomFactor?: (f: number) => void })
			| null;
		return inStage ?? this.session.getWebview();
	}

	/** Compute the stage size from the leaf's REAL layout box (contentEl) and
	 * apply it as inline px to the staged webview's three layers. */
	private applySize(): void {
		const wv = this.stagedWebview();
		if (!wv || !this.stageEl) {
			return;
		}
		const box = this.contentEl.getBoundingClientRect();
		const statusBox = this.statusEl?.getBoundingClientRect();
		const statusH = Math.ceil(statusBox?.height ?? STATUS_LINE_HEIGHT_PX) || STATUS_LINE_HEIGHT_PX;
		const w = Math.floor(box.width) - CONTENT_PADDING_PX * 2;
		const h = Math.floor(box.height) - CONTENT_PADDING_PX * 2 - statusH;
		// Adopt the measurement only when it is a plausible box; otherwise keep
		// the last known good (or default) size.
		if (w > 40 && h > 40) {
			this.stageSize = { w, h };
		}
		const { w: sw, h: sh } = this.stageSize;
		this.stageEl.style.width = `${sw}px`;
		this.stageEl.style.height = `${sh}px`;
		const container = wv.parentElement;
		if (container) {
			container.style.width = `${sw}px`;
			container.style.height = `${sh}px`;
		}
		wv.style.width = `${sw}px`;
		wv.style.height = `${sh}px`;
	}

	/**
	 * Force the Electron guest to re-sync its viewport to the element size
	 * (pages that loaded under a non-visible host keep a stale tiny viewport),
	 * then zoom out slightly so the centered, non-scrolling XHS login dialog
	 * fits even shorter leaves.
	 */
	private kickGuestResize(): void {
		const wv = this.stagedWebview();
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
						const stage = this.stageEl?.getBoundingClientRect();
						this.setStatus(
							`⚠ 尺寸异常：元素${Math.round(rect.width)}×${Math.round(rect.height)}` +
								` 舞台${stage ? `${Math.round(stage.width)}×${Math.round(stage.height)}` : "?"}` +
								` 目标${w}×${h}，请反馈此行`,
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
		this.adoptRecreatedWebview();
		// Re-measure every cycle: the leaf layout box may only become valid
		// after popout/activation/tab shuffling that fires no resize event.
		this.applySize();
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
					const census = this.domCensus();
					this.setStatus(
						`页面已加载，登录检测未通过：${this.session.lastCheckInfo ?? "未知原因"}｜${census}`,
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

	/** If the session lazily recreated its webview (the staged one died), swap
	 * the stage over to the live element so the user sees the real page. */
	private adoptRecreatedWebview(): void {
		const cur = this.session.getWebview();
		if (!cur || !this.stageEl || cur === this.wvEl) {
			return;
		}
		const container = cur.parentElement as HTMLElement | null;
		if (!container) {
			return;
		}
		this.stageEl.empty();
		this.stageEl.appendChild(container);
		container.style.position = "static";
		container.style.left = "auto";
		container.style.top = "auto";
		container.style.width = "";
		container.style.height = "";
		container.addClass("pull-rednote-login-container");
		cur.addClass("pull-rednote-login-webview");
		this.wvEl = cur;
		this.attachStatus();
		this.applySize();
		this.kickGuestResize();
	}

	/** Host-side webview census for the status line: how many <webview>
	 * elements exist, how big each renders, and the measured contentEl box
	 * (so a failing layout measurement is visible at a glance). */
	private domCensus(): string {
		const els = Array.from(document.querySelectorAll("webview"));
		const rects = els.map((el) => {
			const r = el.getBoundingClientRect();
			return `${Math.round(r.width)}×${Math.round(r.height)}`;
		});
		const box = this.contentEl.getBoundingClientRect();
		return `DOM webview×${els.length}[${rects.join(", ")}] 盒${Math.round(box.width)}×${Math.round(box.height)}`;
	}

	private stopPolling(): void {
		if (this.pollTimer != null) {
			window.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}
}
