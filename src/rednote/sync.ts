// Side-effect module: the sync pipeline.
// Ties together the session (api.ts), extraction (extract.ts), markdown
// rendering (markdown.ts), filename resolution (filename.ts), the content-hash
// index (hash.ts) and media downloading (media.ts), then writes .md files into
// the vault via obsidian's Vault API.
// M3.1: source order is 收藏夹 boards first (board/user -> board/note per
// board, cards carry collection = 收藏夹 name), then the flat collect/page
// fallback; a run-scoped seen Set dedupes note_ids across both sources.
//
// Pure decision logic (filename, render, page parse, extraction, hash) lives in
// the pure modules and is unit-tested; this file only orchestrates side effects.

import { TFile, TFolder, Vault } from "obsidian";
import {
	RedNoteSession,
	FetchError,
	randomDelay,
	withRetry,
} from "./api";
import { NotLoggedInError, type RedNoteBoard, type RedNotePage, type RedNoteRaw } from "./types";
import { toRecord } from "./extract";
import { renderNoteMarkdown, appendAiSection, type NoteMediaMap } from "./markdown";
import { computeNoteHash, type NoteIndex } from "./hash";
import { syncNoteMedia } from "./media";
import { resolveRewriteFileName } from "./filename";
import { splitSeen } from "./pagination";

export type { NoteIndex, NoteIndexEntry } from "./hash";

export interface SyncOptions {
	/** Vault-relative notes folder, e.g. "RedNote/Bookmarks". */
	notesFolder: string;
	/** Tag prefix setting, e.g. "xhs/". */
	tagPrefix: string;
	/**
	 * Incremental note index (M3): note_id -> { hash, syncedAt, file }.
	 * Replaces the M2 syncedNoteIds skip list. hash "" (migrated legacy entry)
	 * means "content unknown": reconciled on the next run, never rewritten.
	 */
	noteIndex: NoteIndex;
	/** Vault-relative media folder, e.g. "RedNote/Media" (M3 media downloads). */
	mediaFolder: string;
	/** Video download toggle (default off; off = video link only, M2 behavior). */
	downloadVideos: boolean;
	/**
	 * Called per fetched list page (boards pages and flat collect pages; for
	 * the "第 N 页" progress Notice).
	 */
	onPage?: (page: number) => void;
	/**
	 * Called once a note's index entry is settled on disk: after a successful
	 * .md write (new or rewritten; hash + file path supplied) or after a
	 * legacy-entry reconciliation (hash filled, file kept as-is). The caller
	 * persists the entry immediately (incrementally) so that a later request
	 * aborting the run (e.g. mid-sync login expiry) does not redo this note.
	 */
	onNoteIndexed?: (noteId: string, hash: string, file: string) => Promise<void> | void;
	/**
	 * Rate-limit gate (feature #14), called before each note's detail fetch
	 * AND (M3.1) before every list request (boards list + every pagination
	 * page of board/note and collect/page — they are real API requests).
	 * Resolves when processing may proceed; the implementation (main layer)
	 * owns the wait/Notice/persistence side effects and may therefore resolve
	 * late (after the rate-limit window rolls over).
	 */
	acquireNoteSlot?: () => Promise<void>;
	/**
	 * Budget consumption (M3 review fix 2; M3.1 widened): called ONCE per
	 * SUCCESSFUL request that costs a window slot — every note detail fetch
	 * (regardless of whether the note is then skipped / reconciled /
	 * rewritten) and every successful list request. The main layer wires this
	 * to recordProcessed.
	 */
	onDetailFetched?: () => Promise<void> | void;
}

export interface SyncResult {
	added: number;
	skipped: number;
	failed: number;
	/** note_ids written this run (fresh + rewritten). */
	newNoteIds: string[];
	/** M3.1: number of 收藏夹 (boards) returned by board/user. */
	boardsFetched: number;
	/** M3.1: per-board note-card counts (what each board's pages returned). */
	boardNoteCounts: Array<{ id: string; name: string; notes: number }>;
	/** M3.1: note cards returned by the flat collect/page fallback. */
	flatNotes: number;
	/** M3.1: cards skipped by the run-scoped first-seen dedupe. */
	duplicates: number;
}

/** Ensure a vault folder (and parents) exists on DISK via the adapter.
 *
 * The vault-index APIs (createFolder/getAbstractFileByPath) desync from disk
 * reality when folders are deleted externally (stale index entries make
 * createFolder throw "already exists" while the folder is gone, and the
 * reverse). adapter.mkdir is idempotent against the real filesystem and
 * never throws on existing paths — Obsidian's file watcher picks up the
 * directories for its index automatically. Returns the path (not a TFolder)
 * so callers stop depending on the index entirely.
 */
async function ensureFolderPath(vault: Vault, folderPath: string): Promise<string> {
	const clean = (folderPath ?? "").replace(/^\/+|\/+$/g, "");
	if (clean === "") {
		return "/";
	}
	const parts = clean.split("/").filter((p) => p.length > 0);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!(await vault.adapter.exists(current))) {
			await vault.adapter.mkdir(current);
		}
	}
	return current;
}

/**
 * Per-page diagnostic line (M3.1): card count / has_more / cursor prefix, so
 * pagination behavior is traceable in debug.log. `rawDuplicates` is the
 * in-page duplicate count (counted on the RAW page in the api layer —
 * parseListPage removes those cards before they reach `p.items`); a separate
 * count line records it when non-zero.
 */
function logPageDiag(
	session: RedNoteSession,
	endpoint: string,
	page: number,
	p: RedNotePage,
	rawDuplicates: number,
): void {
	session.log(
		`分页 ${endpoint} 第${page}页：notes=${p.items.length} has_more=${p.has_more} cursor=${p.next_cursor.slice(0, 8)}`,
	);
	if (rawDuplicates > 0) {
		session.log(`分页 ${endpoint} 第${page}页：页内重复 note_id 去除 ${rawDuplicates} 条`);
	}
}

/**
 * Run the full favorites sync (M3.1: 收藏夹 boards FIRST, then the flat
 * collect list as the fallback for ungrouped favorites): for each list card,
 * fetch the note's detail, hash its content against the note index (M3),
 * download media, render Markdown, and write a .md per new / changed note.
 *
 * Source order + dedupe (M3.1):
 *  - board/user -> per board: board/note cursor pagination, cards carry
 *    collection = 收藏夹 name (fills the ADR-006 field that stayed empty)
 *  - flat /note/collect/page afterwards, collection stays ""
 *  - a run-scoped seen Set claims each note_id once (first-come-first-served;
 *    later encounters across boards/pages are skipped without any request);
 *    the persisted noteIndex is unchanged
 *  - every list request (boards list + each page) goes through the same
 *    rate-limit gate/billing as the note detail fetches
 *
 * Per-note state machine (M3, unchanged, identical for both sources):
 *  - no index entry          -> write fresh + download media
 *  - hash equal              -> skip entirely (no write, no download)
 *  - hash "" (legacy)        -> reconcile only (store the hash; no rewrite, no
 *                               media backfill — M3 does not touch old notes)
 *  - hash differs            -> rewrite (AI section preserved verbatim; media
 *                               gap-filled, existing files not re-downloaded)
 *
 * Board endpoints are the least-verified part of the pipeline: a boards-phase
 * failure degrades to flat-only (logged) instead of aborting the sync.
 *
 * @param vault   Obsidian vault.
 * @param session The resident webview session (must be logged in).
 * @param opts    Sync options.
 */
export async function syncFavorites(
	vault: Vault,
	session: RedNoteSession,
	opts: SyncOptions,
): Promise<SyncResult> {
	const result: SyncResult = {
		added: 0,
		skipped: 0,
		failed: 0,
		newNoteIds: [],
		boardsFetched: 0,
		boardNoteCounts: [],
		flatNotes: 0,
		duplicates: 0,
	};

	// 1. Confirm login + resolve the user id.
	let userId: string;
	try {
		userId = await withRetry(() => session.getSelfUserId());
	} catch (e) {
		if (e instanceof NotLoggedInError) {
			throw e;
		}
		throw new FetchError(`无法获取当前用户 ID：${(e as Error).message}`);
	}
	if (!userId) {
		throw new NotLoggedInError("无法获取当前用户 ID，可能未登录");
	}

	const syncedAt = new Date()
		.toISOString()
		.replace("Z", "+08:00");

	// Resolve the target folder path (adapter/disk-based, index-independent).
	const folderPath = await ensureFolderPath(vault, opts.notesFolder);
	const folderPrefix = folderPath === "/" ? "" : `${folderPath}/`;
	const existing = new Set<string>(
		vault
			.getMarkdownFiles()
			.filter((f) => (f.parent?.path ?? "") === folderPath)
			.map((f) => f.name),
	);

	// 2. Run-scoped first-seen dedupe (M3.1): a note_id claimed by its FIRST
	//    encounter (board or flat) is never processed again this run. Memory
	//    only — the persisted noteIndex stays untouched.
	const seen = new Set<string>();

	// Shared per-note pipeline (the M3 state machine, unchanged) for BOTH
	// sources: board cards (collection = 收藏夹 name) and flat fallback cards
	// (collection stays ""). NotLoggedInError propagates (session died).
	const processNote = async (card: RedNoteRaw, collection: string): Promise<void> => {
		// 3. Fetch the detail, hash it, then decide. The rate-limit gate runs
		//    first so a note only starts while the window budget allows it.
		try {
			if (opts.acquireNoteSlot) {
				await opts.acquireNoteSlot();
			}
			const detail = await withRetry(() =>
				session.fetchNoteDetail(
					card.note_id,
					card.xsec_token ?? "",
					card.xsec_source ?? "",
				),
			);
			// The detail request is what consumes a window slot: charge the
			// budget here, BEFORE the hash verdict, so skip / reconcile /
			// rewrite paths all account identically (review fix 2).
			if (opts.onDetailFetched) {
				await opts.onDetailFetched();
			}
			await randomDelay();
			const merged = session.mergeCard(card, detail);
			const record = toRecord(merged, syncedAt, collection);
			// Content hash over the source-data fields only (M3): note_id /
			// type / title / desc / author_id / tags / image URLs / video URL.
			const hash = computeNoteHash({
				note_id: record.note_id,
				type: record.type,
				title: record.title,
				desc: record.body,
				author_id: record.author_id,
				tags: record.tags,
				images: record.images,
				video_url: record.video_url,
			});
			const prev = opts.noteIndex[card.note_id];

			if (prev && prev.hash === hash) {
				result.skipped += 1;
				session.log(`hash 命中，跳过（不写不下载）：${card.note_id}`);
				return;
			}
			if (prev && prev.hash === "") {
				// Legacy migrated entry: content unknown. Reconcile = store the
				// freshly computed hash; do NOT rewrite, do NOT download media
				// (M3 contract: previously synced notes are never backfilled).
				result.skipped += 1;
				session.log(`旧版迁移条目，已对账入索引（不重写不回填）：${card.note_id}`);
				if (opts.onNoteIndexed) {
					await opts.onNoteIndexed(card.note_id, hash, prev.file ?? "");
				}
				return;
			}

			// New note OR hash changed: download media FIRST (the rendered
			// body embeds local paths for successes, remote URLs for fails).
			const media = await syncNoteMedia(
				{
					mediaFolder: opts.mediaFolder,
					noteId: record.note_id,
					imageUrls: record.images,
					videoUrl: record.video_url,
					downloadVideos: opts.downloadVideos,
				},
				vault.adapter,
				(line) => session.log(line),
			);
			const mediaMap: NoteMediaMap = {
				imageLocal: media.imageLocal,
				videoLocal: media.videoLocal,
			};
			let content = renderNoteMarkdown(record, opts.tagPrefix, mediaMap);

			// Rewrite path: preserve the old note's AI section verbatim (M3
			// hard constraint) — the block from `## 🤖 AI 摘要` to EOF moves
			// to the tail of the new content.
			if (prev?.file && (await vault.adapter.exists(prev.file))) {
				try {
					const oldContent = await vault.adapter.read(prev.file);
					content = appendAiSection(content, oldContent);
				} catch (e) {
					session.log(
						`读取旧文失败，AI 小节未能保留（继续重写）：${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}

			const name = resolveRewriteFileName(record.title, record.note_id, existing, prev?.file);
			const filePath = `${folderPrefix}${name}`;
			// Write via the adapter (disk truth): the vault-index APIs
			// depend on the folder being indexed, which breaks on stale
			// indexes (externally deleted folders). adapter.write works
			// regardless; Obsidian's file watcher refreshes the index.
			const existed = vault.getAbstractFileByPath(filePath) instanceof TFile;
			await vault.adapter.write(filePath, content);
			if (!existed) {
				existing.add(name);
			}
			// Review fix 1 (copy accumulation): an unchanged title reuses the
			// previous name (resolved by resolveRewriteFileName without the
			// old file occupying the namespace) and is rewritten IN PLACE;
			// only a genuinely changed title produces a new file, and then the
			// previous file is deleted (adapter.remove; failure = log only).
			const prevBase = prev?.file
				? prev.file.slice(prev.file.lastIndexOf("/") + 1)
				: undefined;
			if (
				prev?.file &&
				prev.file !== filePath &&
				prevBase !== name &&
				prev.file.startsWith(folderPrefix) &&
				(await vault.adapter.exists(prev.file))
			) {
				try {
					await vault.adapter.remove(prev.file);
					existing.delete(prevBase ?? "");
					session.log(`重写换名，旧文件已删除：${prev.file} -> ${filePath}`);
				} catch (e) {
					// Never fail the note because its stale copy survived.
					session.log(
						`旧文件删除失败（已保留，仅记录）：${prev.file} ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}
			result.added += 1;
			result.newNoteIds.push(record.note_id);
			session.log(
				`${prev ? "hash 变化，已重写" : "新笔记，已写入"}：${record.note_id}${collection ? `（收藏夹：${collection}）` : ""}（媒体 下载 ${media.downloaded} / 已存在 ${media.skippedExisting} / 失败 ${media.failed}）`,
			);
			// Incrementally persist the index entry the moment the note is on
			// disk so a later mid-run abort (e.g. login expiry) does not cause
			// the next run to redo these notes.
			if (opts.onNoteIndexed) {
				await opts.onNoteIndexed(record.note_id, hash, filePath);
			}
		} catch (e) {
			if (e instanceof NotLoggedInError) {
				// Session died mid-sync: surface immediately.
				throw e;
			}
			session.log(
				`单篇处理失败（计入 failed，不中断）：${card.note_id} ${e instanceof Error ? e.message : String(e)}`,
			);
			result.failed += 1;
		}
	};

	/** Gate + charge one list request (real API request, M3.1). */
	const acquireListSlot = async (): Promise<void> => {
		if (opts.acquireNoteSlot) {
			await opts.acquireNoteSlot();
		}
	};
	const chargeListRequest = async (): Promise<void> => {
		if (opts.onDetailFetched) {
			await opts.onDetailFetched();
		}
	};

	// ---- Phase A (M3.1): 收藏夹 boards first.
	let boards: RedNoteBoard[] = [];
	try {
		await acquireListSlot();
		boards = await withRetry(() => session.fetchUserBoards(userId));
		await chargeListRequest();
	} catch (e) {
		if (e instanceof NotLoggedInError) {
			throw e;
		}
		// Boards are an enhancement, not a hard dependency: fall back to the
		// flat collect list (failure stays on record in debug.log).
		session.log(
			`收藏夹列表拉取失败，回退 flat 收藏列表：${e instanceof Error ? e.message : String(e)}`,
		);
	}
	result.boardsFetched = boards.length;

	for (const board of boards) {
		let boardCards = 0;
		let boardCursor = "";
		let boardPage = 0;
		let boardFinished = false;
		while (!boardFinished) {
			boardPage += 1;
			opts.onPage?.(boardPage);
			let p: RedNotePage;
			let rawDups = 0;
			try {
				await acquireListSlot();
				const fetched = await withRetry(() =>
					session.fetchBoardNotes(board.board_id, boardCursor),
				);
				p = fetched.page;
				rawDups = fetched.rawDuplicates;
				await chargeListRequest();
			} catch (e) {
				if (e instanceof NotLoggedInError) {
					throw e;
				}
				session.log(
					`收藏夹「${board.name || board.board_id}」第 ${boardPage} 页拉取失败，跳过该收藏夹剩余页：${e instanceof Error ? e.message : String(e)}`,
				);
				break;
			}
			logPageDiag(session, "board/note", boardPage, p, rawDups);
			boardCards += p.items.length;
			const { fresh, duplicates } = splitSeen(p.items, seen);
			result.duplicates += duplicates;
			for (const card of fresh) {
				await processNote(card, board.name);
			}
			// Pagination termination (identical guard as the flat loop).
			if (!p.has_more || !p.next_cursor) {
				boardFinished = true;
				break;
			}
			boardCursor = p.next_cursor;
			await randomDelay();
		}
		result.boardNoteCounts.push({ id: board.board_id, name: board.name, notes: boardCards });
	}

	// ---- Phase B: flat collect/page fallback (ungrouped favorites,
	// collection stays ""). Cards already claimed by a board are skipped by
	// splitSeen BEFORE any request is made.
	let cursor = "";
	let page = 0;
	let finished = false;
	while (!finished) {
		page += 1;
		opts.onPage?.(page);
		const fetched = await withRetry(() => session.fetchFavoritesPage(userId, cursor));
		const p = fetched.page;
		logPageDiag(session, "collect/page", page, p, fetched.rawDuplicates);
		result.flatNotes += p.items.length;
		const { fresh, duplicates } = splitSeen(p.items, seen);
		result.duplicates += duplicates;
		for (const card of fresh) {
			await processNote(card, "");
		}

		// Pagination termination.
		if (!p.has_more || !p.next_cursor) {
			finished = true;
			break;
		}
		cursor = p.next_cursor;
		await randomDelay();
	}

	// End-of-run diagnostic summary (M3.1).
	const boardLine = result.boardNoteCounts
		.map((b) => `${b.name || b.id}:${b.notes}`)
		.join("，");
	session.log(
		`同步汇总：收藏夹 ${result.boardsFetched} 个（${boardLine || "无"}）；flat 收藏卡片 ${result.flatNotes} 条；` +
			`新增 ${result.added} / 跳过 ${result.skipped} / 失败 ${result.failed} / 运行内重复去重 ${result.duplicates}`,
	);

	return result;
}

/**
 * Convenience: format the completion summary text (a single Notice string).
 */
export function makeSummaryNotice(r: SyncResult): string {
	return `同步完成：新增 ${r.added} 篇 / 跳过 ${r.skipped} 篇 / 失败 ${r.failed} 篇`;
}
