// Side-effect module: the sync pipeline.
// Ties together the session (api.ts), extraction (extract.ts), markdown
// rendering (markdown.ts), and filename resolution (filename.ts), then writes
// .md files into the vault via obsidian's Vault API.
//
// Pure decision logic (filename, render, page parse, extraction) lives in the
// pure modules and is unit-tested; this file only orchestrates side effects.

import { TFile, TFolder, Vault } from "obsidian";
import {
	RedNoteSession,
	FetchError,
	randomDelay,
	withRetry,
} from "./api";
import { NotLoggedInError } from "./types";
import { toRecord } from "./extract";
import { renderNoteMarkdown } from "./markdown";
import { resolveNoteFileName } from "./filename";

export interface SyncOptions {
	/** Vault-relative notes folder, e.g. "RedNote/Bookmarks". */
	notesFolder: string;
	/** Tag prefix setting, e.g. "xhs/". */
	tagPrefix: string;
	/** note_ids already synced (skipped this run). */
	syncedNoteIds: ReadonlySet<string>;
	/** Called per fetched page (for the "第 N 页" progress Notice). */
	onPage?: (page: number) => void;
	/**
	 * Called once a note's .md has been successfully written to disk. The
	 * caller persists the note_id immediately (incrementally) so that if a
	 * later request aborts the run (e.g. mid-sync login expiry), the notes
	 * already written are not re-fetched / overwritten on the next run.
	 */
	onNotePersisted?: (noteId: string) => Promise<void> | void;
	/**
	 * Rate-limit gate (feature #14), called before each NEW note's detail
	 * fetch. Resolves when processing may proceed; the implementation (main
	 * layer) owns the wait/Notice/persistence side effects and may therefore
	 * resolve late (after the rate-limit window rolls over).
	 */
	acquireNoteSlot?: () => Promise<void>;
}

export interface SyncResult {
	added: number;
	skipped: number;
	failed: number;
	/** note_ids newly written this run. */
	newNoteIds: string[];
}

/** Ensure a vault folder (and parents) exists; return it. */
async function ensureFolder(vault: Vault, folderPath: string): Promise<TFolder> {
	const clean = (folderPath ?? "").replace(/^\/+|\/+$/g, "");
	if (clean === "") {
		// Vault root: any file's parent is the root folder.
		const anyFile = vault.getFiles()[0];
		return (anyFile?.parent as TFolder) ?? (vault.getMarkdownFiles()[0]?.parent as TFolder);
	}
	const parts = clean.split("/").filter((p) => p.length > 0);
	let current: TFolder = (vault.getFiles()[0]?.parent as TFolder) ??
		(vault.getMarkdownFiles()[0]?.parent as TFolder);
	for (const part of parts) {
		const childPath = current.path ? `${current.path}/${part}` : part;
		let child = vault.getAbstractFileByPath(childPath);
		if (!child) {
			child = await vault.createFolder(childPath);
		}
		current = child as TFolder;
	}
	return current;
}

/**
 * Run the full favorites sync: paginate the collect list, fetch each note's
 * detail, render Markdown, and write a .md per new note.
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
	const result: SyncResult = { added: 0, skipped: 0, failed: 0, newNoteIds: [] };

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

	// Resolve the target folder and collect existing .md names for collision handling.
	const folder = await ensureFolder(vault, opts.notesFolder);
	const existing = new Set<string>(
		vault
			.getMarkdownFiles()
			.filter((f) => (f.parent?.path ?? "") === folder.path)
			.map((f) => f.name),
	);

	// 2. Paginate the favorites list.
	let cursor = "";
	let page = 0;
	let finished = false;
	while (!finished) {
		page += 1;
		opts.onPage?.(page);
		const p = await withRetry(() => session.fetchFavoritesPage(userId, cursor));

		for (const card of p.items) {
			if (!card.note_id) continue;
			if (opts.syncedNoteIds.has(card.note_id)) {
				result.skipped += 1;
				continue;
			}
			// 3. Fetch the detail, then render + write. The rate-limit gate runs
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
				await randomDelay();
				const merged = session.mergeCard(card, detail);
				const record = toRecord(merged, syncedAt);
				const name = resolveNoteFileName(record.title, record.note_id, existing);
				const content = renderNoteMarkdown(record, opts.tagPrefix);
				const filePath = folder.path ? `${folder.path}/${name}` : name;
				const existingFile = vault.getAbstractFileByPath(filePath);
				if (existingFile instanceof TFile) {
					await vault.modify(existingFile, content);
				} else {
					await vault.create(filePath, content);
					existing.add(name);
				}
				result.added += 1;
				result.newNoteIds.push(record.note_id);
				// Incrementally persist the note_id the moment it is on disk so
				// a later mid-run abort (e.g. login expiry) does not cause the
				// next run to re-fetch and overwrite these notes.
				if (opts.onNotePersisted) {
					await opts.onNotePersisted(record.note_id);
				}
			} catch (e) {
				if (e instanceof NotLoggedInError) {
					// Session died mid-sync: surface immediately.
					throw e;
				}
				result.failed += 1;
			}
		}

		// Pagination termination.
		if (!p.has_more || !p.next_cursor) {
			finished = true;
			break;
		}
		cursor = p.next_cursor;
		await randomDelay();
	}

	return result;
}

/**
 * Convenience: format the completion summary text (a single Notice string).
 */
export function makeSummaryNotice(r: SyncResult): string {
	return `同步完成：新增 ${r.added} 篇 / 跳过 ${r.skipped} 篇 / 失败 ${r.failed} 篇`;
}
