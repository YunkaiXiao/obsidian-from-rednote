import { describe, it, expect } from "vitest";
import {
	authorLink,
	noteLink,
	mergeNoteCard,
	pickVideoStreamUrl,
	toRecord,
	XHS_UTC_OFFSET_MIN,
} from "../src/rednote/extract";
import type { RedNoteRaw } from "../src/rednote/types";

const card: RedNoteRaw = {
	note_id: "65f2a8b3",
	type: "image",
	xsec_token: "tok",
	xsec_source: "pc_collect",
};

describe("authorLink / noteLink", () => {
	it("builds the profile and explore links", () => {
		expect(authorLink("abc")).toBe("https://www.xiaohongshu.com/user/profile/abc");
		expect(noteLink("xyz")).toBe("https://www.xiaohongshu.com/explore/xyz");
		expect(authorLink("")).toBe("");
	});
});

describe("mergeNoteCard", () => {
	it("uses detail user/title/desc/tags/time and keeps card xsec", () => {
		const detail = {
			title: "标题",
			desc: "正文",
			type: "video",
			time: 1727749800000,
			user: { user_id: "u1", nickname: "作者" },
			tag_list: [
				{ type: "topic", name: "咖啡" },
				{ type: "user", name: "不应当出现" },
			],
			video: { consumer: { origin_video_key: "vidkey" } },
		};
		const merged = mergeNoteCard(card, detail);
		expect(merged.type).toBe("video");
		expect(merged.title).toBe("标题");
		expect(merged.desc).toBe("正文");
		expect(merged.user_id).toBe("u1");
		expect(merged.nickname).toBe("作者");
		expect(merged.tags).toEqual(["咖啡"]);
		expect(merged.time_ms).toBe(1727749800000);
		expect(merged.video_url).toBe("http://sns-video-bd.xhscdn.com/vidkey");
		expect(merged.xsec_token).toBe("tok");
	});

	it("falls back to first 255 chars of desc when title missing", () => {
		const merged = mergeNoteCard(card, { desc: "x".repeat(300) });
		expect(merged.title).toHaveLength(255);
	});

	it("infers video type from video data when type field absent", () => {
		const merged = mergeNoteCard(
			{ note_id: "n", xsec_token: "t" },
			{ video: { consumer: { origin_video_key: "k" } } },
		);
		expect(merged.type).toBe("video");
	});

	it("extracts images from image_list (prefers url_default)", () => {
		const merged = mergeNoteCard(card, {
			image_list: [
				{ url: "https://a/1", url_default: "https://d/1" },
				{ url: "https://a/2" },
			],
		});
		expect(merged.images).toEqual(["https://d/1", "https://a/2"]);
	});

	it("keeps card user/nickname/images when detail is empty", () => {
		const merged = mergeNoteCard(
			{ note_id: "n", type: "image", title: "卡标题", desc: "卡正文", user_id: "u9", nickname: "卡作者", images: ["https://i/1"] },
			{},
		);
		// title follows MediaCrawler's convention: title || desc.slice(0,255).
		expect(merged.title).toBe("卡正文");
		expect(merged.user_id).toBe("u9");
		expect(merged.nickname).toBe("卡作者");
		expect(merged.images).toEqual(["https://i/1"]);
	});

	it("falls back to the card title when detail has neither title nor desc", () => {
		const merged = mergeNoteCard(
			{ note_id: "n", type: "image", title: "仅卡标题" },
			{},
		);
		expect(merged.title).toBe("仅卡标题");
	});
});

describe("toRecord", () => {
	it("builds a record with honest empty collected_at/collection", () => {
		const rec = toRecord(
			{
				note_id: "65f2a8b3",
				type: "image",
				title: "t",
				desc: "b",
				user_id: "u1",
				nickname: "a",
				tags: ["x"],
				time_ms: 1788229800000,
				images: ["https://i/1"],
			},
			"2026-09-14T15:20:00+08:00",
		);
		expect(rec.note_id).toBe("65f2a8b3");
		expect(rec.author).toBe("a");
		expect(rec.author_link).toBe("https://www.xiaohongshu.com/user/profile/u1");
		expect(rec.link).toBe("https://www.xiaohongshu.com/explore/65f2a8b3");
		expect(rec.created_at).toBe("2026-09-01T10:30:00+08:00");
		expect(rec.collected_at).toBe("");
		expect(rec.collection).toBe("");
		expect(rec.synced_at).toBe("2026-09-14T15:20:00+08:00");
	});

	it("uses a default +08:00 offset for created_at", () => {
		expect(XHS_UTC_OFFSET_MIN).toBe(480);
	});

	it("injects the board name as collection (M3.1 boards path)", () => {
		const rec = toRecord(
			{ note_id: "n1", type: "image", title: "t" },
			"2026-09-17T10:00:00+08:00",
			"摄影·旅行",
		);
		expect(rec.collection).toBe("摄影·旅行");
		// Everything else is unaffected by the third argument.
		expect(rec.note_id).toBe("n1");
		expect(rec.collected_at).toBe("");
	});

	it("defaults collection to \"\" when the caller omits it (flat fallback)", () => {
		const rec = toRecord({ note_id: "n2", type: "video" }, "2026-09-17T10:00:00+08:00");
		expect(rec.collection).toBe("");
	});
});

describe("pickVideoStreamUrl (2026 video.media.stream shape)", () => {
	it("selects the highest-bitrate item of the first non-empty candidate codec (h264 before later keys)", () => {
		const media = {
			stream: {
				unknown_codec: [{ master_url: "https://cdn/unknown-high" }],
				h264: [
					{ master_url: "https://cdn/low", avg_bitrate: 300000 },
					{ backup_urls: ["https://cdn/high-bk"], avg_bitrate: 1200000 },
					{ master_url: "https://cdn/mid", avg_bitrate: 700000 },
				],
				av1: [],
			},
		};
		expect(pickVideoStreamUrl(media)).toBe("https://cdn/high-bk");
	});

	it("prefers av1 over h264 when both have streams", () => {
		const media = {
			stream: {
				h264: [{ master_url: "https://cdn/h264" }],
				av1: [{ masterUrl: "https://cdn/av1" }],
			},
		};
		expect(pickVideoStreamUrl(media)).toBe("https://cdn/av1");
	});

	it("tolerates missing avg_bitrate (treated as 0) and missing url fields", () => {
		const media = {
			stream: {
				h264: [
					{ master_url: "https://cdn/nobitrate" },
					{ avg_bitrate: 500 },
					{ backup_urls: ["https://cdn/with-bitrate"], avg_bitrate: 1 },
				],
			},
		};
		expect(pickVideoStreamUrl(media)).toBe("https://cdn/with-bitrate");
	});

	it("falls back through backup_urls[0] -> master_url -> masterUrl", () => {
		expect(pickVideoStreamUrl({ stream: { av1: [{ masterUrl: "https://cdn/c" }] } })).toBe("https://cdn/c");
		expect(pickVideoStreamUrl({ stream: { av1: [{ master_url: "https://cdn/b" }] } })).toBe("https://cdn/b");
		expect(pickVideoStreamUrl({ stream: { av1: [{ backup_urls: ["https://cdn/a"] }] } })).toBe("https://cdn/a");
	});

	it("returns \"\" for empty/malformed media shapes", () => {
		expect(pickVideoStreamUrl(undefined)).toBe("");
		expect(pickVideoStreamUrl({})).toBe("");
		expect(pickVideoStreamUrl({ stream: {} })).toBe("");
		expect(pickVideoStreamUrl({ stream: { av1: [] } })).toBe("");
		expect(pickVideoStreamUrl({ stream: { av1: [null, "x"] } })).toBe("");
	});

	it("mergeNoteCard uses the stream URL when present", () => {
		const merged = mergeNoteCard(card, {
			type: "video",
			video: {
				media: { stream: { h264: [{ backup_urls: ["https://cdn/v"], avg_bitrate: 900000 }] } },
			},
		});
		expect(merged.video_url).toBe("https://cdn/v");
		expect(merged.type).toBe("video");
	});

	it("keeps the legacy consumer.origin_video_key path as fallback", () => {
		const merged = mergeNoteCard(card, {
			type: "video",
			video: { consumer: { origin_video_key: "vidkey" } },
		});
		expect(merged.video_url).toBe("http://sns-video-bd.xhscdn.com/vidkey");
	});

	it("leaves video_url empty when both paths yield nothing", () => {
		const merged = mergeNoteCard(card, {
			type: "video",
			video: { media: { stream: { av1: [] } } },
		});
		expect(merged.video_url).toBe("");
		expect(merged.type).toBe("video");
	});
});
