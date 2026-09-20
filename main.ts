// RedNote Sync — Obsidian plugin entry (M2: 登录 → 取数 → Markdown → 写入 vault).
//
// This file is the plugin entry: lifecycle (onload/onunload), the command &
// ribbon, and the settings tab. All business logic lives in src/rednote/
// (pure: types / filename / pagination / markdown / extract; side-effect:
// api / login / sync).

import { App, Notice, Plugin, PluginSettingTab, Setting, ToggleComponent, TextComponent } from "obsidian";

import {
	RedNoteSession,
	cleanPartitionStatus,
	ensureWebviewPreloadFile,
	WEBVIEW_PRELOAD_FILENAME,
} from "./src/rednote/api";
import { NotLoggedInError, SignError } from "./src/rednote/types";
import { syncFavorites, makeSummaryNotice } from "./src/rednote/sync";
import { RedNoteLoginModal, LOGIN_LEAF_VIEW_TYPE } from "./src/rednote/login";
import { epochToIso, fixMediaEmbedPaths } from "./src/rednote/markdown";
import {
	AI_SECTION_VIDEO,
	analyzeImages,
	analyzeVideo,
	applyImageAnalysis,
	applyKeyFrames,
	applyVideoTranscript,
	chunkArray,
	extractAudioBase64,
	extractKeyFrames,
	extractLocalImagePaths,
	extractVideoNoteUrl,
	frontmatterHasImageAnalysis,
	frontmatterHasSection,
	frontmatterStringValue,
	frontmatterTypeIsVideo,
} from "./src/rednote/ai";
import { hasLegacyNoteIds, migrateLegacyNoteIds, type NoteIndex } from "./src/rednote/hash";
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
	/**
	 * M4.1 AI executor (ADR-009): "plugin" = in-plugin OpenAI-compatible
	 * image analysis right after sync + backfill command; "zcode" = the
	 * plugin calls NO AI at all (ai_sections stays without image_analysis,
	 * a ZCode session batch-processes those notes per the M4.2 protocol).
	 */
	aiExecutor: "plugin" | "zcode";
	/** M4.1: notes per batch for the AI backfill command (1-50). */
	aiBatchSize: number;
	tagPrefix: string;
	notesFolder: string;
	mediaFolder: string;
	/**
	 * Incremental note index (M3): note_id -> { hash, syncedAt, file }.
	 * Replaces the legacy syncedNoteIds array (migrated once on load; the old
	 * field is never written again — no unbounded array growth).
	 */
	noteIndex: NoteIndex;
	/** Download video files into the media folder (default off: disk space). */
	downloadVideos: boolean;
	/** ISO 8601 of the last successful sync. */
	lastSyncAt: string;
	/** Rate limit (feature #14): max notes processed per window. */
	rateLimitMaxNotes: number;
	/** Rate limit: window length in minutes. */
	rateLimitWindowMinutes: number;
	/** Rate limit: persisted window budget state (survives restarts). */
	rateLimitState: RateLimitState | null;
	/** Last captured header set of the page's own successful edith requests
	 * (Service-Tag, c_device_id …) — mirrored onto our outbound requests. */
	pageHeaders: Record<string, string> | null;
}

const DEFAULT_SETTINGS: RedNoteSyncSettings = {
	loginStatus: false,
	aiEnabled: false,
	aiBaseUrl: "",
	aiApiKey: "",
	aiModel: "",
	aiExecutor: "plugin",
	aiBatchSize: 10,
	tagPrefix: "xhs/",
	notesFolder: "RedNote/Bookmarks",
	mediaFolder: "RedNote/Media",
	noteIndex: {},
	downloadVideos: false,
	lastSyncAt: "",
	rateLimitMaxNotes: 20,
	rateLimitWindowMinutes: 10,
	rateLimitState: null,
	pageHeaders: null,
};

/** XHS publish/collect times are rendered in +08:00 (see extract.ts). */
const XHS_UTC_OFFSET_MIN = 8 * 60;

export default class RedNoteSyncPlugin extends Plugin {
	settings: RedNoteSyncSettings = { ...DEFAULT_SETTINGS };
	/** Shared webview session (used by the settings tab's logout button). */
	readonly session = new RedNoteSession();
	private syncing = false;
	/** M4.1: re-entrancy guard for the AI backfill / post-sync AI stage. */
	private aiRunning = false;
	/** Guard against re-entrant login modals (one login webview at a time). */
	private loginModalOpen = false;
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
		// Persist the page's captured header set so mirroring survives
		// restarts (a fresh page context starts with an empty capture).
		this.session.pageHeaderStore = {
			get: () => this.settings.pageHeaders ?? {},
			set: (m) => {
				this.settings.pageHeaders = m;
				void this.saveSettings();
			},
		};
		// Short-strip final fix: write the userAgentData-spoofing preload
		// script into the plugin dir and hand its file:// URL to every webview
		// we create (login modal + sign). A null result (fs missing / write
		// failed) leaves the webviews without preload — the previous behavior.
		this.session.webviewPreloadUrl = ensureWebviewPreloadFile(
			`${vaultRoot}/${this.manifest.dir}`,
			(line) => this.session.log(line),
		);
		if (this.session.webviewPreloadUrl) {
			this.session.log(`登录/签名 webview preload 已就绪（${WEBVIEW_PRELOAD_FILENAME}）`);
		}
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

		this.addCommand({
			id: "ai-backfill",
			name: "Pull Rednote：AI 补处理收藏笔记",
			callback: () => {
				void this.runAiBackfill();
			},
		});

		this.addCommand({
			id: "fix-media-paths",
			name: "Pull Rednote：修复媒体嵌入路径",
			callback: () => {
				void this.runFixMediaPaths();
			},
		});
	}

	onunload(): void {
		// The login modal's fresh webview dies with the app window (or in the
		// modal's onClose). Tear down the resident/parked webview session last.
		this.session.destroy();
	}

	/** Persist settings to data.json. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		// M3 one-shot migration: legacy syncedNoteIds array -> noteIndex entries
		// with hash "" ("content unknown, reconcile next sync"). The legacy field
		// is removed and never written again (bounded per-note entries replace
		// the unbounded array).
		if (hasLegacyNoteIds(loaded?.["syncedNoteIds"])) {
			this.settings.noteIndex = migrateLegacyNoteIds(
				loaded?.["syncedNoteIds"],
				this.settings.noteIndex ?? {},
				this.settings.lastSyncAt || new Date().toISOString(),
			);
			delete (this.settings as unknown as Record<string, unknown>)["syncedNoteIds"];
			await this.saveSettings();
			console.log("[pull-rednote] 已将旧版 syncedNoteIds 迁移为 noteIndex（hash 待对账）");
		}
	}

	/** Open the login page in a workspace-leaf tab and keep the session. */
	openLogin(): void {
		// Back on the leaf host (user decision): the Modal host crashed the
		// Obsidian process (0x80000003) a few seconds after the QR appeared at
		// full size, across preload/no-preload and deferred-destroy variants —
		// the leaf never crashed. The short-strip defect is NOT container-
		// dependent (it was the src/mount attribute order, since fixed), so a
		// leaf + fresh-fixed-size-webview should render full size AND stay
		// stable. Reuses the open leaf if present.
		const existing = this.app.workspace.getLeavesOfType(LOGIN_LEAF_VIEW_TYPE);
		const openLeaf = existing.length > 0 ? existing[0] : undefined;
		if (openLeaf) {
			this.app.workspace.setActiveLeaf(openLeaf);
			return;
		}
		const leaf = this.app.workspace.getLeaf(true);
		const view = new RedNoteLoginModal(
			leaf,
			this.session,
			() => {
				void this.updateLoginState(true);
			},
		);
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
		// Working copy of the incremental index; entries are persisted
		// incrementally via onNoteIndexed below (M3 replaces syncedNoteIds).
		const noteIndex: NoteIndex = { ...this.settings.noteIndex };
		// Settled notes this run (writes + reconciles) for the abort notices.
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
				noteIndex,
				mediaFolder: this.settings.mediaFolder,
				downloadVideos: this.settings.downloadVideos,
				onPage: (page: number) => {
					new Notice(`正在同步第 ${page} 页…`);
				},
				// Called before each note's detail fetch. When the window
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
				onDetailFetched: () => {
					// Review fix 2: the detail REQUEST is what costs a window slot,
					// so the budget is consumed here exactly once per successful
					// fetch — skip / reconcile / rewrite all account identically
					// (previously skips fetched details for free while writes
					// double-charged via onNoteIndexed).
					rateState = recordProcessed(rateState, rateCfg, Date.now());
					return persistRateState();
				},
				onNoteIndexed: (noteId: string, hash: string, file: string) => {
					// Persist the index entry the instant the note is on disk (or
					// reconciled), so a mid-run abort (e.g. login expiry) does not
					// redo already-settled notes. Budget was already consumed by
					// onDetailFetched — no recordProcessed here.
					noteIndex[noteId] = {
						hash,
						syncedAt: epochToIso(Date.now(), XHS_UTC_OFFSET_MIN),
						...(file ? { file } : {}),
					};
					this.settings.noteIndex = noteIndex;
					newIds.add(noteId);
					return persistRateState();
				},
			});

			// Full success: record completion time (lastSyncAt keeps its
			// "round finished" semantic — not set on an interrupted run).
			// (index entries were already persisted incrementally; this is a
			// no-op re-assign.)
			this.settings.noteIndex = noteIndex;
			this.settings.lastSyncAt = epochToIso(Date.now(), XHS_UTC_OFFSET_MIN);
			await this.saveSettings();

			new Notice(makeSummaryNotice(result), 8000);
			// M4.1 post-sync AI stage: plugin-executor image analysis over the
			// notes written THIS run. Fully failure-isolated — an AI error never
			// affects the sync counts above or the incremental index.
			await this.runPostSyncAi(result.newNoteIds);
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

	/** M4.1 helper: sleep via window.setTimeout (matches runSync's style). */
	private aiDelay(ms: number): Promise<void> {
		return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
	}

	/**
	 * M4.1: analyze one note file's embedded local images and write the
	 * result into the AI section + frontmatter markers. Never throws.
	 * Returns "ok" (analyzed + written), "skip" (no local images; a marker
	 * note is written so backfill scans stay idempotent), or "fail".
	 */
	private async aiProcessNoteFile(
		filePath: string,
	): Promise<"ok" | "skip" | "fail"> {
		const s = this.settings;
		const adapter = this.app.vault.adapter;
		let content = "";
		try {
			content = await adapter.read(filePath);
		} catch (e) {
			this.session.log(`AI 图片分析：读取失败 ${filePath} ${e instanceof Error ? e.message : String(e)}`);
			return "fail";
		}
		// Video notes go down the video-transcription track (they normally
		// carry no local images, so the two tracks never interfere).
		if (frontmatterTypeIsVideo(content)) {
			return this.aiProcessVideoNoteFile(filePath, content);
		}
		const images = extractLocalImagePaths(content, s.mediaFolder);
		if (images.length === 0) {
			try {
				await adapter.write(
					filePath,
					applyImageAnalysis(content, s.aiModel || "plugin", "（该笔记无本地图片，未做图片分析）"),
				);
				this.session.log(`AI 图片分析：无本地图片，已标记跳过 ${filePath}`);
				return "skip";
			} catch (e) {
				this.session.log(`AI 图片分析：写入跳过标记失败 ${filePath} ${e instanceof Error ? e.message : String(e)}`);
				return "fail";
			}
		}
		const r = await analyzeImages(s.aiBaseUrl, s.aiApiKey, s.aiModel, images, adapter);
		if ("error" in r) {
			this.session.log(`AI 图片分析失败（跳过，不影响同步）：${filePath} ${r.error}`);
			return "fail";
		}
		try {
			await adapter.write(filePath, applyImageAnalysis(content, s.aiModel, r.text));
		} catch (e) {
			this.session.log(`AI 图片分析：写回失败 ${filePath} ${e instanceof Error ? e.message : String(e)}`);
			return "fail";
		}
		this.session.log(`AI 图片分析成功：${filePath}`);
		return "ok";
	}

	/**
	 * M4 (video track): transcribe one video note via its rendered
	 * `[▶ 观看视频](url)` link. Idempotent on the `video_transcript`
	 * frontmatter marker; preserves any existing `### 图片分析` subsection.
	 * Never throws.
	 */
	private async aiProcessVideoNoteFile(
		filePath: string,
		content: string,
	): Promise<"ok" | "skip" | "fail"> {
		const s = this.settings;
		if (frontmatterHasSection(content, AI_SECTION_VIDEO)) {
			return "skip";
		}
		const videoUrl = extractVideoNoteUrl(content);
		if (!videoUrl) {
			// Old notes synced before the 2026 video extraction fix have no
			// playable link (CDN URLs also expire) — skip WITHOUT re-calling
			// the detail API (deep backfill is the M4.2 ZCode track).
			this.session.log(`AI 视频分析：视频链接缺失（旧笔记），跳过 ${filePath}`);
			return "skip";
		}
		// Audio track (same video URL, ffmpeg -> base64 mp3): passed alongside
		// the video_url item when extraction succeeds; on failure / over-size
		// the call proceeds video-only (previous behavior), never blocking.
		const audioBase64 = await extractAudioBase64(videoUrl, (line) =>
			this.session.log(line),
		);
		const r = await analyzeVideo(
			s.aiBaseUrl,
			s.aiApiKey,
			s.aiModel,
			videoUrl,
			audioBase64 ?? undefined,
		);
		if ("error" in r) {
			this.session.log(`AI 视频分析失败（跳过，不影响同步）：${filePath} ${r.error}`);
			return "fail";
		}
		const adapter = this.app.vault.adapter;
		let noteId = frontmatterStringValue(content, "note_id");
		let newContent = applyVideoTranscript(content, s.aiModel, r.text);
		// Key frames (ffmpeg): extract only when the model returned key moments;
		// without ffmpeg or without moments no 关键帧 section is written.
		if (r.keyMoments && r.keyMoments.length > 0) {
			if (!noteId) {
				// Fall back to the file stem when frontmatter lacks note_id.
				noteId = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
			}
			const kf = await extractKeyFrames(
				videoUrl,
				noteId,
				s.mediaFolder,
				r.keyMoments,
				adapter,
				(line) => this.session.log(line),
			);
			if (kf.frames.length > 0) {
				newContent = applyKeyFrames(newContent, kf.frames, noteId, s.mediaFolder);
			}
		}
		try {
			await adapter.write(filePath, newContent);
		} catch (e) {
			this.session.log(`AI 视频分析：写回失败 ${filePath} ${e instanceof Error ? e.message : String(e)}`);
			return "fail";
		}
		this.session.log(`AI 视频分析成功：${filePath}`);
		return "ok";
	}

	/**
	 * One-time repair command: rewrite legacy relative media embeds
	 * `](RedNote/Media/...` in every note under notesFolder to the
	 * vault-absolute `](/RedNote/Media/...` form (Obsidian resolves markdown
	 * links relative to the note's folder, so collection subfolder notes could
	 * not render their media). Content-hash-neutral for note IDs — the note
	 * index is untouched. Never throws.
	 */
	async runFixMediaPaths(): Promise<void> {
		const s = this.settings;
		const folder = (s.notesFolder ?? "").replace(/^\/+|\/+$/g, "");
		const prefix = folder ? `${folder}/` : "";
		const paths = this.app.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((p) => !prefix || p.startsWith(prefix));
		const adapter = this.app.vault.adapter;
		let filesChanged = 0;
		let totalReplaced = 0;
		for (const p of paths) {
			try {
				const content = await adapter.read(p);
				const { text, replaced } = fixMediaEmbedPaths(content, s.mediaFolder);
				if (replaced > 0) {
					await adapter.write(p, text);
					filesChanged += 1;
					totalReplaced += replaced;
				}
			} catch (e) {
				this.session.log(
					`修复媒体嵌入路径：读取/写入失败（跳过） ${p} ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		new Notice(`媒体嵌入路径修复完成：${filesChanged} 个文件，共替换 ${totalReplaced} 处`, 8000);
	}

	/**
	 * M4.1: post-sync AI stage (plugin executor only). Runs AFTER the sync
	 * summary Notice over this run's newNoteIds; every per-note failure is
	 * logged + skipped and can never change the sync result counters or the
	 * incremental index.
	 */
	private async runPostSyncAi(newNoteIds: string[]): Promise<void> {
		const s = this.settings;
		if (s.aiExecutor === "zcode") {
			this.session.log("ZCode 模式：同步后不做 AI，等待 ZCode 批处理");
			return;
		}
		if (!(s.aiEnabled && s.aiBaseUrl && s.aiApiKey)) {
			if (newNoteIds.length > 0) {
				new Notice(`AI 图片分析：跳过 ${newNoteIds.length} 篇（未启用或未配置接口）`, 6000);
			}
			return;
		}
		if (this.aiRunning) {
			this.session.log("AI 补处理正在进行中，跳过本次同步后置 AI 阶段");
			return;
		}
		this.aiRunning = true;
		let ok = 0;
		let fail = 0;
		let skip = 0;
		try {
			for (let i = 0; i < newNoteIds.length; i++) {
				const id = newNoteIds[i];
				const file = id === undefined ? undefined : this.settings.noteIndex[id]?.file;
				if (!file) {
					skip += 1;
					continue;
				}
				const r = await this.aiProcessNoteFile(file);
				if (r === "ok") {
					ok += 1;
				} else if (r === "skip") {
					skip += 1;
				} else {
					fail += 1;
				}
				// API politeness rate limit between notes.
				if (i < newNoteIds.length - 1) {
					await this.aiDelay(2_000);
				}
			}
		} finally {
			this.aiRunning = false;
		}
		new Notice(`AI 图片分析：成功 ${ok} 篇 / 失败 ${fail} 篇 / 跳过 ${skip} 篇`, 8000);
	}

	/**
	 * M4.1: the AI backfill command — scan the notes folder for notes whose
	 * frontmatter `ai_sections` lacks `image_analysis`, process them in
	 * aiBatchSize-sized batches (progress Notice per batch, 5s between
	 * batches). Idempotent: the ai_sections marker is written on success (and
	 * on no-image notes), so re-running continues from the unprocessed rest.
	 */
	async runAiBackfill(): Promise<void> {
		if (this.aiRunning) {
			new Notice("AI 补处理正在进行中，请等待当前批次结束");
			return;
		}
		const s = this.settings;
		if (s.aiExecutor === "zcode") {
			new Notice("当前 AI 执行器为 ZCode，插件不做补处理（等待 ZCode 批处理）");
			return;
		}
		if (!(s.aiEnabled && s.aiBaseUrl && s.aiApiKey)) {
			new Notice("请先在设置中启用 AI 并配置接口地址与 API Key", 6000);
			return;
		}
		const folder = (s.notesFolder ?? "").replace(/^\/+|\/+$/g, "");
		const prefix = folder ? `${folder}/` : "";
		const paths = this.app.vault
			.getMarkdownFiles()
			.map((f) => f.path)
			.filter((p) => !prefix || p.startsWith(prefix));
		const pending: string[] = [];
		for (const p of paths) {
			try {
				const c = await this.app.vault.adapter.read(p);
					const isVideo = frontmatterTypeIsVideo(c);
					if (
						!frontmatterHasImageAnalysis(c) ||
						(isVideo && !frontmatterHasSection(c, AI_SECTION_VIDEO))
					) {
						pending.push(p);
					}
			} catch {
				// Unreadable file: leave it for the next scan.
			}
		}
		if (pending.length === 0) {
			new Notice("没有待 AI 补处理的笔记");
			return;
		}
		this.aiRunning = true;
		const total = pending.length;
		const batchSize = Math.min(50, Math.max(1, Math.floor(s.aiBatchSize) || 10));
		const batches = chunkArray(pending, batchSize);
		try {
			for (let i = 0; i < batches.length; i++) {
				const batch = batches[i];
				if (!batch) {
					continue;
				}
				for (const p of batch) {
					await this.aiProcessNoteFile(p);
				}
				new Notice(`第 ${i + 1} 批完成，共 ${total} 篇待处理`, 5000);
				if (i < batches.length - 1) {
					await this.aiDelay(5_000);
				}
			}
			new Notice(`AI 补处理完成：共 ${total} 篇`, 8000);
		} finally {
			this.aiRunning = false;
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
			.setName("AI 执行器")
			.setDesc(
				"plugin：同步后在插件内即时调用 AI 接口做图片分析；zcode：同步后不调用任何 AI，仅留空标记，由 ZCode 批处理（协议见 M4.2）",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("plugin", "插件内（即时处理）")
					.addOption("zcode", "ZCode（批处理）")
					.setValue(settings.aiExecutor)
					.onChange(async (value: string) => {
						settings.aiExecutor = value === "zcode" ? "zcode" : "plugin";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AI 补处理批次大小")
			.setDesc("「AI 补处理收藏笔记」命令每批处理的笔记数（1-50）")
			.addText((text: TextComponent) => {
				text.inputEl.type = "number";
				text
					.setPlaceholder("10")
					.setValue(String(settings.aiBatchSize))
					.onChange(async (value: string) => {
						const parsed = Number(value);
						settings.aiBatchSize =
							Number.isFinite(parsed) && parsed >= 1
								? Math.min(50, Math.max(1, Math.floor(parsed)))
								: 10;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("AI 补处理")
			.setDesc(
				"扫描笔记目录中 ai_sections 缺少 image_analysis 的笔记，按批次调用 AI 图片分析（幂等：已处理的自动跳过）",
			)
			.addButton((b) => {
				b.setButtonText("AI 补处理").onClick(() => {
					void this.plugin.runAiBackfill();
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

		new Setting(containerEl)
			.setName("下载视频文件")
			.setDesc(
				"开启后视频笔记的视频文件将下载到媒体目录——视频体积大，可能占用大量磁盘空间，请确认剩余容量。关闭时正文仅记录视频链接（默认关闭）",
			)
			.addToggle((toggle: ToggleComponent) => {
				toggle
					.setValue(settings.downloadVideos)
					.onChange(async (value: boolean) => {
						settings.downloadVideos = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
