import { describe, it, expect } from "vitest";
import {
	computeNoteHash,
	normalizeUrlForHash,
	migrateLegacyNoteIds,
	hasLegacyNoteIds,
	type NoteHashInput,
	type NoteIndex,
} from "../src/rednote/hash";

function sampleInput(over: Partial<NoteHashInput> = {}): NoteHashInput {
	return {
		note_id: "65f2a8b3000000001234abcd",
		type: "image",
		title: "周末去哪喝咖啡",
		desc: "正文内容",
		author_id: "5f8d21ac0000000001e02b3c",
		tags: ["咖啡", "探店"],
		images: ["https://cdn/1.webp", "https://cdn/2.webp"],
		video_url: "",
		...over,
	};
}

describe("computeNoteHash", () => {
	it("is stable: same input -> same output", () => {
		expect(computeNoteHash(sampleInput())).toBe(computeNoteHash(sampleInput()));
	});

	it("returns a 64-char lowercase sha256 hex string", () => {
		const h = computeNoteHash(sampleInput());
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is sensitive to note_id", () => {
		expect(computeNoteHash(sampleInput({ note_id: "other" }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to type", () => {
		expect(computeNoteHash(sampleInput({ type: "video" }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to title", () => {
		expect(computeNoteHash(sampleInput({ title: "新标题" }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to desc", () => {
		expect(computeNoteHash(sampleInput({ desc: "改过的正文" }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to author_id", () => {
		expect(computeNoteHash(sampleInput({ author_id: "abc" }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to tag content", () => {
		expect(computeNoteHash(sampleInput({ tags: ["咖啡", "探店", "新话题"] }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to tag order (order shapes the rendered note)", () => {
		expect(computeNoteHash(sampleInput({ tags: ["探店", "咖啡"] }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to the image URL list", () => {
		expect(computeNoteHash(sampleInput({ images: ["https://cdn/1.webp"] }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("is sensitive to image order (order shapes the rendered embeds)", () => {
		expect(
			computeNoteHash(sampleInput({ images: ["https://cdn/2.webp", "https://cdn/1.webp"] })),
		).not.toBe(computeNoteHash(sampleInput()));
	});

	it("is sensitive to video_url", () => {
		expect(computeNoteHash(sampleInput({ video_url: "http://v/1.mp4" }))).not.toBe(
			computeNoteHash(sampleInput()),
		);
	});

	it("ignores non-contract fields by construction (syncedAt etc. live on the record, not the input)", () => {
		// The hash input type has no synced_at field: two calls at different
		// times with identical source data MUST hash identically.
		const a = computeNoteHash(sampleInput());
		const b = computeNoteHash(sampleInput());
		expect(a).toBe(b);
	});

	it("tolerates missing/empty fields without throwing", () => {
		const h = computeNoteHash({
			note_id: "x",
			type: "",
			title: "",
			desc: "",
			author_id: "",
			tags: [],
			images: [],
			video_url: "",
		});
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	it("ignores rotating query tokens on image URLs (same path, different query -> same hash)", () => {
		const base = computeNoteHash(
			sampleInput({ images: ["https://cdn.xhscdn.com/2026/a/1.webp?token=aaa"] }),
		);
		const rotated = computeNoteHash(
			sampleInput({ images: ["https://cdn.xhscdn.com/2026/a/1.webp?token=bbb&x=1"] }),
		);
		expect(rotated).toBe(base);
	});

	it("ignores the query token on the video URL", () => {
		const base = computeNoteHash(sampleInput({ video_url: "http://v/1.mp4?k=aaa" }));
		expect(computeNoteHash(sampleInput({ video_url: "http://v/1.mp4?k=bbb" }))).toBe(base);
	});

	it("still hashes differently when the URL PATH changes", () => {
		const base = computeNoteHash(
			sampleInput({ images: ["https://cdn.xhscdn.com/2026/a/1.webp"] }),
		);
		expect(
			computeNoteHash(sampleInput({ images: ["https://cdn.xhscdn.com/2026/a/2.webp"] })),
		).not.toBe(base);
		expect(computeNoteHash(sampleInput({ video_url: "http://v/2.mp4" }))).not.toBe(
			computeNoteHash(sampleInput({ video_url: "http://v/1.mp4" })),
		);
	});
});

describe("normalizeUrlForHash", () => {
	it("strips the query string and fragment, keeps the path", () => {
		expect(normalizeUrlForHash("http://x/a.webp?token=1&b=2")).toBe("http://x/a.webp");
		expect(normalizeUrlForHash("http://x/a.webp#frag")).toBe("http://x/a.webp");
		expect(normalizeUrlForHash("http://x/a.webp?q=1#frag")).toBe("http://x/a.webp");
	});

	it("returns URLs without query/fragment unchanged", () => {
		expect(normalizeUrlForHash("http://x/a.webp")).toBe("http://x/a.webp");
	});

	it("tolerates empty input", () => {
		expect(normalizeUrlForHash("")).toBe("");
	});
});

describe("migrateLegacyNoteIds", () => {
	it("converts a legacy id array into entries with empty hash", () => {
		const idx = migrateLegacyNoteIds(["a", "b"], {}, "2026-09-17T00:00:00+08:00");
		expect(idx["a"]).toEqual({ hash: "", syncedAt: "2026-09-17T00:00:00+08:00" });
		expect(idx["b"]).toEqual({ hash: "", syncedAt: "2026-09-17T00:00:00+08:00" });
	});

	it("never overwrites existing index entries", () => {
		const base: NoteIndex = {
			a: { hash: "deadbeef", syncedAt: "2026-01-01T00:00:00+08:00", file: "RedNote/Bookmarks/a.md" },
		};
		const idx = migrateLegacyNoteIds(["a", "b"], base, "2026-09-17T00:00:00+08:00");
		expect(idx["a"]).toBe(base["a"]); // untouched (same reference)
		expect(idx["b"]?.hash).toBe("");
	});

	it("drops non-string and empty ids", () => {
		const idx = migrateLegacyNoteIds(["ok", 42, null, "", undefined], {}, "t");
		expect(Object.keys(idx)).toEqual(["ok"]);
	});

	it("collapses duplicates", () => {
		const idx = migrateLegacyNoteIds(["x", "x", "x"], {}, "t");
		expect(Object.keys(idx)).toEqual(["x"]);
	});

	it("returns the base unchanged for a non-array legacy value", () => {
		const base: NoteIndex = { z: { hash: "h", syncedAt: "t" } };
		for (const legacy of [undefined, null, "not-an-array", { a: 1 }]) {
			const idx = migrateLegacyNoteIds(legacy, base, "t");
			expect(idx).toEqual(base);
		}
	});
});

describe("hasLegacyNoteIds", () => {
	it("is true only for arrays", () => {
		expect(hasLegacyNoteIds(["a"])).toBe(true);
		expect(hasLegacyNoteIds([])).toBe(true);
		expect(hasLegacyNoteIds(undefined)).toBe(false);
		expect(hasLegacyNoteIds({})).toBe(false);
		expect(hasLegacyNoteIds("syncedNoteIds")).toBe(false);
	});
});
