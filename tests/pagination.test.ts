import { describe, it, expect } from "vitest";
import {
	parseListPage,
	shouldContinue,
	normalizeListItem,
	parseBoardList,
	countRawDuplicates,
	splitSeen,
} from "../src/rednote/pagination";

describe("parseListPage", () => {
	it("parses items, has_more and next_cursor from a normal page", () => {
		const data = {
			notes: [
				{ note_id: "n1", type: "image", xsec_token: "t1", xsec_source: "pc_collect" },
				{ note_id: "n2", type: "video", xsec_token: "t2", xsec_source: "pc_collect" },
			],
			has_more: true,
			cursor: "cursor-2",
		};
		const page = parseListPage(data);
		expect(page.items).toHaveLength(2);
		const first = page.items[0];
		const second = page.items[1];
		expect(first?.note_id).toBe("n1");
		expect(second?.type).toBe("video");
		expect(page.has_more).toBe(true);
		expect(page.next_cursor).toBe("cursor-2");
	});

	it("treats missing/undefined data as an empty page", () => {
		expect(parseListPage(undefined)).toEqual({ items: [], has_more: false, next_cursor: "" });
		expect(parseListPage(null)).toEqual({ items: [], has_more: false, next_cursor: "" });
	});

	it("dedupes notes by note_id within a page", () => {
		const data = {
			notes: [
				{ note_id: "n1" },
				{ note_id: "n1" },
				{ note_id: "n2" },
			],
			has_more: false,
			cursor: "",
		};
		expect(parseListPage(data).items.map((i) => i.note_id)).toEqual(["n1", "n2"]);
	});

	it("ignores items without a note_id", () => {
		const data = {
			notes: [{ title: "no id" }, { note_id: "ok" }],
			has_more: false,
			cursor: "",
		};
		expect(parseListPage(data).items.map((i) => i.note_id)).toEqual(["ok"]);
	});

	it("coerces has_more to a strict boolean (truthy non-boolean is false)", () => {
		expect(parseListPage({ notes: [], has_more: 1, cursor: "c" }).has_more).toBe(false);
		expect(parseListPage({ notes: [], has_more: "true", cursor: "c" }).has_more).toBe(false);
		expect(parseListPage({ notes: [], has_more: true, cursor: "c" }).has_more).toBe(true);
	});

	it("normalizes a non-string cursor to empty", () => {
		expect(parseListPage({ notes: [], has_more: true, cursor: 42 }).next_cursor).toBe("");
	});
});

describe("shouldContinue", () => {
	it("continues only when has_more AND a non-empty cursor", () => {
		expect(shouldContinue({ items: [], has_more: true, next_cursor: "c" })).toBe(true);
		expect(shouldContinue({ items: [], has_more: true, next_cursor: "" })).toBe(false);
		expect(shouldContinue({ items: [], has_more: false, next_cursor: "c" })).toBe(false);
		expect(shouldContinue({ items: [], has_more: false, next_cursor: "" })).toBe(false);
	});
});

describe("normalizeListItem", () => {
	it("normalizes numeric time to ms and image urls", () => {
		// Card-level media are URL strings; non-string entries are dropped.
		// (The full image_list of {url,url_default} objects is a detail field.)
		const n = normalizeListItem({
			note_id: "n",
			type: "image",
			time: 1727749800000,
			images: ["https://cdn/1.webp", "not-a-string", "https://cdn/2.webp"],
		});
		expect(n.time_ms).toBe(1727749800000);
		expect(n.images).toEqual(["https://cdn/1.webp", "https://cdn/2.webp"]);
	});

	it("drops unknown type values", () => {
		expect(normalizeListItem({ note_id: "n", type: "weird" }).type).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// M3.1: board (收藏夹) helpers.
// ---------------------------------------------------------------------------

describe("parseBoardList (tolerant board/user extraction)", () => {
	it("extracts board_id + board_name and keeps the raw object", () => {
		const raw = { board_id: "b1", board_name: "默认收藏夹", note_count: 3 };
		const boards = parseBoardList({ boards: [raw] });
		expect(boards).toHaveLength(1);
		expect(boards[0]?.board_id).toBe("b1");
		expect(boards[0]?.name).toBe("默认收藏夹");
		expect(boards[0]?.raw).toEqual(raw);
	});

	it("tolerates the name under name / title when board_name is absent", () => {
		expect(parseBoardList({ boards: [{ board_id: "b1", name: "n-字段" }] })[0]?.name).toBe("n-字段");
		expect(parseBoardList({ boards: [{ board_id: "b1", title: "t-字段" }] })[0]?.name).toBe("t-字段");
	});

	it("falls back to id when board_id is absent", () => {
		const boards = parseBoardList({ boards: [{ id: "b9", name: "x" }] });
		expect(boards[0]?.board_id).toBe("b9");
	});

	it("prefers the first non-empty candidate (board_name wins over name)", () => {
		const boards = parseBoardList({ boards: [{ board_id: "b1", board_name: "a", name: "b" }] });
		expect(boards[0]?.name).toBe("a");
		expect(parseBoardList({ boards: [{ board_id: "b1", board_name: "", name: "b" }] })[0]?.name).toBe("b");
	});

	it("skips entries without any id candidate and non-object entries", () => {
		const boards = parseBoardList({ boards: [{ name: "无 id" }, null, "str", { board_id: "ok" }] });
		expect(boards.map((b) => b.board_id)).toEqual(["ok"]);
		expect(boards[0]?.name).toBe("");
	});

	it("treats missing/malformed data as an empty board list", () => {
		expect(parseBoardList(undefined)).toEqual([]);
		expect(parseBoardList(null)).toEqual([]);
		expect(parseBoardList({})).toEqual([]);
		expect(parseBoardList({ boards: "not-an-array" })).toEqual([]);
	});
});

describe("countRawDuplicates (in-page diagnostic count)", () => {
	it("counts repeated note_ids within one raw page", () => {
		const items = [
			{ note_id: "n1" },
			{ note_id: "n2" },
			{ note_id: "n1" },
			{ note_id: "n1" },
			{ note_id: "n3" },
		];
		expect(countRawDuplicates(items)).toBe(2);
	});

	it("ignores non-string / missing note_ids and non-array input", () => {
		expect(countRawDuplicates([{ note_id: 42 }, { title: "x" }, { note_id: "" }])).toBe(0);
		expect(countRawDuplicates(undefined)).toBe(0);
	});

	it("returns 0 for a page without duplicates", () => {
		expect(countRawDuplicates([{ note_id: "a" }, { note_id: "b" }])).toBe(0);
	});
});

describe("splitSeen (run-scoped first-come-first-served dedupe)", () => {
	it("claims each note_id once and counts later encounters as duplicates", () => {
		const seen = new Set<string>();
		const first = splitSeen([{ note_id: "n1" }, { note_id: "n2" }], seen);
		expect(first.fresh.map((i) => i.note_id)).toEqual(["n1", "n2"]);
		expect(first.duplicates).toBe(0);

		// Same note again in a later page/board -> duplicate, not reprocessed.
		const second = splitSeen([{ note_id: "n2" }, { note_id: "n3" }], seen);
		expect(second.fresh.map((i) => i.note_id)).toEqual(["n3"]);
		expect(second.duplicates).toBe(1);
	});

	it("mutates the supplied set (run memory) and drops cards without note_id", () => {
		const seen = new Set<string>();
		const { fresh, duplicates } = splitSeen([{ note_id: "" }, { note_id: "n1" }], seen);
		expect(fresh.map((i) => i.note_id)).toEqual(["n1"]);
		expect(duplicates).toBe(0);
		expect(seen.has("n1")).toBe(true);
		// note_id-less cards never enter the set.
		expect(seen.size).toBe(1);
	});
});
