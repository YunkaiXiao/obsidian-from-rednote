// Unit tests for the sync pipeline's LIST-LAYER behavior (M3.2):
//  - incremental stop: a full page of known cards (settled index entry, i.e.
//    non-"" hash) ends pagination and known cards never trigger a detail
//    request;
//  - sentinel (hash "") entries still walk the reconcile path exactly once;
//  - cursor-stall defense: a next_cursor equal to the current cursor
//    terminates the loop (both the boards and the flat loops).
//
// sync.ts imports obsidian (TFile instanceof + Vault types); vitest.config.ts
// aliases "obsidian" to tests/stubs/obsidian.ts so this file runs in node.
// The session is a fake (cast through unknown) exposing exactly the methods
// syncFavorites calls; extraction/hash/render/filename run as real code.

import { beforeEach, describe, expect, it } from "vitest";
import type { DataAdapter, Vault } from "obsidian";

import { syncFavorites, type SyncOptions, type SyncResult } from "../src/rednote/sync";
import type { RedNoteSession } from "../src/rednote/api";
import { mergeNoteCard } from "../src/rednote/extract";
import type { RedNoteBoard, RedNotePage, RedNoteRaw } from "../src/rednote/types";
import type { NoteIndex } from "../src/rednote/hash";

// sync.ts's randomDelay / withRetry use window.setTimeout; node has no window.
// Shim it to an immediate macrotask so pagination delays cost ~0ms.
type SetTimeoutShim = (cb: () => void) => unknown;
(globalThis as { window?: { setTimeout: SetTimeoutShim } }).window = {
	setTimeout: (cb: () => void) => setTimeout(cb, 0),
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A canned list page as the session layer would return it. */
interface FakePage {
	items: RedNoteRaw[];
	has_more: boolean;
	cursor: string;
}

let cardSeq = 0;
function card(id: string): RedNoteRaw {
	cardSeq += 1;
	return {
		note_id: id,
		type: "image",
		title: `t-${id}`,
		desc: `d-${id}`,
		user_id: "author1",
		nickname: `nick-${cardSeq}`,
		time_ms: 1_700_000_000_000 + cardSeq,
		images: [],
		xsec_token: `tok-${id}`,
		xsec_source: "pc_collect",
	};
}

/** Deterministic per-id detail payload (mergeNoteCard consumes this shape). */
function detailOf(id: string): Record<string, unknown> {
	return {
		type: "image",
		title: `t-${id}`,
		desc: `d-${id}`,
		user: { user_id: "author1", nickname: `nick-${id}` },
		image_list: [],
		tag_list: [],
		time: 1_700_000_000_000,
	};
}

function pageOf(fp: FakePage): RedNotePage {
	return { items: fp.items, has_more: fp.has_more, next_cursor: fp.cursor };
}

interface SessionHarness {
	session: RedNoteSession;
	logs: string[];
	detailCalls: string[];
	flatRequests: string[];
	boardRequests: string[];
}

function makeSession(opts: {
	boards?: RedNoteBoard[];
	boardPages?: Record<string, FakePage[]>;
	flatPages: FakePage[];
}): SessionHarness {
	const logs: string[] = [];
	const detailCalls: string[] = [];
	const flatRequests: string[] = [];
	const boardRequests: string[] = [];
	const boardHits = new Map<string, number>();

	const fake = {
		log: (line: string): void => {
			logs.push(line);
		},
		getSelfUserId: async (): Promise<string> => "user1",
		fetchUserBoards: async (): Promise<RedNoteBoard[]> => opts.boards ?? [],
		fetchBoardNotes: async (boardId: string, cursor: string) => {
			boardRequests.push(`${boardId}@${cursor}`);
			const hits = (boardHits.get(boardId) ?? 0) + 1;
			boardHits.set(boardId, hits);
			const pg = opts.boardPages?.[boardId]?.[hits - 1];
			if (!pg) {
				throw new Error(`unexpected extra board page: ${boardId}@${cursor}`);
			}
			return { page: pageOf(pg), rawDuplicates: 0 };
		},
		fetchFavoritesPage: async (_userId: string, cursor: string) => {
			flatRequests.push(cursor);
			const pg = opts.flatPages[flatRequests.length - 1];
			if (!pg) {
				throw new Error(`unexpected extra flat page: cursor=${cursor}`);
			}
			return { page: pageOf(pg), rawDuplicates: 0 };
		},
		fetchNoteDetail: async (noteId: string): Promise<Record<string, unknown>> => {
			detailCalls.push(noteId);
			return detailOf(noteId);
		},
		mergeCard: (c: RedNoteRaw, d: Record<string, unknown> | null): RedNoteRaw =>
			mergeNoteCard(c, d),
	};
	return {
		session: fake as unknown as RedNoteSession,
		logs,
		detailCalls,
		flatRequests,
		boardRequests,
	};
}

/** In-memory vault: only the adapter paths sync.ts actually touches. */
function makeVault(): { vault: Vault; files: Map<string, string> } {
	const files = new Map<string, string>();
	const adapter = {
		exists: async (p: string): Promise<boolean> => p === "/" || files.has(p),
		mkdir: async (): Promise<void> => {},
		write: async (p: string, data: string): Promise<void> => {
			files.set(p, data);
		},
		read: async (p: string): Promise<string> => {
			const v = files.get(p);
			if (v === undefined) {
				throw new Error(`not found: ${p}`);
			}
			return v;
		},
		remove: async (p: string): Promise<void> => {
			files.delete(p);
		},
		list: async (p: string): Promise<{ files: string[] }> => ({
			files: [...files.keys()].filter((k) => k.startsWith(`${p}/`)),
		}),
	};
	const vault = {
		adapter: adapter as unknown as DataAdapter,
		getMarkdownFiles: (): Array<{ parent: { path: string }; name: string }> => [],
		getAbstractFileByPath: (): null => null,
	};
	return { vault: vault as unknown as Vault, files };
}

function baseOpts(noteIndex: NoteIndex, extra: Partial<SyncOptions>): SyncOptions {
	return {
		notesFolder: "RedNote/Bookmarks",
		tagPrefix: "xhs/",
		noteIndex,
		mediaFolder: "RedNote/Media",
		downloadVideos: false,
		...extra,
	};
}

const KNOWN_HASH = "a".repeat(64);
const oldSyncedAt = "2026-01-01T00:00:00+08:00";

/** Index entries for ids that a prior run already settled (real hashes). */
function knownIndex(ids: string[]): NoteIndex {
	const idx: NoteIndex = {};
	for (const id of ids) {
		idx[id] = { hash: KNOWN_HASH, syncedAt: oldSyncedAt, file: `RedNote/Bookmarks/old-${id}.md` };
	}
	return idx;
}

beforeEach(() => {
	cardSeq = 0;
});

// ---------------------------------------------------------------------------
// Defect 1: list-layer incremental stop
// ---------------------------------------------------------------------------

describe("syncFavorites incremental stop (M3.2)", () => {
	it("flat: 3 pages (new / mixed / all known) — details only for new cards, paging stops at page 3", async () => {
		const index = knownIndex(["K1", "K2", "K3"]);
		const h = makeSession({
			flatPages: [
				{ items: [card("N1"), card("N2")], has_more: true, cursor: "c1" },
				{ items: [card("K1"), card("N3")], has_more: true, cursor: "c2" },
				// has_more=true + a cursor: only the incremental rule can stop here.
				{ items: [card("K2"), card("K3")], has_more: true, cursor: "c3" },
			],
		});
		const indexed: Array<[string, string, string]> = [];
		const { vault, files } = makeVault();

		const result = await syncFavorites(vault, h.session, baseOpts(index, {
			onNoteIndexed: (id, hash, file) => {
				indexed.push([id, hash, file]);
			},
		}));

		// Paging stopped at page 3: exactly three list requests, "c3" never used.
		expect(h.flatRequests).toEqual(["", "c1", "c2"]);
		// Details were fetched ONLY for the new cards, each exactly once.
		expect(h.detailCalls).toEqual(["N1", "N2", "N3"]);
		// The stop line names the page where it happened.
		expect(h.logs.some((l) => l.includes("增量停止于第 3 页"))).toBe(true);
		// Known cards are accounted as skipped, new ones written.
		expect(result.added).toBe(3);
		expect(result.skipped).toBe(3);
		expect(indexed.map(([id]) => id)).toEqual(["N1", "N2", "N3"]);
		expect(files.size).toBe(3);
	});

	it("boards: pages counted independently per board — a fully known board stops at its first page", async () => {
		const index = knownIndex(["K1", "K2", "K3"]);
		const h = makeSession({
			boards: [
				{ board_id: "B1", name: "收藏夹一", raw: {} },
				{ board_id: "B2", name: "收藏夹二", raw: {} },
			],
			boardPages: {
				// B1 is fully known: stops at page 1 despite has_more + cursor.
				B1: [{ items: [card("K1"), card("K2")], has_more: true, cursor: "b1c1" }],
				// B2 has one new note, then a fully known page.
				B2: [
					{ items: [card("N9")], has_more: true, cursor: "b2c1" },
					{ items: [card("K3")], has_more: true, cursor: "b2c2" },
				],
			},
			flatPages: [{ items: [], has_more: false, cursor: "" }],
		});
		const { vault, files } = makeVault();

		const result = await syncFavorites(vault, h.session, baseOpts(index, {}));

		// B1 fetched once (stopped at its page 1); B2 fetched twice.
		expect(h.boardRequests).toEqual(["B1@", "B2@", "B2@b2c1"]);
		expect(h.detailCalls).toEqual(["N9"]);
		expect(h.logs.some((l) => l.includes("增量停止于第 1 页"))).toBe(true);
		expect(h.logs.some((l) => l.includes("增量停止于第 2 页"))).toBe(true);
		expect(result.boardNoteCounts).toEqual([
			{ id: "B1", name: "收藏夹一", notes: 2 },
			{ id: "B2", name: "收藏夹二", notes: 2 },
		]);
		expect(result.added).toBe(1);
		expect(result.skipped).toBe(3);
		expect(files.size).toBe(1);
	});

	it("sentinel entries (hash '') are not 'known': reconciled once, no rewrite, paging continues", async () => {
		const index: NoteIndex = {
			S1: { hash: "", syncedAt: oldSyncedAt },
			K1: { hash: KNOWN_HASH, syncedAt: oldSyncedAt, file: "RedNote/Bookmarks/old-K1.md" },
		};
		const h = makeSession({
			flatPages: [
				{ items: [card("S1")], has_more: true, cursor: "c1" },
				{ items: [card("K1")], has_more: true, cursor: "c2" },
			],
		});
		const indexed = new Map<string, { hash: string; file: string }>();
		const { vault, files } = makeVault();

		const result = await syncFavorites(vault, h.session, baseOpts(index, {
			onNoteIndexed: (id, hash, file) => {
				indexed.set(id, { hash, file });
			},
		}));

		// Page 1 held only the sentinel -> NOT fully known -> page 2 was fetched;
		// page 2 is fully known -> stopped there.
		expect(h.flatRequests).toEqual(["", "c1"]);
		// The sentinel was reconciled (one detail fetch, hash stored, no write);
		// the known card got no request at all.
		expect(h.detailCalls).toEqual(["S1"]);
		expect(indexed.get("S1")?.hash).toHaveLength(64);
		expect(indexed.get("S1")?.file).toBe("");
		expect(h.logs.some((l) => l.includes("已对账入索引"))).toBe(true);
		expect(h.logs.some((l) => l.includes("增量停止于第 2 页"))).toBe(true);
		expect(result.added).toBe(0);
		expect(result.skipped).toBe(2);
		expect([...files.keys()].some((k) => k.includes("S1"))).toBe(false);
	});

	it("a page made purely of run-scoped duplicates does not count as fully known (boards may share notes)", async () => {
		const h = makeSession({
			boards: [
				{ board_id: "B1", name: "一", raw: {} },
				{ board_id: "B2", name: "二", raw: {} },
			],
			boardPages: {
				B1: [{ items: [card("X1"), card("X2")], has_more: false, cursor: "" }],
				// B2's first page repeats B1's notes entirely, then its own page 2
				// has unique content — pagination must NOT stop on the dup page.
				B2: [
					{ items: [card("X1"), card("X2")], has_more: true, cursor: "b2c1" },
					{ items: [card("X3")], has_more: false, cursor: "" },
				],
			},
			flatPages: [{ items: [], has_more: false, cursor: "" }],
		});
		const { vault } = makeVault();

		const result = await syncFavorites(vault, h.session, baseOpts({}, {}));

		expect(h.boardRequests).toEqual(["B1@", "B2@", "B2@b2c1"]);
		expect(h.detailCalls).toEqual(["X1", "X2", "X3"]);
		expect(result.duplicates).toBe(2);
		expect(result.added).toBe(3);
		expect(h.logs.some((l) => l.includes("增量停止于"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Defect 2: cursor-stall defense
// ---------------------------------------------------------------------------

describe("syncFavorites cursor-stall defense (M3.2)", () => {
	it("flat: a next_cursor equal to the current cursor terminates pagination", async () => {
		const h = makeSession({
			flatPages: [
				// The observed live failure: consecutive pages return the SAME
				// cursor (page 1 -> "CUR", page 2 -> "CUR" again).
				{ items: [card("A1")], has_more: true, cursor: "CUR" },
				{ items: [card("A2")], has_more: true, cursor: "CUR" },
			],
		});
		const { vault } = makeVault();

		const result = await syncFavorites(vault, h.session, baseOpts({}, {}));

		expect(h.flatRequests).toEqual(["", "CUR"]);
		expect(h.detailCalls).toEqual(["A1", "A2"]);
		expect(h.logs.some((l) => l.includes("cursor 未推进，终止翻页"))).toBe(true);
		expect(result.flatNotes).toBe(2);
	});

	it("boards: a non-advancing cursor terminates that board's pagination", async () => {
		const h = makeSession({
			boards: [{ board_id: "B1", name: "卡死夹", raw: {} }],
			boardPages: {
				B1: [
					{ items: [card("C1")], has_more: true, cursor: "X" },
					{ items: [card("C2")], has_more: true, cursor: "X" },
				],
			},
			flatPages: [{ items: [], has_more: false, cursor: "" }],
		});
		const { vault } = makeVault();

		const result = await syncFavorites(vault, h.session, baseOpts({}, {}));

		expect(h.boardRequests).toEqual(["B1@", "B1@X"]);
		expect(h.detailCalls).toEqual(["C1", "C2"]);
		expect(h.logs.some((l) => l.includes("cursor 未推进，终止翻页"))).toBe(true);
		expect(result.boardNoteCounts).toEqual([{ id: "B1", name: "卡死夹", notes: 2 }]);
	});
});

// ---------------------------------------------------------------------------
// Pre-existing behavior that must survive the M3.2 changes
// ---------------------------------------------------------------------------

describe("syncFavorites baseline (guard against regressions)", () => {
	it("an all-new run still pages to the end and writes every note", async () => {
		const h = makeSession({
			flatPages: [
				{ items: [card("W1")], has_more: true, cursor: "c1" },
				{ items: [card("W2")], has_more: false, cursor: "" },
			],
		});
		const { vault } = makeVault();

		const result: SyncResult = await syncFavorites(vault, h.session, baseOpts({}, {}));

		expect(h.flatRequests).toEqual(["", "c1"]);
		expect(h.detailCalls).toEqual(["W1", "W2"]);
		expect(result.added).toBe(2);
		expect(result.newNoteIds.sort()).toEqual(["W1", "W2"]);
		expect(h.logs.some((l) => l.includes("增量停止于"))).toBe(false);
	});
});
