// Pure extraction: convert raw XHS API payloads into a RedNoteRecord.
// No runtime side effects, no obsidian/electron imports.

import type { RedNoteRecord, RedNoteRaw, RedNoteType } from "./types";
import { epochToIso } from "./markdown";

/**
 * XHS UTC offset for Chinese accounts (publish/collect times are rendered in
 * +08:00). Kept as a module constant so extraction stays pure/deterministic.
 */
export const XHS_UTC_OFFSET_MIN = 8 * 60;

/** Author profile link for a user id. */
export function authorLink(userId: string): string {
	return userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : "";
}

/** Note link for a note id. */
export function noteLink(noteId: string): string {
	return noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : "";
}

/**
 * Pick the best playable URL from the 2026 detail API's `video.media` shape:
 * `media.stream` is an object keyed by codec name ("av1", "h264", ... unknown
 * keys); each value is an array of stream items carrying `master_url` /
 * `masterUrl` / `backup_urls` / `avg_bitrate`. Strategy (mirrors the
 * deobfuscated commercial plugin): candidate codecs [av1, h264, then the
 * remaining keys in order] — take the first codec with a non-empty stream
 * array, sort that array by `avg_bitrate` (missing = 0) descending, take the
 * top item, URL = `backup_urls[0] ?? master_url ?? masterUrl`. Every access
 * is tolerant; "" when nothing usable is found. Pure.
 */
export function pickVideoStreamUrl(media: unknown): string {
	if (!media || typeof media !== "object") {
		return "";
	}
	const stream = (media as Record<string, unknown>)["stream"];
	if (!stream || typeof stream !== "object") {
		return "";
	}
	const keys = Object.keys(stream as Record<string, unknown>);
	const ordered = ["av1", "h264", ...keys.filter((k) => k !== "av1" && k !== "h264")];
	for (const codec of ordered) {
		const arr = (stream as Record<string, unknown>)[codec];
		if (!Array.isArray(arr) || arr.length === 0) {
			continue;
		}
		const items = arr
			.filter(
				(it): it is Record<string, unknown> =>
					!!it && typeof it === "object",
			)
			.map((it) => {
				let url = "";
				const backups = it["backup_urls"];
				if (
					Array.isArray(backups) &&
					typeof backups[0] === "string" &&
					backups[0].length > 0
				) {
					url = backups[0];
				}
				if (!url && typeof it["master_url"] === "string" && it["master_url"]) {
					url = it["master_url"] as string;
				}
				if (!url && typeof it["masterUrl"] === "string" && it["masterUrl"]) {
					url = it["masterUrl"] as string;
				}
				const bitrate = it["avg_bitrate"];
				return {
					url,
					bitrate: typeof bitrate === "number" && Number.isFinite(bitrate) ? bitrate : 0,
				};
			})
			.filter((it) => it.url.length > 0);
		if (items.length === 0) {
			continue;
		}
		items.sort((a, b) => b.bitrate - a.bitrate);
		return items[0] !== undefined ? items[0].url : "";
	}
	return "";
}

/**
 * Merge a lightweight list card with the full detail payload into one
 * RedNoteRaw. The detail is authoritative for title/desc/user/images/video/
 * time; the card supplies xsec_* and (as a fallback) the note type.
 */
export function mergeNoteCard(
	card: RedNoteRaw,
	detail: Record<string, unknown> | null | undefined,
): RedNoteRaw {
	const d = detail ?? {};

	const pickStr = (k: string): string | undefined => {
		const v = d[k];
		return typeof v === "string" && v.length > 0 ? v : undefined;
	};
	const pickNum = (k: string): number | undefined => {
		const v = d[k];
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	};

	const user = (d.user ?? d.creator) as Record<string, unknown> | undefined;
	const userObj = user && typeof user === "object" ? user : undefined;
	const userId =
		(typeof userObj?.user_id === "string" ? userObj.user_id : undefined) ??
		(typeof userObj?.id === "string" ? userObj.id : undefined) ??
		card.user_id ??
		("");
	const nickname =
		(typeof userObj?.nickname === "string" ? userObj.nickname : undefined) ??
		card.nickname ??
		"";

	// title falls back to the first 255 chars of desc (mirrors MediaCrawler
	// store: `title || desc[:255]`), then to the card title, then to "".
	const titleRaw = pickStr("title");
	const desc = pickStr("desc") ?? card.desc ?? "";
	let title = titleRaw ?? (desc ? desc.slice(0, 255) : "");
	if (!title) {
		title = card.title ?? "";
	}

	// images: detail `image_list` is an array of { url / url_default }.
	let images: string[] = [];
	const imageList = d.image_list;
	if (Array.isArray(imageList)) {
		images = imageList.map((img) => {
			const o = img as Record<string, unknown>;
			return (
				(typeof o.url_default === "string" && o.url_default.length > 0
					? o.url_default
					: undefined) ??
				(typeof o.url === "string" ? o.url : undefined) ??
				""
			);
		}).filter((s) => s.length > 0);
	}
	if (images.length === 0) {
		images = card.images ?? [];
	}

	// tags: detail `tag_list` filtered to type == "topic", take `name`.
	let tags: string[] = [];
	const tagList = d.tag_list;
	if (Array.isArray(tagList)) {
		tags = tagList
			.filter((t) => (t as Record<string, unknown>)?.type === "topic")
			.map((t) => (t as Record<string, unknown>).name)
			.filter((n): n is string => typeof n === "string" && n.length > 0);
	}

	const timeMs = pickNum("time") ?? pickNum("last_update_time") ?? card.time_ms;

	// video url: 2026 API primary path is `video.media.stream` (codec-keyed
	// stream arrays); the legacy `video.consumer.origin_video_key` is kept as
	// a fallback for older payloads.
	let videoUrl = card.video_url ?? "";
	const video = d.video as Record<string, unknown> | undefined;
	if (video && typeof video === "object") {
		const fromStream = pickVideoStreamUrl(video.media);
		if (fromStream) {
			videoUrl = fromStream;
		} else {
			const consumer = video.consumer as Record<string, unknown> | undefined;
			if (consumer) {
				const master = consumer.origin_video_key as string | undefined;
				if (typeof master === "string" && master.length > 0) {
					videoUrl = `http://sns-video-bd.xhscdn.com/${master}`;
				}
			}
		}
	}

	// type: detail `type` is authoritative; fall back to the card type; infer
	// from media when still unknown.
	let type: RedNoteType;
	const rawType = d.type as RedNoteType | undefined;
	if (rawType === "video" || rawType === "image") {
		type = rawType;
	} else if (card.type === "video" || card.type === "image") {
		type = card.type;
	} else if (videoUrl) {
		type = "video";
	} else {
		type = "image";
	}

	return {
		note_id: card.note_id,
		type,
		title,
		desc,
		user_id: userId,
		nickname,
		tags,
		time_ms: timeMs,
		images,
		video_url: videoUrl,
		xsec_token: card.xsec_token,
		xsec_source: card.xsec_source,
	};
}

/**
 * Build a render-ready RedNoteRecord from a merged raw note.
 *
 * Honesty about "not obtainable" fields:
 *  - `collected_at` is NOT returned by the list endpoints we use, so it is
 *    left "" and the renderer annotates it. `synced_at` is set by the caller
 *    at sync time.
 *  - `collection` (M3.1): the sync layer supplies the 收藏夹 name for cards
 *    fetched via a board (收藏夹); the flat /note/collect/page fallback
 *    cannot know a collection, so it stays "" there.
 *
 * @param merged     Merged raw note (card + detail).
 * @param syncedAt   ISO 8601 sync time (caller-supplied, with offset).
 * @param collection Board (收藏夹) name when the card came from a board; "" otherwise.
 */
export function toRecord(
	merged: RedNoteRaw,
	syncedAt: string,
	collection = "",
): RedNoteRecord {
	return {
		note_id: merged.note_id,
		type: merged.type ?? "image",
		title: merged.title ?? "",
		body: merged.desc ?? "",
		author: merged.nickname ?? "",
		author_id: merged.user_id ?? "",
		author_link: authorLink(merged.user_id ?? ""),
		link: noteLink(merged.note_id),
		tags: merged.tags ?? [],
		images: merged.images ?? [],
		video_url: merged.video_url ?? "",
		created_at: epochToIso(merged.time_ms ?? 0, XHS_UTC_OFFSET_MIN),
		collected_at: "", // not obtainable from the collect list endpoint
		collection: collection ?? "", // board name (M3.1 boards); "" on the flat fallback
		synced_at: syncedAt,
	};
}
