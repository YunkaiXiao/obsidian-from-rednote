import { describe, it, expect } from "vitest";
import { cleanNoteFileName, resolveNoteFileName } from "../src/rednote/filename";

describe("cleanNoteFileName", () => {
	it("strips all Windows-invalid characters", () => {
		expect(cleanNoteFileName(`a/b\\c:d*e?f"g<h>i|j`, "id")).toBe("abcdefghij");
	});

	it("collapses whitespace and trims", () => {
		expect(cleanNoteFileName("  hello   world  ", "id")).toBe("hello world");
	});

	it("strips leading and trailing dots", () => {
		expect(cleanNoteFileName("...hidden.", "id")).toBe("hidden");
	});

	it("falls back to note id when the cleaned title is empty", () => {
		expect(cleanNoteFileName("???***", "65f2a8b3")).toBe("65f2a8b3");
		expect(cleanNoteFileName("", "abc123")).toBe("abc123");
	});

	it("handles unicode titles without mangling", () => {
		expect(cleanNoteFileName("周末去哪喝咖啡", "id")).toBe("周末去哪喝咖啡");
	});
});

describe("resolveNoteFileName", () => {
	it("uses the cleaned title when there is no collision", () => {
		const taken = new Set<string>();
		expect(resolveNoteFileName("hello world", "id0001", taken)).toBe("hello world.md");
	});

	it("appends the last 4 chars of the note id on a title collision", () => {
		// note id 65f2a8b3 -> last 4 = a8b3 (per docs/note-template.md: note_id 后 4 位)
		const taken = new Set(["hello.md"]);
		expect(resolveNoteFileName("hello", "65f2a8b3", taken)).toBe("hello-a8b3.md");
	});

	it("resolves a second collision by stepping the 4-char window", () => {
		// id 65f2a8b3 -> last4 a8b3 (taken) -> next window 2a8b
		const taken = new Set(["hello.md", "hello-a8b3.md"]);
		expect(resolveNoteFileName("hello", "65f2a8b3", taken)).toBe("hello-2a8b.md");
	});

	it("keeps distinct titles distinct", () => {
		const taken = new Set<string>();
		expect(resolveNoteFileName("alpha", "idA", taken)).toBe("alpha.md");
		expect(resolveNoteFileName("beta", "idB", taken)).toBe("beta.md");
	});

	it("cleans the title before checking collisions", () => {
		const taken = new Set(["a b.md"]);
		// "a/b" cleans to "ab" which does not collide with "a b"
		expect(resolveNoteFileName("a/b", "id1", taken)).toBe("ab.md");
	});
});

import { resolveRewriteFileName } from "../src/rednote/filename";

describe("resolveRewriteFileName (M3 review fix 1: no copy accumulation)", () => {
	it("unchanged title re-resolves the SAME name in place (old file not blocking)", () => {
		// First sync wrote "标题.md"; second sync (content changed, same title)
		// must land on the same name even though the name is now taken.
		expect(
			resolveRewriteFileName("标题", "65f2a8b3", new Set(["标题.md"]), "RedNote/Bookmarks/标题.md"),
		).toBe("标题.md");
	});

	it("changed title resolves a fresh free name (old file excluded from the namespace)", () => {
		expect(
			resolveRewriteFileName(
				"新标题",
				"65f2a8b3",
				new Set(["旧标题.md"]),
				"RedNote/Bookmarks/旧标题.md",
			),
		).toBe("新标题.md");
	});

	it("a changed title colliding with ANOTHER note still gets the id suffix", () => {
		expect(
			resolveRewriteFileName(
				"别人的",
				"65f2a8b3",
				new Set(["旧标题.md", "别人的.md"]),
				"RedNote/Bookmarks/旧标题.md",
			),
		).toBe("别人的-a8b3.md");
	});

	it("without a previous file it behaves exactly like resolveNoteFileName", () => {
		expect(resolveRewriteFileName("hello", "id0001", new Set(), undefined)).toBe("hello.md");
		expect(resolveRewriteFileName("hello", "id0001", new Set(["hello.md"]), undefined)).toBe(
			"hello-0001.md",
		);
	});
});
