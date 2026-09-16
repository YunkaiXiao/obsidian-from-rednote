// RedNote Sync — Obsidian plugin entry (M2: 登录 → 取数 → Markdown → 写入 vault).
//
// This file is the plugin entry: lifecycle (onload/onunload), the command &
// ribbon, and the settings tab. All business logic lives in src/rednote/
// (pure: types / filename / pagination / markdown / extract; side-effect:
// api / login / sync).

import { App, Notice, Plugin, PluginSettingTab, Setting, ToggleComponent, TextComponent } from "obsidian";

import { RedNoteSession, cleanPartitionStatus } from "./src/rednote/api";
import { NotLoggedInError, SignError } from "./src/rednote/types";
import { syncFavorites, makeSummaryNotice } from "./src/rednote/sync";
import { RedNoteLoginView, LOGIN_LEAF_VIEW_TYPE } from "./src/rednote/login";
import { epochToIso } from "./src/rednote/markdown";
import {
	evaluateRateLimit,
	normalizeRateLimitState,
	parseRateLimitConfig,
	recordProcessed,
	type RateLimitState,
} from "./src/rednote/ratelimit";

export interface RedNoteSyncSettings {
	loginStatus: boolean;
	aiEnabled: boolean;
	aiBaseUrl: string;
	aiApiKey: string;
	aiModel: string;
	tagPrefix: string;
	notesFolder: string;
	mediaFolder: string;
	/** note_ids already synced (M2 dedup; full content-hash incremental is M3). */
	syncedNoteIds: string[];
	/** ISO 8601 of the last successful sync. */
	lastSyncAt: string;
	/** Rate limit (feature #14): max notes processed per window. */
	rateLimitMaxNotes: number;
	/** Rate limit: window length in minutes. */
	rateLimitWindowMinutes: number;
	/** Rate limit: persisted window budget state (survives restarts). */
	rateLimitState: RateLimitState | null;
}

const DEFAULT_SETTINGS: RedNoteSyncSettings = {
	loginStatus: false,
	aiEnabled: false,
	aiBaseUrl: "",
	aiApiKey: "",
	aiModel: "",
	tagPrefix: "xhs/",
	notesFolder: "RedNote/Bookmarks",
	mediaFolder: "RedNote/Media",
	syncedNoteIds: [],
	lastSyncAt: "",
	rateLimitMaxNotes: 20,
	rateLimitWindowMinutes: 10,
	rateLimitState: null,
};

/** XHS publish/collect times are rendered in +08:00 (see extract.ts). */
const XHS_UTC_OFFSET_MIN = 8 * 60;

export default class RedNoteSyncPlugin extends Plugin {
	settings: RedNoteSyncSettings = { ...DEFAULT_SETTINGS };
	/** Shared webview session (used by the settings tab's logout button). */
	readonly session = new RedNoteSession();
	private syncing = false;
	/** Guard against re-entrant login modals fighting over one resident webview. */
	/** Live settings tab reference so login-state changes can re-render it. */
	private settingTab: RedNoteSyncSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Debug log -> <pluginDir>/debug.log (auto-rotates past ~300KB), so
		// diagnosis no longer requires screenshots of the status line.
		// Written via direct fs: the vault adapter silently failed to persist
		// writes under .obsidian (file got created empty).
		const vaultRoot = (
			this.app.vault.adapter as unknown as { basePath?: string }
		).basePath;
		const reqFs = (window as unknown as { require?: (m: string) => unknown }).require;
		if (vaultRoot && reqFs) {
			try {
				const fs = reqFs("fs") as typeof import("fs");
				const logPath = `${vaultRoot}/${this.manifest.dir}/debug.log`;
				this.session.logger = (line: string): void => {
					try {
						const size = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
						if (size > 300_000) {
							fs.writeFileSync(logPath, `${line}\n`);
						} else {
							fs.appendFileSync(logPath, `${line}\n`);
						}
					} catch {
						/* best effort only */
					}
				};
				this.session.log("插件加载，调试日志已启用（fs 直写）");
		this.session.log(`分区拦截状态：${cleanPartitionStatus.value}`);
			} catch (e) {
				console.warn("[pull-rednote] fs logger init failed:", e);
			}
		}

		this.settingTab = new RedNoteSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.addRibbonIcon("bookmark", "Pull Rednote", () => {
			void this.runSync();
		});

		this.addCommand({
			id: "sync-rednote-favorites",
			name: "Pull Rednote：同步收藏笔记",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "rednote-open-login",
			name: "Pull Rednote：打开登录窗口",
			callback: () => {
				this.openLogin();
			},
		});
	}

	onunload(): void {
		// The login leaf (if open) is owned and disposed by the workspace.
		// Tear down the resident/parked webview session last.
		this.session.destroy();
	}

	/** Persist settings to data.json. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/** Open the login page in a workspace leaf (tab) and keep the session. */
	openLogin(): void {
		// ADR-013: the login page lives in an ItemView — Obsidian owns its whole
		// lifecycle (we write no close/destroy code). The tab can be popped out
		// into its own window and resized freely. Closing it destroys the
		// webview element, which is fine: the login session persists in the
		// partition and is lazily recreated for signed sync requests.
		const existing = this.app.workspace.getLeavesOfType(LOGIN_LEAF_VIEW_TYPE);
		const openLeaf = existing.length > 0 ? existing[0] : undefined;
		if (openLeaf) {
			this.app.workspace.setActiveLeaf(openLeaf);
			return;
		}
		const leaf = this.app.workspace.getLeaf(true);
		const view = new RedNoteLoginView(leaf, this.session, () => {
			void this.updateLoginState(true);
		});
		leaf.open(view);
		this.app.workspace.setActiveLeaf(leaf);
	}

	/**
	 * Update + persist login state, then (re)verify against the v2/user/me API
	 * so the stored flag reflects reality rather than a stale UI signal.
	 */
	async updateLoginState(logged: boolean): Promise<void> {
		if (logged) {
			try {
				const ok = await this.session.checkLogin();
				this.settings.loginStatus = ok;
			} catch {
				this.settings.loginStatus = false;
			}
		} else {
			this.settings.loginStatus = false;
		}
		await this.saveSettings();
		// Re-render the settings tab (deferred out of whatever callback stack
		// we are in) so the visible login state updates immediately.
		window.setTimeout(() => this.settingTab?.display(), 0);
	}

	/** The core sync command (M2). */
	async runSync(): Promise<void> {
		if (this.syncing) {
			new Notice("同步正在进行中，请稍候");
			return;
		}
		// Immediate feedback: the login gates + retries below can take tens of
		// seconds before the first progress notice — show activity at once.
		new Notice("正在同步小红书收藏…");

		// Gate 1: login. The persisted flag can be STALE (a historical
		// misreport once flipped it false while the session was alive), so
		// when it says no, verify against the live page before blocking.
		if (!this.settings.loginStatus) {
			let actually = false;
			try {
				actually = await this.session.checkLogin();
			} catch {
				actually = false;
			}
			if (actually) {
				this.settings.loginStatus = true;
				await this.saveSettings();
				this.settingTab?.display();
			} else {
				new Notice("尚未登录小红书，请先打开「Pull Rednote：打开登录页」登录", 8000);
				return;
			}
		}
		// Gate 2: confirm the session is actually still valid (the webview may
		// have lost it). Re-verify via the v2/user/me endpoint (page probe
		// fallback inside checkLogin).
		try {
			const ok = await this.session.checkLogin();
			if (!ok) {
				this.settings.loginStatus = false;
				await this.saveSettings();
				new Notice("登录已失效，请重新打开登录窗口登录小红书", 8000);
				return;
			}
		} catch {
			// Can't confirm (sign/network error) -> don't proceed.
			new Notice("无法确认登录状态，请重新打开登录窗口", 8000);
			return;
		}

		this.syncing = true;
		const syncedSet = new Set(this.settings.syncedNoteIds);
		// note_ids written during this run; persisted incrementally below.
		const newIds = new Set<string>();

		// Rate limit state (feature #14): loaded from data.json so a restart
		// does NOT reset the budget; an expired window resets it naturally.
		const rateCfg = parseRateLimitConfig(
			this.settings.rateLimitMaxNotes,
			this.settings.rateLimitWindowMinutes,
		);
		let rateState: RateLimitState =
			normalizeRateLimitState(this.settings.rateLimitState) ?? {
				windowStart: Date.now(),
				notesInWindow: 0,
			};
		const persistRateState = (): Promise<void> => {
			this.settings.rateLimitState = rateState;
			return this.saveSettings();
		};

		try {
			const result = await syncFavorites(this.app.vault, this.session, {
				notesFolder: this.settings.notesFolder,
				tagPrefix: this.settings.tagPrefix,
				syncedNoteIds: syncedSet,
				onPage: (page: number) => {
					new Notice(`正在同步第 ${page} 页…`);
				},
				// Called before each NEW note's detail fetch. When the window
				// budget is exhausted, show the Notice and wait out the window,
				// then continue automatically. runSync already runs as a
				// background async task; closing Obsidian is the cancel path.
				acquireNoteSlot: async () => {
					for (;;) {
						const decision = evaluateRateLimit(rateState, rateCfg, Date.now());
						rateState = decision.state;
						if (decision.action === "allow") {
							return;
						}
						const minutes = Math.max(1, Math.ceil(decision.waitMs / 60_000));
						new Notice(`已达限速上限，${minutes} 分钟后自动继续`, 8000);
						await persistRateState();
						await new Promise<void>((resolve) =>
							window.setTimeout(resolve, decision.waitMs),
						);
					}
				},
				onNotePersisted: (noteId: string) => {
					// Persist the id the instant its .md is on disk, so a mid-run
					// abort (e.g. login expiry) does not lose already-written notes.
					if (syncedSet.has(noteId) || newIds.has(noteId)) {
						return;
					}
					newIds.add(noteId);
					syncedSet.add(noteId);
					this.settings.syncedNoteIds = Array.from(syncedSet);
					// A fully processed note (detail fetch + write) counts
					// against the current rate limit window.
					rateState = recordProcessed(rateState, rateCfg, Date.now());
					return persistRateState();
				},
			});

			// Full success: record completion time (lastSyncAt keeps its
			// "round finished" semantic — not set on an interrupted run).
			// (ids were already persisted incrementally; this is a no-op merge.)
			this.settings.syncedNoteIds = Array.from(new Set([...syncedSet, ...result.newNoteIds]));
			this.settings.lastSyncAt = epochToIso(Date.now(), XHS_UTC_OFFSET_MIN);
			await this.saveSettings();

			new Notice(makeSummaryNotice(result), 8000);
		} catch (e) {
			if (e instanceof NotLoggedInError) {
				// A signed request being rejected is NOT proof the login expired:
				// signature/anti-crawl rejection returns the same {success:false}
				// envelope. Cross-check with the page-side probe BEFORE flipping
				// loginStatus — only flip when the page itself says logged out.
				let page = { ok: false, info: "页面探测异常" };
				try {
					page = await this.session.checkLoginViaPage();
				} catch (probeErr) {
					page = { ok: false, info: probeErr instanceof Error ? probeErr.message : String(probeErr) };
				}
				this.session.log(`runSync NotLoggedInError -> 页面探测 ok=${page.ok}（${page.info}）`);
				if (page.ok) {
					new Notice(
						`接口拒绝了请求（疑似签名/风控），详情见 debug.log。已同步的 ${newIds.size} 篇已保留`,
						12000,
					);
				} else {
					this.settings.loginStatus = false;
					// newIds already persisted incrementally -> not lost here.
					await this.saveSettings();
					new Notice(`登录失效：${e.message}。请重新打开登录窗口（已同步的 ${newIds.size} 篇已保留）`, 12000);
				}
			} else if (e instanceof SignError) {
				new Notice(`签名失败：${e.message}`, 10000);
			} else {
				new Notice(`同步失败：${(e as Error).message}`, 10000);
			}
		} finally {
			this.syncing = false;
		}
	}
}

class RedNoteSyncSettingTab extends PluginSettingTab {
	plugin: RedNoteSyncPlugin;

	constructor(app: App, plugin: RedNoteSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("登录状态")
			.setDesc(settings.loginStatus ? "已登录小红书" : "未登录")
			.addToggle((toggle: ToggleComponent) => {
				toggle
					.setValue(settings.loginStatus)
					.setDisabled(true)
					.onChange(async (value: boolean) => {
						settings.loginStatus = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("登录小红书")
			.setDesc("打开内嵌登录页（扫码 / 密码登录），会话由插件保持。登录状态由插件自动检测，开关仅作展示。")
			.addButton((b) => {
				b.setButtonText("打开登录页").onClick(() => {
					this.plugin.openLogin();
				});
			})
			.addButton((b) => {
				b.setButtonText("退出登录").onClick(async () => {
					b.setDisabled(true);
					new Notice("正在退出登录…");
					try {
						await this.plugin.session.logout();
					} catch (e) {
						console.warn("[pull-rednote] logout failed:", e);
					}
					this.plugin.settings.loginStatus = false;
					await this.plugin.saveSettings();
					new Notice("已退出小红书登录");
					this.display();
				});
			});

		new Setting(containerEl)
			.setName("同步收藏")
			.setDesc(
				"立即拉取小红书收藏并写入笔记目录（受限速约束）。也可用左侧栏书签图标或命令面板触发。",
			)
			.addButton((b) => {
				b.setButtonText("立即同步").setCta().onClick(() => {
					void this.plugin.runSync();
				});
			});

		new Setting(containerEl)
			.setName("上次同步")
			.setDesc(settings.lastSyncAt || "（尚未同步）");

		new Setting(containerEl)
			.setName("限速：每窗口笔记数")
			.setDesc("每个时间窗口内最多处理的笔记数（按详情拉取+写盘计），防止触发风控")
			.addText((text: TextComponent) => {
				text.inputEl.type = "number";
				text
					.setPlaceholder("20")
					.setValue(String(settings.rateLimitMaxNotes))
					.onChange(async (value: string) => {
						const parsed = Number(value);
						settings.rateLimitMaxNotes =
							Number.isFinite(parsed) && parsed > 0
								? Math.floor(parsed)
								: 20;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("限速：窗口时长（分钟）")
			.setDesc("限速窗口长度；达到上限后等待到窗口结束自动继续，重启 Obsidian 不重置预算")
			.addText((text: TextComponent) => {
				text.inputEl.type = "number";
				text
					.setPlaceholder("10")
					.setValue(String(settings.rateLimitWindowMinutes))
					.onChange(async (value: string) => {
						const parsed = Number(value);
						settings.rateLimitWindowMinutes =
							Number.isFinite(parsed) && parsed > 0
								? parsed
								: 10;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("启用 AI 视频转写与图片分析")
			.setDesc("开启后同步时调用 AI 接口处理媒体内容（M4 实现）")
			.addToggle((toggle: ToggleComponent) => {
				toggle
					.setValue(settings.aiEnabled)
					.onChange(async (value: boolean) => {
						settings.aiEnabled = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AI 接口地址（Base URL）")
			.setDesc("兼容 OpenAI 格式的接口地址")
			.addText((text: TextComponent) => {
				text
					.setPlaceholder("https://api.example.com/v1")
					.setValue(settings.aiBaseUrl)
					.onChange(async (value: string) => {
						settings.aiBaseUrl = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AI API Key")
			.setDesc("用于调用 AI 接口的密钥，仅保存在本地 data.json")
			.addText((text: TextComponent) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(settings.aiApiKey)
					.onChange(async (value: string) => {
						settings.aiApiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AI 模型名称")
			.setDesc("留空时由服务端默认模型处理")
			.addText((text: TextComponent) => {
				text
					.setPlaceholder("例如 gpt-4o-mini")
					.setValue(settings.aiModel)
					.onChange(async (value: string) => {
						settings.aiModel = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("标签前缀")
			.setDesc("写入笔记 frontmatter / 标签的前缀（留空表示不加前缀）")
			.addText((text: TextComponent) => {
				text
					.setPlaceholder("xhs/")
					.setValue(settings.tagPrefix)
					.onChange(async (value: string) => {
						settings.tagPrefix = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("笔记保存目录")
			.setDesc("同步下来的笔记存放路径（相对 Vault 根目录）")
			.addText((text: TextComponent) => {
				text
					.setPlaceholder("RedNote/Bookmarks")
					.setValue(settings.notesFolder)
					.onChange(async (value: string) => {
						settings.notesFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("媒体保存目录")
			.setDesc("图片 / 视频等媒体文件存放路径（相对 Vault 根目录，M3 使用）")
			.addText((text: TextComponent) => {
				text
					.setPlaceholder("RedNote/Media")
					.setValue(settings.mediaFolder)
					.onChange(async (value: string) => {
						settings.mediaFolder = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}
}
