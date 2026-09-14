// Pure pagination parsing for XHS list endpoints.
// The favorites list endpoint (GET /api/sns/web/v2/note/collect/page) returns,
// inside `data`: { notes: [...], has_more: boolean, cursor: string }.
// We mirror that shape here so it can be unit-tested without a webview.

import type { RedNotePage, RedNoteRaw } from "./types";

/** A single note item in a raw XHS list page. */
export interface RawListItem {
	note_id?: unknown;
	type?: unknown;
	title?: unknown;
	desc?: unknown;
	user_id?: unknown;
	nickname?: unknown;
	time?: unknown;
	images?: unknown[];
	video_url?: unknown;
	xsec_token?: unknown;
	xsec_source?: unknown;
	[extra: string]: unknown;
}

/** The shape of the `data` block of a paginated list response. */
export interface RawListData {
	notes?: RawListItem[] | null;
	has_more?: unknown;
	cursor?: unknown;
}

/**
 * Extract a single image URL from a card-level media entry. Entries may be
 * plain url strings or `{url|url_default}` objects (the API is inconsistent
 * across endpoints), so handle both. Only genuine http(s) URLs are kept;
 * anything else (non-url strings, non-string scalars, unknown objects) yields
 * "" so it is filtered out.
 */
function imageUrlOf(entry: unknown): string {
	let url: string | undefined;
	if (typeof entry === "string") {
		url = entry;
	} else if (entry && typeof entry === "object") {
		const o = entry as Record<string, unknown>;
		url = (typeof o.url_default === "string" && o.url_default.length > 0
			? o.url_default
			: undefined) ??
			(typeof o.url === "string" ? o.url : undefined);
	}
	if (typeof url === "string" && /^https?:\/\//i.test(url)) {
		return url;
	}
	return "";
}

/**
 * Normalize one raw list item into a lightweight RedNoteRaw card.
 * Missing / malformed fields become undefined (honest about "not obtainable").
 */
export function normalizeListItem(item: RawListItem): RedNoteRaw {
	const typeRaw = item.type;
	const type = typeRaw === "video" ? "video" : typeRaw === "image" ? "image" : undefined;
	const num = typeof item.time === "number" ? item.time : undefined;
	const imagesRaw = Array.isArray(item.images) ? item.images : undefined;
	return {
		note_id: typeof item.note_id === "string" ? item.note_id : "",
		type,
		title: typeof item.title === "string" ? item.title : undefined,
		desc: typeof item.desc === "string" ? item.desc : undefined,
		user_id: typeof item.user_id === "string" ? item.user_id : undefined,
		nickname: typeof item.nickname === "string" ? item.nickname : undefined,
		time_ms: num,
		images: imagesRaw?.map(imageUrlOf).filter((s) => s.length > 0) ?? [],
		video_url: typeof item.video_url === "string" ? item.video_url : undefined,
		xsec_token: typeof item.xsec_token === "string" ? item.xsec_token : undefined,
		xsec_source: typeof item.xsec_source === "string" ? item.xsec_source : undefined,
	};
}

/**
 * Parse a raw list `data` block into a normalized page.
 *
 * Termination is driven by `has_more` (boolean). The next cursor is the `cursor`
 * string; an empty/missing cursor also implies the end so a caller can safely
 * stop.
 *
 * @param data  The `data` object of the response (or null/undefined).
 */
export function parseListPage(data: RawListData | null | undefined): RedNotePage {
	const itemsRaw = Array.isArray(data?.notes) ? data!.notes! : [];
	const items: RedNoteRaw[] = [];
	const seen = new Set<string>();
	for (const it of itemsRaw) {
		const norm = normalizeListItem(it ?? {});
		if (norm.note_id && !seen.has(norm.note_id)) {
			seen.add(norm.note_id);
			items.push(norm);
		}
	}
	const hasMore = data?.has_more === true;
	const cursorRaw = data?.cursor;
	const nextCursor = typeof cursorRaw === "string" ? cursorRaw : "";
	return { items, has_more: hasMore, next_cursor: nextCursor };
}

/**
 * Decide whether a pagination loop should continue.
 * Continues only when there is both a `has_more` flag AND a non-empty next
 * cursor. This guards against an endpoint returning has_more=true with an
 * empty cursor (which would otherwise loop forever).
 */
export function shouldContinue(page: RedNotePage): boolean {
	return page.has_more && page.next_cursor.length > 0;
}
