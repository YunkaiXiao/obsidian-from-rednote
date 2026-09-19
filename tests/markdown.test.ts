import { describe, it, expect } from "vitest";
import {
	yamlScalar,
	epochToIso,
	isoToDateOnly,
	applyTagPrefix,
	renderNoteMarkdown,
	fixMediaEmbedPaths,
	splitAiSection,
	appendAiSection,
	type NoteMediaMap,
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

describe("renderNoteMarkdown with M3 media map", () => {
	it("embeds downloaded images as vault-absolute paths (/ prefix)", () => {
		const media: NoteMediaMap = {
			imageLocal: ["RedNote/Media/65f2a8b3000000001234abcd/1.webp", null],
			videoLocal: null,
		};
		const md = renderNoteMarkdown(
			sampleRecord({ images: ["https://cdn/1.webp", "https://cdn/2.webp"] }),
			"xhs/",
			media,
		);
		expect(md).toContain(
			"![](/RedNote/Media/65f2a8b3000000001234abcd/1.webp)",
		);
		// Slot without a local file keeps the remote URL.
		expect(md).toContain("![](https://cdn/2.webp)");
	});

	it("keeps all-remote URLs when every download failed (all-null slots)", () => {
		const md = renderNoteMarkdown(sampleRecord(), "xhs/", {
			imageLocal: [null],
			videoLocal: null,
		});
		expect(md).toContain("![](https://cdn/1.webp)");
	});

	it("links a downloaded video locally as [▶ 视频](path)", () => {
		const md = renderNoteMarkdown(
			sampleRecord({ type: "video", video_url: "http://video/1.mp4", images: [] }),
			"xhs/",
			{ imageLocal: [], videoLocal: "RedNote/Media/65f2a8b3000000001234abcd/video.mp4" },
		);
		expect(md).toContain(
			"[▶ 视频](/RedNote/Media/65f2a8b3000000001234abcd/video.mp4)",
		);
		expect(md).not.toContain("[▶ 观看视频]");
	});

	it("falls back to the remote video link when not downloaded (toggle off / failed)", () => {
		const md = renderNoteMarkdown(
			sampleRecord({ type: "video", video_url: "http://video/1.mp4", images: [] }),
			"xhs/",
			{ imageLocal: [], videoLocal: null },
		);
		expect(md).toContain("[▶ 观看视频](http://video/1.mp4)");
	});
});

describe("splitAiSection", () => {
	const OLD = `---
note_id: "x"
---

# 标题

正文

## 🤖 AI 摘要
### 视频转写
（转写文字稿）
`;

	it("returns null when there is no AI section", () => {
		expect(splitAiSection("# 标题\n\n正文\n")).toBeNull();
		expect(splitAiSection("")).toBeNull();
	});

	it("returns the block from the heading to EOF, verbatim", () => {
		const ai = splitAiSection(OLD);
		expect(ai).not.toBeNull();
		expect(ai).toBe("## 🤖 AI 摘要\n### 视频转写\n（转写文字稿）\n");
	});

	it("handles the heading as the very first line", () => {
		expect(splitAiSection("## 🤖 AI 摘要\n内容")).toBe("## 🤖 AI 摘要\n内容");
	});
});

describe("appendAiSection", () => {
	const NEW = `---
note_id: "x"
---

# 标题

新正文
`;
	const OLD_WITH_AI = `# 标题\n\n旧正文\n\n## 🤖 AI 摘要\n### 图片分析\n（描述）\n`;
	const OLD_WITHOUT_AI = `# 标题\n\n旧正文\n`;

	it("appends the preserved AI block after one blank line", () => {
		const out = appendAiSection(NEW, OLD_WITH_AI);
		expect(out).toBe(NEW + "\n## 🤖 AI 摘要\n### 图片分析\n（描述）\n");
		expect(out).toContain("新正文\n\n## 🤖 AI 摘要");
	});

	it("returns new content unchanged when the old note has no AI section", () => {
		expect(appendAiSection(NEW, OLD_WITHOUT_AI)).toBe(NEW);
	});
});

describe("renderNoteMarkdown video link", () => {
	it("renders the [▶ 观看视频] remote link when a video note has video_url", () => {
		const md = renderNoteMarkdown(
			{
				note_id: "v1",
				type: "video",
				title: "视频笔记",
				body: "正文",
				author: "作者",
				author_id: "u1",
				author_link: "https://www.xiaohongshu.com/user/profile/u1",
				link: "https://www.xiaohongshu.com/explore/v1",
				tags: [],
				images: [],
				video_url: "https://sns-video-bd.xhscdn.com/abc",
				created_at: "2026-09-01T10:30:00+08:00",
				collected_at: "",
				collection: "",
				synced_at: "2026-09-20T00:00:00+08:00",
			},
			"xhs/",
		);
		expect(md).toContain("[▶ 观看视频](https://sns-video-bd.xhscdn.com/abc)");
	});
});

describe("body horizontal-rule sanitization", () => {
	it("rewrites standalone --- body lines to *** (frontmatter fences intact)", () => {
		const md = renderNoteMarkdown(sampleRecord({ body: "第一段\n---\n第二段" }), "xhs/");
		// Exactly the two frontmatter fences remain as standalone --- lines.
		expect(md.startsWith("---\n")).toBe(true);
		expect(md.match(/^[ \t]*---[ \t]*$/gm)).toHaveLength(2);
		expect(md).toContain("第一段\n***\n第二段");
	});

	it("leaves inline --- and non-line occurrences untouched", () => {
		const md = renderNoteMarkdown(sampleRecord({ body: "a---b\n----x" }), "xhs/");
		expect(md).toContain("a---b");
		expect(md).toContain("----x");
	});
});

describe("fixMediaEmbedPaths", () => {
	it("rewrites relative media embeds to vault-absolute and counts them", () => {
		const src = "看图\n![](RedNote/Media/n1/1.webp)\n[▶ 视频](RedNote/Media/n1/v.mp4)\n![](https://cdn/x.webp)";
		const { text, replaced } = fixMediaEmbedPaths(src, "RedNote/Media");
		expect(replaced).toBe(2);
		expect(text).toContain("![](/RedNote/Media/n1/1.webp)");
		expect(text).toContain("[▶ 视频](/RedNote/Media/n1/v.mp4)");
		// Remote URL untouched.
		expect(text).toContain("![](https://cdn/x.webp)");
	});

	it("does not double-slash already-absolute embeds and is then a no-op", () => {
		const src = "![](/RedNote/Media/n1/1.webp)";
		const once = fixMediaEmbedPaths(src, "RedNote/Media");
		expect(once.replaced).toBe(0);
		expect(once.text).toBe(src);
	});

	it("returns unchanged text for an empty mediaFolder", () => {
		const src = "![](RedNote/Media/n1/1.webp)";
		const r = fixMediaEmbedPaths(src, "");
		expect(r.replaced).toBe(0);
		expect(r.text).toBe(src);
	});
});
