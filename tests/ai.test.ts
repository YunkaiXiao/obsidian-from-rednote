// Unit tests for the M4.1 AI module's PURE helpers (request body build,
// response parse, local-image extraction, frontmatter probe, AI-section
// merge, batch split, base64). analyzeImages's transport itself needs Node
// https + real files and is intentionally not unit-tested here.

import { describe, expect, it } from "vitest";

import {
	arrayBufferToBase64,
	buildVideoRequestBody,
	buildVisionRequestBody,
	chunkArray,
	extractLocalImagePaths,
	extractVideoNoteUrl,
	frontmatterHasImageAnalysis,
	frontmatterTypeIsVideo,
	imageMimeFromPath,
	IMAGE_ANALYSIS_PROMPT,
	parseVideoKeyMoments,
	renderKeyFramesSection,
	renderKeyMomentsFallback,
	applyKeyFrames,
	extractKeyFrames,
	resetFfmpegProbe,
	parseChatCompletion,
	applyImageAnalysis,
	applyVideoTranscript,
} from "../src/rednote/ai";

describe("imageMimeFromPath", () => {
	it("maps common extensions", () => {
		expect(imageMimeFromPath("RedNote/Media/abc/1.jpg")).toBe("image/jpeg");
		expect(imageMimeFromPath("RedNote/Media/abc/2.JPEG")).toBe("image/jpeg");
		expect(imageMimeFromPath("a/b.PNG")).toBe("image/png");
		expect(imageMimeFromPath("a/b.webp")).toBe("image/webp");
		expect(imageMimeFromPath("a/b.gif")).toBe("image/gif");
	});

	it("returns empty for unknown extensions", () => {
		expect(imageMimeFromPath("a/b.txt")).toBe("");
		expect(imageMimeFromPath("a/b")).toBe("");
		expect(imageMimeFromPath("")).toBe("");
	});
});

describe("arrayBufferToBase64", () => {
	it("round-trips ascii bytes", () => {
		const buf = new TextEncoder().encode("hello world").buffer as ArrayBuffer;
		expect(arrayBufferToBase64(buf)).toBe(btoa("hello world"));
	});

	it("handles binary values > 127 across chunk boundaries", () => {
		const bytes = new Uint8Array(0x8002); // spans two 0x8000 chunks
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = i % 256;
		}
		const b64 = arrayBufferToBase64(bytes.buffer as ArrayBuffer);
		const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		expect(Array.from(back)).toEqual(Array.from(bytes));
	});
});

describe("buildVisionRequestBody", () => {
	it("builds text + image_url content array", () => {
		const body = buildVisionRequestBody("gpt-4o-mini", IMAGE_ANALYSIS_PROMPT, [
			"data:image/jpeg;base64,AAA",
			"data:image/png;base64,BBB",
		]);
		expect(body["model"]).toBe("gpt-4o-mini");
		const messages = body["messages"] as Array<{ role: string; content: unknown }>;
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		const content = messages[0]?.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[0]).toEqual({ type: "text", text: IMAGE_ANALYSIS_PROMPT });
		expect(content[1]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/jpeg;base64,AAA" },
		});
		expect(content[2]).toEqual({
			type: "image_url",
			image_url: { url: "data:image/png;base64,BBB" },
		});
	});

	it("omits model when empty (server default)", () => {
		const body = buildVisionRequestBody("", "p", ["data:image/png;base64,X"]);
		expect("model" in body).toBe(false);
	});

	it("produces zero images -> prompt-only content", () => {
		const body = buildVisionRequestBody("m", "p", []);
		const content = (body["messages"] as Array<{ content: unknown[] }>)[0]
			?.content;
		expect(content).toHaveLength(1);
	});
});

describe("parseChatCompletion", () => {
	it("extracts choices[0].message.content", () => {
		const r = parseChatCompletion(
			JSON.stringify({ choices: [{ message: { content: "分析结果" } }] }),
		);
		expect(r).toEqual({ text: "分析结果" });
	});

	it("returns error for API error payloads", () => {
		const r = parseChatCompletion(
			JSON.stringify({ error: { message: "bad key" } }),
		);
		expect("error" in r && r.error.includes("bad key")).toBe(true);
	});

	it("returns error for non-JSON", () => {
		const r = parseChatCompletion("<html>oops</html>");
		expect("error" in r).toBe(true);
	});

	it("returns error when content missing", () => {
		const r = parseChatCompletion(JSON.stringify({ choices: [] }));
		expect("error" in r).toBe(true);
	});
});

describe("extractLocalImagePaths", () => {
	const md = [
		"正文",
		"",
		"![](RedNote/Media/note1/1.jpg)",
		"![](https://sns-img.example/x.jpg)",
		"![](RedNote/Media/note1/1.jpg)",
		"![](RedNote/Media/note1/2.png)",
		"[▶ 视频](RedNote/Media/note1/v.mp4)",
	].join("\n");

	it("keeps only local media embeds, deduped, order preserved", () => {
		expect(extractLocalImagePaths(md, "RedNote/Media")).toEqual([
			"RedNote/Media/note1/1.jpg",
			"RedNote/Media/note1/2.png",
		]);
	});

	it("ignores non-image markdown links", () => {
		expect(
			extractLocalImagePaths("[▶ 视频](RedNote/Media/v.mp4)", "RedNote/Media"),
		).toEqual([]);
	});

	it("honors a custom media prefix", () => {
		expect(extractLocalImagePaths(md, "Other/Media")).toEqual([]);
	});

	it("returns empty for empty input", () => {
		expect(extractLocalImagePaths("", "RedNote/Media")).toEqual([]);
	});
});

const NOTE_WITH_FM = [
	"---",
	'note_id: "abc"',
	'type: "image"',
	"tags:",
	"  - xhs/咖啡",
	"---",
	"# 标题",
	"",
	"![](RedNote/Media/abc/1.jpg)",
].join("\n");

describe("frontmatterHasImageAnalysis", () => {
	it("false when ai_sections absent", () => {
		expect(frontmatterHasImageAnalysis(NOTE_WITH_FM)).toBe(false);
	});

	it("false when no frontmatter", () => {
		expect(frontmatterHasImageAnalysis("# 无 frontmatter")).toBe(false);
		expect(frontmatterHasImageAnalysis("")).toBe(false);
	});

	it("true for block-list marker", () => {
		const c = NOTE_WITH_FM.replace(
			"---\n# 标题",
			"ai_sections:\n  - image_analysis\n---\n# 标题",
		);
		expect(frontmatterHasImageAnalysis(c)).toBe(true);
	});

	it("true for inline-list marker", () => {
		const c = NOTE_WITH_FM.replace(
			"---\n# 标题",
			"ai_sections: [transcript, image_analysis]\n---\n# 标题",
		);
		expect(frontmatterHasImageAnalysis(c)).toBe(true);
	});

	it("false when block list has only other markers", () => {
		const c = NOTE_WITH_FM.replace(
			"---\n# 标题",
			"ai_sections:\n  - transcript\n---\n# 标题",
		);
		expect(frontmatterHasImageAnalysis(c)).toBe(false);
	});
});

describe("applyImageAnalysis", () => {
	it("creates AI section + frontmatter markers on a fresh note", () => {
		const out = applyImageAnalysis(NOTE_WITH_FM, "glm-4v", "图片内容概述");
		expect(out).toContain("## 🤖 AI 摘要");
		expect(out).toContain("### 图片分析\n图片内容概述");
		expect(out).toContain('ai_model: "glm-4v"');
		expect(out).toContain("ai_sections:");
		expect(out).toContain("  - image_analysis");
		// Original body preserved verbatim.
		expect(out).toContain("# 标题");
		expect(out).toContain("![](RedNote/Media/abc/1.jpg)");
		expect(out).toContain("  - xhs/咖啡");
		// Section lands after the body.
		expect(out.indexOf("![](RedNote/Media/abc/1.jpg)")).toBeLessThan(
			out.indexOf("## 🤖 AI 摘要"),
		);
	});

	it("preserves sibling AI subsections and replaces an existing 图片分析 block", () => {
		const withAi =
			`${NOTE_WITH_FM}\n\n## 🤖 AI 摘要\n\n### 视频转写\n旧转写\n\n### 图片分析\n旧分析\n`;
		const out = applyImageAnalysis(withAi, "glm-4v", "新分析");
		expect(out).toContain("### 视频转写\n旧转写");
		expect(out).toContain("### 图片分析\n新分析");
		expect(out).not.toContain("旧分析");
		// ai_sections not duplicated.
		expect(out.match(/- image_analysis/g)).toHaveLength(1);
	});

	it("is idempotent for the same input", () => {
		const once = applyImageAnalysis(NOTE_WITH_FM, "glm-4v", "结果");
		const twice = applyImageAnalysis(once, "glm-4v", "结果");
		expect(twice).toBe(once);
	});

	it("adds image_analysis to an existing inline ai_sections list", () => {
		const c = NOTE_WITH_FM.replace(
			"---\n# 标题",
			'ai_model: "m1"\nai_sections: [transcript]\n---\n# 标题',
		);
		const out = applyImageAnalysis(c, "m2", "文本");
		expect(out).toContain("ai_sections: [transcript, image_analysis]");
		expect(out).toContain('ai_model: "m2"');
	});

	it("adds image_analysis to an existing block ai_sections list", () => {
		const c = NOTE_WITH_FM.replace(
			"---\n# 标题",
			"ai_sections:\n  - transcript\n---\n# 标题",
		);
		const out = applyImageAnalysis(c, "m", "文本");
		expect(out).toContain("ai_sections:\n  - transcript\n  - image_analysis");
	});
});

describe("chunkArray", () => {
	it("splits evenly and keeps the remainder in the last batch", () => {
		expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("single batch when size >= length", () => {
		expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
	});

	it("empty input -> empty batches", () => {
		expect(chunkArray([], 3)).toEqual([]);
	});

	it("clamps invalid sizes to a single batch", () => {
		expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
	});
});

describe("buildVideoRequestBody", () => {
	it("builds a text + video_url content array (qwen style) and includes the model", () => {
		const body = buildVideoRequestBody("qwen-vl-max", "提示词", "https://cdn/v.mp4");
		const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.content).toEqual([
			{ type: "text", text: "提示词" },
			{ type: "video_url", video_url: { url: "https://cdn/v.mp4" } },
		]);
		expect(body["model"]).toBe("qwen-vl-max");
	});

	it("omits the model field when empty", () => {
		const body = buildVideoRequestBody("", "p", "https://cdn/v.mp4");
		expect("model" in body).toBe(false);
	});

	it("audio_url suppressed by default (server rejects it with HTTP 400)", () => {
		const body = buildVideoRequestBody("m", "p", "https://cdn/v.mp4", "QUJD");
		const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
			?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			{ type: "text", text: "p" },
			{ type: "video_url", video_url: { url: "https://cdn/v.mp4" } },
		]);
	});

	it("audio_url appended only when opts.includeAudioUrl is set", () => {
		const body = buildVideoRequestBody("m", "p", "https://cdn/v.mp4", "QUJD", undefined, {
			includeAudioUrl: true,
		});
		const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
			?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			{ type: "text", text: "p" },
			{ type: "video_url", video_url: { url: "https://cdn/v.mp4" } },
			{ type: "audio_url", audio_url: { url: "data:audio/mp3;base64,QUJD" } },
		]);
	});

	it("does not append an audio item without audio (behavior unchanged)", () => {
		const body = buildVideoRequestBody("m", "p", "https://cdn/v.mp4");
		const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
			?.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(2);
		expect(content.some((c) => c["type"] === "audio_url")).toBe(false);
	});

	it("uses a data:video/mp4 data URI when videoBase64 is given", () => {
		const body = buildVideoRequestBody("m", "p", "https://cdn/v.mp4", undefined, "QUJD");
		const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
			?.content as Array<Record<string, unknown>>;
		const videoItem = content.find((c) => c["type"] === "video_url") as
			| { video_url: { url: string } }
			| undefined;
		expect(videoItem?.video_url.url).toBe("data:video/mp4;base64,QUJD");
		expect(videoItem?.video_url.url).not.toContain("https://cdn");
	});

	it("does not append audio_url when videoBase64 takes priority", () => {
		const body = buildVideoRequestBody("m", "p", "https://cdn/v.mp4", "REVG", "QUJD");
		const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
			?.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(2);
		expect(content.some((c) => c["type"] === "audio_url")).toBe(false);
	});

	it("fallback path stays remote video_url only (audio_url opt-in)", () => {
		const body = buildVideoRequestBody("m", "p", "https://cdn/v.mp4", "REVG");
		const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
			?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			{ type: "text", text: "p" },
			{ type: "video_url", video_url: { url: "https://cdn/v.mp4" } },
		]);
	});
});

describe("frontmatterTypeIsVideo / extractVideoNoteUrl", () => {
	it("detects type: video in frontmatter (including quoted form)", () => {
		expect(frontmatterTypeIsVideo("---\ntype: video\n---\n# t")).toBe(true);
		expect(frontmatterTypeIsVideo('---\ntype: "video"\n---\n# t')).toBe(true);
		expect(frontmatterTypeIsVideo("---\ntype: image\n---\n# t")).toBe(false);
		expect(frontmatterTypeIsVideo("no frontmatter")).toBe(false);
	});

	it("extracts the remote video URL from both link spellings", () => {
		expect(extractVideoNoteUrl("正文\n\n[▶ 观看视频](https://cdn/a.mp4)")).toBe("https://cdn/a.mp4");
		expect(extractVideoNoteUrl("[▶ 视频](https://cdn/b.mp4)")).toBe("https://cdn/b.mp4");
	});

	it("ignores local media links and missing links", () => {
		expect(extractVideoNoteUrl("[▶ 视频](RedNote/Media/n1/v.mp4)")).toBe("");
		expect(extractVideoNoteUrl("无链接正文")).toBe("");
	});
});

describe("applyVideoTranscript", () => {
	const BASE = "---\nnote_id: \"v1\"\ntype: video\n---\n\n# 标题\n\n正文\n[▶ 观看视频](https://cdn/v.mp4)\n";

	it("appends a 视频转写 subsection and the video_transcript marker", () => {
		const out = applyVideoTranscript(BASE, "qwen", "转录内容");
		expect(out).toContain("## 🤖 AI 摘要");
		expect(out).toContain("### 视频转写\n转录内容\n");
		expect(out).toContain("ai_sections:\n  - video_transcript");
		expect(out).toContain("ai_model: \"qwen\"");
		// Original note body above the AI heading is untouched.
		expect(out.indexOf("# 标题")).toBeLessThan(out.indexOf("## 🤖 AI 摘要"));
	});

	it("is idempotent and preserves an existing 图片分析 block", () => {
		const withImage = applyImageAnalysis(BASE, "m", "图片分析结果");
		const once = applyVideoTranscript(withImage, "m", "转录内容");
		const twice = applyVideoTranscript(once, "m", "转录内容");
		expect(twice).toBe(once);
		expect(once).toContain("### 图片分析\n图片分析结果");
		expect(once).toContain("### 视频转写\n转录内容");
	});

	it("replaces an existing 视频转写 block in place (image block preserved)", () => {
		const once = applyVideoTranscript(applyImageAnalysis(BASE, "m", "图片分析结果"), "m", "旧转录");
		const updated = applyVideoTranscript(once, "m", "新转录");
		expect(updated).toContain("### 图片分析\n图片分析结果");
		expect(updated).toContain("### 视频转写\n新转录");
		expect(updated).not.toContain("旧转录");
	});
});

describe("extractLocalImagePaths with vault-absolute embeds", () => {
	it("strips the leading / and returns adapter-relative paths", () => {
		const md = "![](/RedNote/Media/n1/1.webp)\n![](/RedNote/Media/n1/2.png)\n![](https://cdn/3.webp)";
		expect(extractLocalImagePaths(md, "RedNote/Media")).toEqual([
			"RedNote/Media/n1/1.webp",
			"RedNote/Media/n1/2.png",
		]);
	});

	it("still handles legacy relative embeds", () => {
		expect(extractLocalImagePaths("![](RedNote/Media/n1/1.webp)", "RedNote/Media")).toEqual([
			"RedNote/Media/n1/1.webp",
		]);
	});
});

describe("parseVideoKeyMoments", () => {
	it("parses a trailing json block and strips it from the text", () => {
		const src = "转录正文\n```json\n[{\"t\": 12, \"why\": \"高潮\"},{\"t\": \"33\", \"why\": \"结尾\"}]\n```";
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toEqual([
			{ t: 12, why: "高潮" },
			{ t: 33, why: "结尾" },
		]);
		expect(r.text).not.toContain("```json");
		expect(r.text).toContain("转录正文");
	});

	it("ignores malformed blocks, strips them, and mines a text fallback", () => {
		const src = "正文\n```json\n[{t: 12}]\n```";
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toEqual([]);
		expect(r.text).not.toContain("```json");
		expect(r.text).toContain("正文");
		expect(r.fallback).toBeUndefined();
	});

	it("repairs single-quoted values and keys before parsing", () => {
		const src = "正文\n```json\n[{'t': 63, 'why': '积极行为强化'}]\n```";
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toEqual([{ t: 63, why: "积极行为强化" }]);
		expect(r.text).not.toContain("```json");
	});

	it("removes trailing commas", () => {
		const src = '正文\n```json\n[{"t": 5, "why": "开头"},]\n```';
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toEqual([{ t: 5, why: "开头" }]);
	});

	it("normalizes MM:SS / H:MM:SS string timestamps to seconds", () => {
		const src =
			'正文\n```json\n[{"t": "00:00", "why": "a"},{"t": "01:03", "why": "b"},{"t": "1:02:03", "why": "c"}]\n```';
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toEqual([
			{ t: 0, why: "a" },
			{ t: 63, why: "b" },
			{ t: 3723, why: "c" },
		]);
	});

	it("keeps valid items and drops unparseable ones, capped at 8", () => {
		const items = [
			'{"t": "bad", "why": "x"}',
			'{"t": 7, "why": "ok"}',
			'{"t": 8}',
			'{"t": "00:09", "why": "mmss"}',
		];
		for (let i = 0; i < 8; i++) {
			items.push(`{"t": ${20 + i}, "why": "m${i}"}`);
		}
		const src = `正文\n\`\`\`json\n[${items.join(",")}]\n\`\`\``;
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toHaveLength(8);
		expect(r.keyMoments[0]).toEqual({ t: 7, why: "ok" });
		expect(r.keyMoments[1]).toEqual({ t: 9, why: "mmss" });
		expect(r.keyMoments?.[7]?.t).toBe(25);
		expect(r.fallback).toBeUndefined();
	});

	it("returns a text fallback list when the block is fully unparseable", () => {
		const src =
			"关键时刻是文本信息\n```json\n以上是关键时刻\n{\"t\": 63, \"why\": '积极行为强化'}\n{\"t\": \"02:05\", \"why\": '总结'}\n```";
		const r = parseVideoKeyMoments(src);
		expect(r.keyMoments).toEqual([]);
		expect(r.fallback).toEqual([
			{ t: 63, why: "积极行为强化" },
			{ t: 125, why: "总结" },
		]);
		expect(r.text).not.toContain("```json");
		expect(renderKeyMomentsFallback(r.fallback ?? [])).toBe(
			"关键时刻（文字版）：\n- 第 63 秒：积极行为强化\n- 第 125 秒：总结",
		);
	});

	it("renderKeyMomentsFallback is empty for no items", () => {
		expect(renderKeyMomentsFallback([])).toBe("");
	});

	it("returns no moments when the block is missing", () => {
		const r = parseVideoKeyMoments("纯文字，无代码块");
		expect(r.keyMoments).toEqual([]);
		expect(r.text).toBe("纯文字，无代码块");
	});
});

describe("renderKeyFramesSection / applyKeyFrames", () => {
	const MOMENTS = [
		{ t: 12, why: "高潮" },
		{ t: 33, why: "结尾" },
	];

	it("renders one vault-absolute embed line per frame", () => {
		const block = renderKeyFramesSection(MOMENTS, "n1", "RedNote/Media");
		expect(block).toContain("### 关键帧");
		expect(block).toContain("- ![关键帧12s](/RedNote/Media/n1/kf-1-12s.jpg)（高潮）");
		expect(block).toContain("- ![关键帧33s](/RedNote/Media/n1/kf-2-33s.jpg)（结尾）");
	});

	it("returns empty for no moments", () => {
		expect(renderKeyFramesSection([], "n1", "RedNote/Media")).toBe("");
		expect(applyKeyFrames("body", [], "n1", "RedNote/Media")).toBe("body");
	});

	it("inserts the section after 视频转写 and replaces it on re-run", () => {
		const base = "## 🤖 AI 摘要\n\n### 视频转写\n转录\n";
		const once = applyKeyFrames(base, MOMENTS, "n1", "RedNote/Media");
		expect(once.indexOf("### 视频转写")).toBeLessThan(once.indexOf("### 关键帧"));
		const twice = applyKeyFrames(once, MOMENTS, "n1", "RedNote/Media");
		expect(twice).toBe(once);
		expect(twice.match(/### 关键帧/g)).toHaveLength(1);
	});
});

describe("extractKeyFrames (ffmpeg unavailable)", () => {
	it("skips extraction and never touches the adapter when ffmpeg is missing", async () => {
		resetFfmpegProbe();
		const writes: string[] = [];
		const adapter = {
			writeBinary: async (p: string) => {
				writes.push(p);
			},
			exists: async () => false,
		};
		const r = await extractKeyFrames(
			"https://cdn/v.mp4",
			"n1",
			"RedNote/Media",
			[{ t: 12, why: "高潮" }],
			adapter,
		);
		// In the node test environment window.require is unavailable -> probe
		// must resolve to "unavailable" and no frame is written.
		expect(r.ffmpeg).toBe(false);
		expect(r.frames).toEqual([]);
		expect(writes).toEqual([]);
	});

	it("skips immediately when there are no key moments", async () => {
		resetFfmpegProbe();
		const r = await extractKeyFrames("https://cdn/v.mp4", "n1", "RedNote/Media", [], {
			writeBinary: async () => undefined,
			exists: async () => false,
		});
		expect(r.frames).toEqual([]);
	});
});
