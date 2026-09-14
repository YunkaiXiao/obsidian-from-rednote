import { describe, it, expect } from "vitest";
import {
	yamlScalar,
	epochToIso,
	isoToDateOnly,
	applyTagPrefix,
	renderNoteMarkdown,
} from "../src/rednote/markdown";
import type { RedNoteRecord } from "../src/rednote/types";

function sampleRecord(over: Partial<RedNoteRecord> = {}): RedNoteRecord {
	return {
		note_id: "65f2a8b3000000001234abcd",
		type: "image",
		title: "周末去哪喝咖啡",
		body: "正文内容",
		author: "咖啡日记",
		author_id: "5f8d21ac0000000001e02b3c",
		author_link: "https://www.xiaohongshu.com/user/profile/5f8d21ac",
		link: "https://www.xiaohongshu.com/explore/65f2a8b3",
		tags: ["咖啡", "探店"],
		images: ["https://cdn/1.webp"],
		video_url: "",
		created_at: "2026-09-01T10:30:00+08:00",
		collected_at: "",
		collection: "",
		synced_at: "2026-09-14T15:20:00+08:00",
		...over,
	};
}

describe("yamlScalar", () => {
	it("quotes the value", () => {
		expect(yamlScalar("abc")).toBe('"abc"');
	});

	it("escapes double quotes and backslashes", () => {
		expect(yamlScalar(`a"b\\c`)).toBe('"a\\"b\\\\c"');
	});

	it("handles empty string", () => {
		expect(yamlScalar("")).toBe('""');
	});
});

describe("epochToIso", () => {
	it("renders +08:00 offset for a known epoch", () => {
		// 2026-09-01T02:30:00Z -> +08:00 => 2026-09-01T10:30:00+08:00
		const ms = Date.UTC(2026, 8, 1, 2, 30, 0);
		expect(epochToIso(ms, 480)).toBe("2026-09-01T10:30:00+08:00");
	});

	it("returns empty string for non-positive / non-finite ms", () => {
		expect(epochToIso(0, 480)).toBe("");
		expect(epochToIso(-1, 480)).toBe("");
		expect(epochToIso(Number.NaN, 480)).toBe("");
	});

	it("supports negative offsets", () => {
		// 2026-09-01T02:30:00Z -> -05:00 => 2026-08-31T21:30:00-05:00
		const ms = Date.UTC(2026, 8, 1, 2, 30, 0);
		expect(epochToIso(ms, -300)).toBe("2026-08-31T21:30:00-05:00");
	});
});

describe("isoToDateOnly", () => {
	it("extracts the date portion", () => {
		expect(isoToDateOnly("2026-09-01T10:30:00+08:00")).toBe("2026-09-01");
	});

	it("returns 未知 for empty", () => {
		expect(isoToDateOnly("")).toBe("未知");
	});
});

describe("applyTagPrefix", () => {
	it("applies the prefix to each tag", () => {
		expect(applyTagPrefix(["咖啡", "探店"], "xhs/")).toEqual(["xhs/咖啡", "xhs/探店"]);
	});

	it("drops empty/whitespace tags", () => {
		expect(applyTagPrefix(["", "  ", "x"], "xhs/")).toEqual(["xhs/x"]);
	});

	it("no prefix when prefix is empty", () => {
		expect(applyTagPrefix(["咖啡", "探店"], "")).toEqual(["咖啡", "探店"]);
	});
});

describe("renderNoteMarkdown", () => {
	it("renders frontmatter with the template field order", () => {
		const md = renderNoteMarkdown(sampleRecord(), "xhs/");
		const lines = md.split("\n");
		const order = ["note_id:", "type:", "title:", "author:", "author_id:", "author_link:", "link:", "collection:", "tags:"];
		let prev = -1;
		for (const key of order) {
			const idx = lines.findIndex((l) => l.startsWith(key));
			expect(idx).toBeGreaterThan(prev);
			prev = idx;
		}
	});

	it("includes the > [!info] 来源 callout", () => {
		const md = renderNoteMarkdown(sampleRecord(), "xhs/");
		expect(md).toContain("> [!info] 来源");
		expect(md).toContain("作者：[咖啡日记](https://www.xiaohongshu.com/user/profile/5f8d21ac)");
		expect(md).toContain("发布：2026-09-01");
		expect(md).toContain("[打开原文](https://www.xiaohongshu.com/explore/65f2a8b3)");
	});

	it("annotates collected_at as 不可得 in the callout when empty", () => {
		const md = renderNoteMarkdown(sampleRecord(), "xhs/");
		expect(md).toContain("收藏于：不可得");
	});

	it("embeds images as remote URLs for image notes (M2 temp)", () => {
		const md = renderNoteMarkdown(
			sampleRecord({ images: ["https://cdn/1.webp", "https://cdn/2.webp"] }),
			"xhs/",
		);
		expect(md).toContain("![](https://cdn/1.webp)");
		expect(md).toContain("![](https://cdn/2.webp)");
	});

	it("records video as a link for video notes (M2 temp)", () => {
		const md = renderNoteMarkdown(
			sampleRecord({ type: "video", video_url: "http://video/1.mp4", images: [] }),
			"xhs/",
		);
		expect(md).toContain("[▶ 观看视频](http://video/1.mp4)");
		// No image embeds for a video note.
		expect(md).not.toContain("![](");
	});

	it("renders tags with prefix in frontmatter", () => {
		const md = renderNoteMarkdown(sampleRecord(), "xhs/");
		expect(md).toContain("- xhs/咖啡");
		expect(md).toContain("- xhs/探店");
	});

	it("renders empty tags as an inline empty list", () => {
		const md = renderNoteMarkdown(sampleRecord({ tags: [] }), "xhs/");
		expect(md).toMatch(/tags:\n  \[\]/);
	});

	it("quotes values containing special chars in frontmatter", () => {
		const md = renderNoteMarkdown(sampleRecord({ title: `He said "hi"` }), "xhs/");
		expect(md).toContain(`title: "He said \\"hi\\""\n`);
	});

	it("leaves created_at/collected_at empty when not obtainable", () => {
		const md = renderNoteMarkdown(
			sampleRecord({ created_at: "", collected_at: "" }),
			"xhs/",
		);
		expect(md).toContain("created_at: \n");
		expect(md).toContain("collected_at: \n");
	});
});
