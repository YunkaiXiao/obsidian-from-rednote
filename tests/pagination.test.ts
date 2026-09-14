import { describe, it, expect } from "vitest";
import { parseListPage, shouldContinue, normalizeListItem } from "../src/rednote/pagination";

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
