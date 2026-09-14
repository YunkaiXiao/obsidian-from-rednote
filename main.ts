import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	ToggleComponent,
	TextComponent,
} from "obsidian";

export interface RedNoteSyncSettings {
	loginStatus: boolean;
	aiEnabled: boolean;
	aiBaseUrl: string;
	aiApiKey: string;
	aiModel: string;
	tagPrefix: string;
	notesFolder: string;
	mediaFolder: string;
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
};

export default class RedNoteSyncPlugin extends Plugin {
	settings: RedNoteSyncSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new RedNoteSyncSettingTab(this.app, this));

		this.addRibbonIcon("bookmark", "RedNote Sync", () => {
			this.runSync();
		});

		this.addCommand({
			id: "sync-rednote-favorites",
			name: "同步小红书收藏",
			callback: () => {
				this.runSync();
			},
		});
	}

	onunload(): void {
		// v1: no dynamic state to clean up yet; keep the hook for parity
	}

	runSync(): void {
		new Notice("同步功能开发中");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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
			.setDesc("小红书账号登录状态（占位展示）")
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
			.setName("启用 AI 视频转写与图片分析")
			.setDesc("开启后同步时调用 AI 接口处理媒体内容")
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
			.setDesc("写入笔记 frontmatter / 标签的前缀")
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
			.setDesc("图片 / 视频等媒体文件存放路径（相对 Vault 根目录）")
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
