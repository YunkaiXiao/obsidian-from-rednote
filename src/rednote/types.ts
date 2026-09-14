// Shared data types for the RedNote (Xiaohongshu) sync pipeline.
// Pure module: no runtime side effects, no obsidian/electron imports.

/** Note kind as returned by the XHS detail endpoint (`type` field). */
export type RedNoteType = "video" | "image";

/**
 * One raw note as seen in a favorites list page.
 * The list endpoint returns lightweight cards (note_id, type, xsec_*), and each
 * card is enriched via the detail endpoint. Fields that may be absent are
 * optional; the renderer treats missing values as "not obtainable".
 */
export interface RedNoteRaw {
	note_id: string;
	/** Present on the list endpoint; determines video vs image rendering. */
	type?: RedNoteType;
	/** Detail: title (falls back to first 255 chars of desc if absent). */
	title?: string;
	/** Detail: full body text. */
	desc?: string;
	/** Detail: author user id. */
	user_id?: string;
	/** Detail: author display nickname. */
	nickname?: string;
	/** Detail: topic tags (already filtered to type == "topic"). */
	tags?: string[];
	/** Detail: publish time as epoch ms (XHS `time` field). */
	time_ms?: number;
	/** Detail: raw image CDN URLs (original remote URLs). */
	images?: string[];
	/** Detail: video master URL (only for video notes). */
	video_url?: string;
	/** Security token from the list item; used to fetch the detail. */
	xsec_token?: string;
	/** Security source from the list item (e.g. "pc_collect"). */
	xsec_source?: string;
}

/**
 * Normalized note ready for Markdown rendering.
 * Strings that could not be obtained from the API are left as empty strings
 * (""), which the renderer emits as an empty / annotated frontmatter value.
 */
export interface RedNoteRecord {
	note_id: string;
	type: RedNoteType;
	title: string;
	/** Full body text. */
	body: string;
	/** Author display name (nickname). */
	author: string;
	author_id: string;
	/** Author profile link, e.g. https://www.xiaohongshu.com/user/profile/{id} */
	author_link: string;
	/** Note link, e.g. https://www.xiaohongshu.com/explore/{note_id} */
	link: string;
	/** Topic tags, without the user tag prefix (prefix applied at render time). */
	tags: string[];
	/** Image CDN URLs, in order (M2: embedded as remote URLs). */
	images: string[];
	/** Video URL for video notes (M2: recorded as a link). */
	video_url: string;
	/** Publish time, ISO 8601 with UTC offset. "" if not obtainable. */
	created_at: string;
	/**
	 * User's "collected" time. The favorites list endpoint does NOT expose a
	 * per-note collection timestamp in the fields we consume, so this is
	 * honestly left "" (the renderer annotates it as not obtainable).
	 */
	collected_at: string;
	/**
	 * The name of the Xiaohongshu "收藏夹" (collection/folder) this note lives
	 * in. The flat /note/collect/page endpoint we use does not return a
	 * collection name, so this is honestly left "".
	 */
	collection: string;
	/** Sync time, ISO 8601 with UTC offset (set at sync time). */
	synced_at: string;
}

/** Result of parsing a paginated XHS list response. */
export interface RedNotePage {
	/** Raw note items on this page (lightweight cards). */
	items: RedNoteRaw[];
	/** Whether there are more pages. */
	has_more: boolean;
	/** Cursor to pass to the next page request. "" when finished. */
	next_cursor: string;
}

/**
 * Signing result produced by Xiaohongshu's own page JS.
 * These four headers are required on every signed request.
 */
export interface RedNoteSign {
	"X-S": string;
	"X-T": string;
	"x-s-common": string;
	"X-B3-Traceid": string;
}

/** Thrown when the embedded page cannot produce a signature. */
export class SignError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SignError";
	}
}

/** Thrown when the API indicates the session is no longer logged in. */
export class NotLoggedInError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotLoggedInError";
	}
}
