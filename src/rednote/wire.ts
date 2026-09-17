// Pure request-shape helpers for the plugin-process API pipeline
// (requestUrl + partition Cookie + captured x-rap-param, mirroring the
// verified reference implementation ytf606/xhs2obsidian sign-manager).
//
// This module is pure (no obsidian/electron imports) so it can be unit-tested
// in vitest and imported from anywhere. The query composition here is shared
// by BOTH the actually-requested URL and the signed content string, so the
// server reconstructs exactly the string that was signed.

import { xhsQueryEscape } from "./sign";

/** `num` parameter of the favorites (collect) list endpoint. */
export const COLLECT_PAGE_NUM = 30;

/** `num` parameter of the board (收藏夹) note-list endpoint (M3.1). */
export const BOARD_NOTE_NUM = 30;

/** `num` parameter of the board/user (收藏夹列表) endpoint. */
export const BOARD_USER_NUM = 30;

/**
 * UA for plugin-process data requests AND CDN media downloads — the reference
 * implementation's Edge 142 UA, copied verbatim. Defined here (pure module)
 * so api.ts and media.ts share one value; see media.ts for the download path.
 */
export const EDGE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
	"Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";

/**
 * `image_formats` literal sent with collect/page. Commas MUST stay literal in
 * the URL (xhsQueryEscape keeps them raw, matching Python quote(safe=",")),
 * which is why this is stored pre-joined instead of as an array.
 */
export const COLLECT_IMAGE_FORMATS = "jpg,webp,avif";

/**
 * Ordered GET params for /api/sns/web/v2/note/collect/page, matching the
 * reference implementation VERBATIM: optional cursor -> num -> user_id ->
 * image_formats -> xsec_token (EMPTY) -> xsec_source (EMPTY). The empty
 * xsec params are present-but-blank in the reference's requests; object
 * insertion order IS the wire order (and the signed content string's order).
 *
 * @param userId the logged-in user's id
 * @param cursor pagination cursor ("" on the first page -> param omitted)
 */
export function buildCollectPageParams(userId: string, cursor: string): Record<string, string> {
	const params: Record<string, string> = {};
	if (cursor) {
		params.cursor = cursor;
	}
	params.num = String(COLLECT_PAGE_NUM);
	params.user_id = userId;
	params.image_formats = COLLECT_IMAGE_FORMATS;
	params.xsec_token = "";
	params.xsec_source = "";
	return params;
}

/**
 * Ordered GET params for /api/sns/web/v1/board/note (M3.1, deobfuscation-
 * confirmed path/query shape: board_id=…&cursor=…&num=…): board_id -> optional
 * cursor -> num. The same ordered object feeds both the signed content string
 * and the URL, so the server reconstructs exactly the string that was signed.
 *
 * @param boardId the 收藏夹's board_id
 * @param cursor  pagination cursor ("" on the first page -> param omitted)
 * @param num     page size (default 30)
 */
export function buildBoardNoteParams(
	boardId: string,
	cursor: string,
	num: number = BOARD_NOTE_NUM,
): Record<string, string> {
	const params: Record<string, string> = { board_id: boardId };
	if (cursor) {
		params.cursor = cursor;
	}
	params.num = String(num);
	return params;
}

/**
 * Ordered GET params for /api/sns/web/v1/board/user, matching the commercial
 * plugin's deobfuscated query VERBATIM: user_id -> page -> num=30 ->
 * image_formats=jpg,webp,avif (same literal as collect/page; commas stay
 * literal) -> xsec_token (EMPTY) -> xsec_source (EMPTY). The empty xsec
 * params are present-but-blank in the reference's requests; object insertion
 * order IS the wire order (and the signed content string's order). Omitting
 * everything after user_id made the endpoint answer code:-1 with an empty
 * msg (success=false).
 *
 * @param userId the logged-in user's id
 * @param page   1-based page number (the reference's default value
 *               deobfuscates to 1)
 */
export function buildBoardUserParams(userId: string, page: number = 1): Record<string, string> {
	const params: Record<string, string> = { user_id: userId };
	params.page = String(page);
	params.num = String(BOARD_USER_NUM);
	params.image_formats = COLLECT_IMAGE_FORMATS;
	params.xsec_token = "";
	params.xsec_source = "";
	return params;
}

/**
 * Serialize GET params exactly like the signed content string:
 * "k=esc(v)&k2=esc(v2)" with xhsQueryEscape (Python quote(safe=",")) — commas
 * stay literal, so image_formats=jpg,webp,avif is sent unencoded.
 */
export function buildGetQueryString(params: Record<string, unknown>): string {
	return Object.entries(params)
		.map(([k, v]) => `${k}=${xhsQueryEscape(String(v))}`)
		.join("&");
}

/** One cookie as returned by Electron session.cookies.get. */
export interface RawCookie {
	name: string;
	value: string;
}

/**
 * Join cookies into a Cookie header value: "n=v; n2=v2" (empty input -> "").
 */
export function joinCookies(cookies: RawCookie[]): string {
	return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Read one cookie's value out of a raw "a=b; c=d" string. Values are
 * best-effort decoded (mirrors the page-eval a1 reader in api.ts); a value
 * that is not valid percent-encoding is returned as-is. Returns "" when the
 * name is absent.
 */
export function extractCookieValue(cookieString: string, name: string): string {
	for (const part of cookieString.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		if (part.slice(0, eq).trim() === name) {
			const raw = part.slice(eq + 1).trim();
			try {
				return decodeURIComponent(raw);
			} catch {
				return raw;
			}
		}
	}
	return "";
}

/**
 * x-xray-traceid wire format (reference sign-manager):
 *   hex((milliseconds << 23) | sequence) + 16 random lowercase hex chars.
 * The sequence occupies the low 23 bits (must stay below 2^23 so it ORs
 * without carrying into the timestamp). Uses BigInt: ms<<23 far exceeds the
 * 32-bit range.
 *
 * @param nowMs   epoch milliseconds
 * @param seq     random sequence number (< 2^23)
 * @param randHex exactly 16 lowercase hex chars
 */
export function buildXrayTraceid(nowMs: number, seq: number, randHex: string): string {
	const combined = (BigInt(nowMs) << 23n) | (BigInt(seq) & 0x7fffffn);
	return combined.toString(16) + randHex;
}

/** n lowercase hex chars. */
export function randomHex(n: number): string {
	let s = "";
	for (let i = 0; i < n; i++) {
		s += Math.floor(Math.random() * 16).toString(16);
	}
	return s;
}

/** Fresh x-xray-traceid: random 23-bit sequence + 16 random hex chars. */
export function newXrayTraceid(nowMs: number): string {
	const seq = Math.floor(Math.random() * 0x7fffff);
	return buildXrayTraceid(nowMs, seq, randomHex(16));
}

// ---------------------------------------------------------------------------
// Webview navigation-sandbox host allowlist (pure predicate; kept here so the
// unit test can import it without pulling api.ts' obsidian dependency).
// ---------------------------------------------------------------------------

/** Allowed host suffixes for in-webview navigation (XHS domains only). */
const ALLOWED_HOSTS = [
	"www.xiaohongshu.com",
	"edith.xiaohongshu.com",
	"xiaohongshu.com",
	"rednote.com",
	"xhscdn.com",
];

/** True when `url` is on xiaohongshu.com / rednote.com / xhscdn.com (or a subdomain). */
export function isXhsHost(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
	} catch {
		return false;
	}
}
