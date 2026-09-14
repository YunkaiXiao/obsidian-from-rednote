// RedNote Sync — Obsidian plugin entry (M2: 登录 → 取数 → Markdown → 写入 vault).
//
// This file is the plugin entry: lifecycle (onload/onunload), the command &
// ribbon, and the settings tab. All business logic lives in src/rednote/
// (pure: types / filename / pagination / markdown / extract; side-effect:
// api / login / sync).

import { App, Notice, Plugin, PluginSettingTab, Setting, ToggleComponent, TextComponent } from "obsidian";

import { RedNoteSession } from "./src/rednote/api";
import { NotLoggedInError, SignError } from "./src/rednote/types";
import { syncFavorites, makeSummaryNotice } from "./src/rednote/sync";
import { RedNoteLoginModal } from "./src/rednote/login";
import { epochToIso } from "./src/rednote/markdown";

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
};

/** XHS publish/collect times are rendered in +08:00 (see extract.ts). */
const XHS_UTC_OFFSET_MIN = 8 * 60;

export default class RedNoteSyncPlugin extends Plugin {
	settings: RedNoteSyncSettings = { ...DEFAULT_SETTINGS };
	private session = new RedNoteSession();
	private syncing = false;
	/** Guard against re-entrant login modals fighting over one resident webview. */
	private loginModalOpen = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new RedNoteSyncSettingTab(this.app, this));

		this.addRibbonIcon("bookmark", "RedNote Sync", () => {
			void this.runSync();
		});

		this.addCommand({
			id: "sync-rednote-favorites",
			name: "同步小红书收藏",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "rednote-open-login",
			name: "小红书：打开登录窗口",
			callback: () => {
				this.openLogin();
			},
		});
	}

	onunload(): void {
		// Destroy the resident webview (drops the session; next use re-logins).
		this.session.destroy();
	}

	/** Persist settings to data.json. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/** Open the embedded login modal and keep the webview resident. */
	openLogin(): void {
		// Re-entrancy guard: a second modal would move the same resident webview
		// container while the first is showing it, corrupting the session.
		if (this.loginModalOpen) {
			new Notice("登录窗口已打开，请先关闭再重新打开");
			return;
		}
		this.loginModalOpen = true;
		const modal = new RedNoteLoginModal(this.app, this.session, (logged: boolean) => {
			// This callback is invoked from the modal's onClose() (either the
			// success-confirm path or a manual close), so it is the reliable
			// place to release the re-entrancy guard.
			this.loginModalOpen = false;
			void this.updateLoginState(logged);
		});
		modal.open();
	}

	/**
	 * Update + persist login state, then (re)verify against the selfinfo API so
	 * the stored flag reflects reality rather than a stale UI signal.
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
		// The settings tab re-renders from this.settings the next time it is
		// opened; nothing further to push here.
	}

	/** The core sync command (M2). */
	async runSync(): Promise<void> {
		if (this.syncing) {
			new Notice("同步正在进行中，请稍候");
			return;
		}

		// Gate 1: login. (If never logged in, guide to the login modal.)
		if (!this.settings.loginStatus) {
			new Notice("尚未登录小红书，请先打开「小红书：打开登录窗口」登录", 8000);
			return;
		}
		// Gate 2: confirm the session is actually still valid (the webview may
		// have lost it). Re-verify via the selfinfo endpoint.
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
		try {
			const result = await syncFavorites(this.app.vault, this.session, {
				notesFolder: this.settings.notesFolder,
				tagPrefix: this.settings.tagPrefix,
				syncedNoteIds: syncedSet,
				onPage: (page: number) => {
					new Notice(`正在同步第 ${page} 页…`);
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
					return this.saveSettings();
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
				this.settings.loginStatus = false;
				// newIds already persisted incrementally -> not lost here.
				await this.saveSettings();
				new Notice(`登录失效：${e.message}。请重新打开登录窗口（已同步的 ${newIds.size} 篇已保留）`, 12000);
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
			.setDesc("打开内嵌登录窗口（扫码 / 密码登录），会话由插件保持")
			.addButton((b) => {
				b.setButtonText("打开登录窗口").onClick(() => {
					this.plugin.openLogin();
				});
			});

		new Setting(containerEl)
			.setName("上次同步")
			.setDesc(settings.lastSyncAt || "（尚未同步）");

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
