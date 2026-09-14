// Pure local Xiaohongshu request signing — ported from the algorithm used by
// MediaCrawler (NanmiCoder/MediaCrawler), which since ~2026 computes X-S/X-T
// locally instead of calling the page's window._webmsxyw (no longer exposed).
//
// Reference sources (pulled 2026-09-15):
//  - https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/xhs/playwright_sign.py
//    (delegates to the xhshow library, sign_format="xys")
//  - https://github.com/Cloxl/xhshow master src/xhshow/{client,core/*,utils/*,config/*}.py
//    * X-S   : "XYS_" + customBase64(json{x0..x4}) where x3 = "mns0301_" +
//              x3Base64(xor(139-byte payload, HEX_KEY)); payload embeds
//              md5(uri+data), the a1 cookie, timestamps and an env block
//    * X-T   : unix epoch milliseconds
//    * x-s-common : customBase64(json{s0,s1,x0..x11}) with x5=a1, x8=b1,
//              x9=crc32(b1) — the s0/s1/x0..x11 structure
//    * x-b3-traceid : 16 random hex chars
//  - b1 provenance (verified in both repos): in a REAL XHS page b1 lives in
//    localStorage.getItem("b1") (see MediaCrawler help.py comments "x8":
//    localStorage.getItem("b1")), NOT in cookies. MediaCrawler runs without a
//    real page, so xhshow synthesizes b1 from a fingerprint dict, RC4-encrypts
//    it with the key "xhswebmplfbt", percent-encodes it and re-encodes the
//    result with the custom base64 alphabet. We do both: prefer the page's own
//    localStorage b1, fall back to local synthesis (generateB1()).
//
// This module is pure (no obsidian/electron imports) so it can be unit-tested
// in vitest and reused from anywhere.

/**
 * Signed request headers. Shape-compatible with RedNoteSign in ./types.ts
 * (kept separate so this module stays dependency-free).
 */
export interface XhsSignResult {
	"X-S": string;
	"X-T": string;
	"x-s-common": string;
	"X-B3-Traceid": string;
}

/** Injects the random values xhshow draws per signature (tests / replay). */
export interface SignRandomOverride {
	/** 32-bit seed embedded in the payload. */
	seed: number;
	/** Page-load time offset in seconds (xhshow draws 10..50). */
	timeOffset: number;
	/** Sequence counter (xhshow draws 15..50). */
	sequence: number;
	/** window props length (xhshow draws 1000..1200). */
	windowPropsLength: number;
}

// ---------------------------------------------------------------------------
// Constants (verbatim from xhshow config/config.py)
// ---------------------------------------------------------------------------

/** Custom base64 alphabets: standard alphabet with shuffled order. */
const CUSTOM_B64 = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
const X3_B64 = "MfgqrsbcyzPQRStuvC7mn501HIJBo2DEFTKdeNOwxWXYZap89+/A4UVLhijkl63G";
const STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** XOR key applied to the first bytes of the X-S payload. */
const HEX_KEY =
	"71a302257793271ddd273bcee3e4b98d9d7935e1da33f5765e2ea8afb6dc77a51a499d23b67c20660025860cbf13d4540d92497f58686c574e508f46e1956344f39139bf4faf22a3eef120b79258145b2feb5193b6478669961298e79bedca646e1a693a926154a5a7a1bd1cf0dedb742f917a747a1e388b234f2277516db7116035439730fa61e9822a0eca7bff72d8";

const VERSION_BYTES = [121, 104, 96, 41];
const A3_PREFIX = [2, 97, 51, 16];
const ENV_TABLE = [115, 248, 83, 102, 103, 201, 181, 131, 99, 94, 4, 68, 250, 132, 21];
const ENV_CHECKS_DEFAULT = [0, 1, 18, 1, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0];
const HASH_IV: readonly number[] = [1831565813, 461845907, 2246822507, 3266489909];
const A1_LENGTH = 52;
const APP_ID_LENGTH = 10;
const MD5_XOR_LENGTH = 8;
const TIMESTAMP_LE_LENGTH = 8;

const HEX_KEY_BYTES: number[] = (() => {
	const out: number[] = [];
	for (let i = 0; i < HEX_KEY.length; i += 2) {
		out.push(parseInt(HEX_KEY.slice(i, i + 2), 16));
	}
	return out;
})();

/** b1 synthesis key (xhshow CryptoConfig.B1_SECRET_KEY). */
const B1_SECRET_KEY = "xhswebmplfbt";

const HEX_CHARS = "abcdef0123456789";

const encoder = new TextEncoder();

function utf8Bytes(s: string): number[] {
	return Array.from(encoder.encode(s));
}

// ---------------------------------------------------------------------------
// Base64 (custom alphabet) — mirrors xhshow utils/encoder.py
// ---------------------------------------------------------------------------

function b64EncodeWith(data: number[], alphabet: string): string {
	let out = "";
	const len = data.length;
	const rem = len % 3;
	const main = len - rem;
	for (let i = 0; i < main; i += 3) {
		const c = ((data[i]! << 16) & 0xff0000) + ((data[i + 1]! << 8) & 0xff00) + data[i + 2]!;
		out +=
			alphabet[(c >> 18) & 63]! + alphabet[(c >> 12) & 63]! + alphabet[(c >> 6) & 63]! + alphabet[c & 63]!;
	}
	if (rem === 1) {
		const a = data[len - 1]!;
		out += alphabet[a >> 2]! + alphabet[(a << 4) & 63]! + "==";
	} else if (rem === 2) {
		const a = (data[len - 2]! << 8) + data[len - 1]!;
		out += alphabet[a >> 10]! + alphabet[(a >> 4) & 63]! + alphabet[(a << 2) & 63]! + "=";
	}
	return out;
}

/** Custom-alphabet base64 (used for X-S envelope and x-s-common). */
function customB64(data: number[]): string {
	return b64EncodeWith(data, CUSTOM_B64);
}

/** X3-alphabet base64 (used inside the X-S envelope for the payload). */
function x3B64(data: number[]): string {
	return b64EncodeWith(data, X3_B64);
}

/** Inverse of customB64 — decodes back to a UTF-8 string (debug/tests). */
export function decodeCustomBase64(encoded: string): string {
	const lookup = new Map<string, number>();
	for (let i = 0; i < CUSTOM_B64.length; i++) {
		lookup.set(CUSTOM_B64[i]!, i);
	}
	const standard = encoded
		.split("")
		.map((ch) => (ch === "=" ? ch : STD_B64[lookup.get(ch) ?? 0]))
		.join("");
	const clean = standard.replace(/=+$/, "");
	const bytes: number[] = [];
	for (let i = 0; i < clean.length; i += 4) {
		const rem = Math.min(4, clean.length - i);
		const n =
			(STD_B64.indexOf(clean[i]!) << 18) |
			((rem > 1 ? STD_B64.indexOf(clean[i + 1]!) : 0) << 12) |
			((rem > 2 ? STD_B64.indexOf(clean[i + 2]!) : 0) << 6) |
			(rem > 3 ? STD_B64.indexOf(clean[i + 3]!) : 0);
		bytes.push((n >> 16) & 0xff);
		if (rem > 2) {
			bytes.push((n >> 8) & 0xff);
		}
		if (rem > 3) {
			bytes.push(n & 0xff);
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// MD5 (standard RFC 1321 implementation over raw bytes)
// ---------------------------------------------------------------------------

function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
	a = (((a + q) | 0) + ((x + t) | 0)) | 0;
	return (((a << s) | (a >>> (32 - s))) + b) | 0;
}
function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
	return cmn((b & c) | (~b & d), a, b, x, s, t);
}
function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
	return cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
	return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
	return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function md5cycle(x: number[], k: number[]): void {
	let a = x[0]!;
	let b = x[1]!;
	let c = x[2]!;
	let d = x[3]!;

	a = ff(a, b, c, d, k[0]!, 7, -680876936);
	d = ff(d, a, b, c, k[1]!, 12, -389564586);
	c = ff(c, d, a, b, k[2]!, 17, 606105819);
	b = ff(b, c, d, a, k[3]!, 22, -1044525330);
	a = ff(a, b, c, d, k[4]!, 7, -176418897);
	d = ff(d, a, b, c, k[5]!, 12, 1200080426);
	c = ff(c, d, a, b, k[6]!, 17, -1473231341);
	b = ff(b, c, d, a, k[7]!, 22, -45705983);
	a = ff(a, b, c, d, k[8]!, 7, 1770035416);
	d = ff(d, a, b, c, k[9]!, 12, -1958414417);
	c = ff(c, d, a, b, k[10]!, 17, -42063);
	b = ff(b, c, d, a, k[11]!, 22, -1990404162);
	a = ff(a, b, c, d, k[12]!, 7, 1804603682);
	d = ff(d, a, b, c, k[13]!, 12, -40341101);
	c = ff(c, d, a, b, k[14]!, 17, -1502002290);
	b = ff(b, c, d, a, k[15]!, 22, 1236535329);

	a = gg(a, b, c, d, k[1]!, 5, -165796510);
	d = gg(d, a, b, c, k[6]!, 9, -1069501632);
	c = gg(c, d, a, b, k[11]!, 14, 643717713);
	b = gg(b, c, d, a, k[0]!, 20, -373897302);
	a = gg(a, b, c, d, k[5]!, 5, -701558691);
	d = gg(d, a, b, c, k[10]!, 9, 38016083);
	c = gg(c, d, a, b, k[15]!, 14, -660478335);
	b = gg(b, c, d, a, k[4]!, 20, -405537848);
	a = gg(a, b, c, d, k[9]!, 5, 568446438);
	d = gg(d, a, b, c, k[14]!, 9, -1019803690);
	c = gg(c, d, a, b, k[3]!, 14, -187363961);
	b = gg(b, c, d, a, k[8]!, 20, 1163531501);
	a = gg(a, b, c, d, k[13]!, 5, -1444681467);
	d = gg(d, a, b, c, k[2]!, 9, -51403784);
	c = gg(c, d, a, b, k[7]!, 14, 1735328473);
	b = gg(b, c, d, a, k[12]!, 20, -1926607734);

	a = hh(a, b, c, d, k[5]!, 4, -378558);
	d = hh(d, a, b, c, k[8]!, 11, -2022574463);
	c = hh(c, d, a, b, k[11]!, 16, 1839030562);
	b = hh(b, c, d, a, k[14]!, 23, -35309556);
	a = hh(a, b, c, d, k[1]!, 4, -1530992060);
	d = hh(d, a, b, c, k[4]!, 11, 1272893353);
	c = hh(c, d, a, b, k[7]!, 16, -155497632);
	b = hh(b, c, d, a, k[10]!, 23, -1094730640);
	a = hh(a, b, c, d, k[13]!, 4, 681279174);
	d = hh(d, a, b, c, k[0]!, 11, -358537222);
	c = hh(c, d, a, b, k[3]!, 16, -722521979);
	b = hh(b, c, d, a, k[6]!, 23, 76029189);
	a = hh(a, b, c, d, k[9]!, 4, -640364487);
	d = hh(d, a, b, c, k[12]!, 11, -421815835);
	c = hh(c, d, a, b, k[15]!, 16, 530742520);
	b = hh(b, c, d, a, k[2]!, 23, -995338651);

	a = ii(a, b, c, d, k[0]!, 6, -198630844);
	d = ii(d, a, b, c, k[7]!, 10, 1126891415);
	c = ii(c, d, a, b, k[14]!, 15, -1416354905);
	b = ii(b, c, d, a, k[5]!, 21, -57434055);
	a = ii(a, b, c, d, k[12]!, 6, 1700485571);
	d = ii(d, a, b, c, k[3]!, 10, -1894986606);
	c = ii(c, d, a, b, k[10]!, 15, -1051523);
	b = ii(b, c, d, a, k[1]!, 21, -2054922799);
	a = ii(a, b, c, d, k[8]!, 6, 1873313359);
	d = ii(d, a, b, c, k[15]!, 10, -30611744);
	c = ii(c, d, a, b, k[6]!, 15, -1560198380);
	b = ii(b, c, d, a, k[13]!, 21, 1309151649);
	a = ii(a, b, c, d, k[4]!, 6, -145523070);
	d = ii(d, a, b, c, k[11]!, 10, -1120210379);
	c = ii(c, d, a, b, k[2]!, 15, 718787259);
	b = ii(b, c, d, a, k[9]!, 21, -343485551);

	x[0] = (a + x[0]!) | 0;
	x[1] = (b + x[1]!) | 0;
	x[2] = (c + x[2]!) | 0;
	x[3] = (d + x[3]!) | 0;
}

/** Four little-endian 32-bit words from 64 bytes at `off`. */
function md5blk(bytes: number[] | Uint8Array, off: number): number[] {
	const blks: number[] = [];
	for (let j = 0; j < 16; j++) {
		const i = off + j * 4;
		blks.push(bytes[i]! + (bytes[i + 1]! << 8) + (bytes[i + 2]! << 16) + (bytes[i + 3]! << 24));
	}
	return blks;
}

function toHexLE(word: number): string {
	let s = "";
	for (let j = 0; j < 4; j++) {
		s += ((word >> (j * 8 + 4)) & 0x0f).toString(16) + ((word >> (j * 8)) & 0x0f).toString(16);
	}
	return s;
}

/** MD5 of a byte sequence, lowercase hex. */
export function md5HexBytes(bytes: number[] | Uint8Array): string {
	const n = bytes.length;
	const state = [1732584193, -271733879, -1732584194, 271733878];
	let i = 64;
	for (; i <= n; i += 64) {
		md5cycle(state, md5blk(bytes, i - 64));
	}
	// Tail: pack the remaining bytes (+ 0x80 + 64-bit LE bit length) into
	// 16 (or 32 when the 0x80 byte would reach the length field) little-endian
	// words — md5cycle consumes WORDS, not bytes.
	const rest = n - (i - 64);
	const wordCount = rest > 55 ? 32 : 16;
	const words: number[] = new Array<number>(wordCount).fill(0);
	for (let j = 0; j < rest; j++) {
		words[j >> 2] = words[j >> 2]! | (bytes[i - 64 + j]! << ((j % 4) * 8));
	}
	words[rest >> 2] = words[rest >> 2]! | (0x80 << ((rest % 4) * 8));
	const bits = n * 8;
	const lo = bits % 0x100000000;
	const hi = Math.floor(bits / 0x100000000);
	words[wordCount - 2] = lo | 0;
	words[wordCount - 1] = hi | 0;
	// md5cycle consumes 16 words per call — a 32-word tail is two blocks.
	if (wordCount === 32) {
		md5cycle(state, words.slice(0, 16));
		md5cycle(state, words.slice(16, 32));
	} else {
		md5cycle(state, words);
	}
	return toHexLE(state[0]!) + toHexLE(state[1]!) + toHexLE(state[2]!) + toHexLE(state[3]!);
}

/** MD5 of a UTF-8 string, lowercase hex. */
export function md5Hex(s: string): string {
	return md5HexBytes(utf8Bytes(s));
}

// ---------------------------------------------------------------------------
// CRC32 (xhshow core/crc32_encrypt.py, JS charCodeAt semantics)
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
	const table: number[] = [];
	for (let d = 0; d < 256; d++) {
		let r = d;
		for (let k = 0; k < 8; k++) {
			// >>> (logical shift) — a signed >> corrupts the table once bit 31 is set.
			r = r & 1 ? ((r >>> 1) ^ 0xedb88320) & 0xffffffff : r >>> 1;
		}
		table.push(r >>> 0);
	}
	return table;
})();

/** JS-style CRC32 → signed 32-bit int (xhshow CRC32.crc32_js_int). */
export function crc32JsInt(s: string): number {
	let c = 0xffffffff;
	for (let i = 0; i < s.length; i++) {
		const b = s.charCodeAt(i) & 0xff;
		c = (CRC_TABLE[(c & 0xff) ^ b & 0xff]! ^ (c >>> 8)) >>> 0;
	}
	const u = ((0xffffffff ^ c) ^ 0xedb88320) >>> 0;
	return u & 0x80000000 ? u - 0x100000000 : u;
}

// ---------------------------------------------------------------------------
// RC4 (for local b1 synthesis; xhshow uses pycryptodome ARC4)
// ---------------------------------------------------------------------------

function rc4(key: string, data: number[]): number[] {
	const s: number[] = [];
	for (let i = 0; i < 256; i++) {
		s.push(i);
	}
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j + s[i]! + key.charCodeAt(i % key.length)) % 256;
		const t = s[i]!;
		s[i] = s[j]!;
		s[j] = t;
	}
	const out: number[] = [];
	let i2 = 0;
	let j2 = 0;
	for (const ch of data) {
		i2 = (i2 + 1) % 256;
		j2 = (j2 + s[i2]!) % 256;
		const t = s[i2]!;
		s[i2] = s[j2]!;
		s[j2] = t;
		out.push(ch ^ s[(s[i2]! + s[j2]!) % 256]!);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Content string + GET query escaping
// ---------------------------------------------------------------------------

/**
 * Percent-escape a query value the way XHS/MediaCrawler do:
 * Python urllib.parse.quote(value, safe=","). Keeps A-Za-z0-9 _ . - ~ and
 * commas raw; everything else (including "/" and !*'()) becomes %XX uppercase.
 * Use for BOTH the signed content string and the actually-requested URL, so
 * the server reconstructs the exact signed string.
 */
export function xhsQueryEscape(value: string): string {
	return encodeURIComponent(value)
		.replace(/%2C/g, ",") // comma stays raw under quote(safe=",")
		.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build the string that md5'd into the signature (xhshow
 * _build_content_string): POST -> uri + compact JSON body; GET -> uri +
 * "?k=esc&..." with list values comma-joined.
 */
function buildContentString(method: "GET" | "POST", uri: string, data: unknown): string {
	if (method === "POST") {
		const obj = data ?? {};
		return uri + JSON.stringify(obj);
	}
	if (!data || typeof data !== "object") {
		return uri;
	}
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		let valueStr: string;
		if (Array.isArray(value)) {
			valueStr = value.map((v) => String(v)).join(",");
		} else if (value !== null && value !== undefined) {
			valueStr = String(value);
		} else {
			valueStr = "";
		}
		parts.push(`${key}=${xhsQueryEscape(valueStr)}`);
	}
	return parts.length ? `${uri}?${parts.join("&")}` : uri;
}

// ---------------------------------------------------------------------------
// X-S payload (xhshow core/crypto.py build_payload_array + custom_hash_v2)
// ---------------------------------------------------------------------------

function intToLeBytes(value: number, length: number): number[] {
	const arr: number[] = [];
	let v = value;
	for (let i = 0; i < length; i++) {
		arr.push(v % 256);
		v = Math.floor(v / 256);
	}
	return arr;
}

function rotl32(val: number, n: number): number {
	const v = val >>> 0;
	return (((v << n) | (v >>> (32 - n))) & 0xffffffff) >>> 0;
}

/** xhshow custom hash used for the a3 tail of the payload. */
function customHashV2(input: number[]): number[] {
	let [s0, s1, s2, s3] = [HASH_IV[0]!, HASH_IV[1]!, HASH_IV[2]!, HASH_IV[3]!];
	const length = input.length;
	s0 = (s0 ^ length) >>> 0;
	s1 = (s1 ^ ((length << 8) >>> 0)) >>> 0;
	s2 = (s2 ^ ((length << 16) >>> 0)) >>> 0;
	s3 = (s3 ^ ((length << 24) >>> 0)) >>> 0;
	const readLE = (off: number): number =>
		(input[off]! | (input[off + 1]! << 8) | (input[off + 2]! << 16) | (input[off + 3]! << 24)) >>> 0;
	for (let i = 0; i < Math.floor(length / 8); i++) {
		const v0 = readLE(i * 8);
		const v1 = readLE(i * 8 + 4);
		s0 = rotl32(((s0 + v0) & 0xffffffff) ^ s2, 7);
		s1 = rotl32(((v0 ^ s1) + s3) & 0xffffffff, 11);
		s2 = rotl32(((s2 + v1) & 0xffffffff) ^ s0, 13);
		s3 = rotl32(((s3 ^ v1) + s1) & 0xffffffff, 17);
	}
	const t0 = (s0 ^ length) >>> 0;
	const t1 = (s1 ^ t0) >>> 0;
	const t2 = (s2 + t1) & 0xffffffff;
	const t3 = (s3 ^ t2) >>> 0;
	const rt0 = rotl32(t0, 9);
	const rt1 = rotl32(t1, 13);
	const rt2 = rotl32(t2, 17);
	const rt3 = rotl32(t3, 19);
	s0 = (rt0 + rt2) & 0xffffffff;
	s1 = (rt1 ^ rt3) >>> 0;
	s2 = (rt2 + s0) & 0xffffffff;
	s3 = (rt3 ^ s1) >>> 0;
	return [...intToLeBytes(s0 >>> 0, 4), ...intToLeBytes(s1 >>> 0, 4), ...intToLeBytes(s2 >>> 0, 4), ...intToLeBytes(s3 >>> 0, 4)];
}

function xorWithKey(payload: number[]): number[] {
	return payload.map((b, i) => (i < HEX_KEY_BYTES.length ? (b ^ HEX_KEY_BYTES[i]!) & 0xff : b & 0xff));
}

function buildPayloadArray(
	hexParameter: string,
	hexMd5Path: string,
	a1Value: string,
	appId: string,
	stringParam: string,
	nowMs: number,
	rnd: Required<SignRandomOverride>,
): number[] {
	const seed = rnd.seed >>> 0;
	const seedByte = seed & 0xff;
	const payload: number[] = [...VERSION_BYTES];
	payload.push(...intToLeBytes(seed, 4));
	const tsBytes = intToLeBytes(nowMs, TIMESTAMP_LE_LENGTH);
	payload.push(...tsBytes);
	const effectiveTsMs = nowMs - rnd.timeOffset * 1000;
	payload.push(...intToLeBytes(effectiveTsMs, 4));
	payload.push(...intToLeBytes(rnd.sequence, 4));
	payload.push(...intToLeBytes(rnd.windowPropsLength, 4));
	payload.push(...intToLeBytes(utf8Bytes(stringParam).length, 4));
	const md5Bytes: number[] = [];
	for (let i = 0; i < hexParameter.length; i += 2) {
		md5Bytes.push(parseInt(hexParameter.slice(i, i + 2), 16));
	}
	payload.push(...md5Bytes.slice(0, MD5_XOR_LENGTH).map((b) => b ^ seedByte));
	const a1Bytes = utf8Bytes(a1Value).slice(0, A1_LENGTH);
	while (a1Bytes.length < A1_LENGTH) {
		a1Bytes.push(0);
	}
	payload.push(a1Bytes.length, ...a1Bytes);
	const appBytes = utf8Bytes(appId).slice(0, APP_ID_LENGTH);
	while (appBytes.length < APP_ID_LENGTH) {
		appBytes.push(0);
	}
	payload.push(appBytes.length, ...appBytes);
	const part11 = [1, seedByte ^ ENV_TABLE[0]!];
	for (let i = 1; i < 15; i++) {
		part11.push(ENV_TABLE[i]! ^ ENV_CHECKS_DEFAULT[i]!);
	}
	payload.push(...part11);
	const md5PathBytes: number[] = [];
	for (let i = 0; i < 32; i += 2) {
		md5PathBytes.push(parseInt(hexMd5Path.slice(i, i + 2), 16));
	}
	payload.push(...A3_PREFIX);
	payload.push(...customHashV2([...tsBytes, ...md5PathBytes]).map((b) => b ^ seedByte));
	return payload;
}

/** X-S in the XYS_ format MediaCrawler/xhshow use (their default). */
function signXs(
	method: "GET" | "POST",
	uri: string,
	a1Value: string,
	data: unknown,
	nowMs: number,
	rnd: Required<SignRandomOverride>,
): string {
	const contentString = buildContentString(method, uri, data);
	const dValue = md5Hex(contentString);
	const mValue = method === "GET" ? dValue : md5Hex(uri);
	const payload = buildPayloadArray(dValue, mValue, a1Value, "xhs-pc-web", contentString, nowMs, rnd);
	const xored = xorWithKey(payload).slice(0, 144);
	const x3 = x3B64(xored);
	// Key order matters (Python dict insertion order is part of the format).
	const signatureData: Record<string, string> = {
		x0: "4.3.5",
		x1: "xhs-pc-web",
		x2: "Windows",
		x3: "",
		x4: "object",
	};
	signatureData["x3"] = "mns0301_" + x3;
	return "XYS_" + customB64(utf8Bytes(JSON.stringify(signatureData)));
}

// ---------------------------------------------------------------------------
// x-s-common (xhshow core/common_sign.py + config template)
// ---------------------------------------------------------------------------

/** x-s-common from a1/b1 (s0/s1/x0..x11 structure, custom-base64 encoded). */
function signXsCommon(a1Value: string, b1: string): string {
	const st: Record<string, string | number> = {
		s0: 5,
		s1: "",
		x0: "1",
		x1: "4.3.5",
		x2: "Windows",
		x3: "xhs-pc-web",
		x4: "4.86.0",
		x5: "",
		x6: "",
		x7: "",
		x8: "",
		x9: -596800761,
		x10: 0,
		x11: "normal",
	};
	st["x5"] = a1Value;
	st["x8"] = b1;
	st["x9"] = crc32JsInt(b1);
	return customB64(utf8Bytes(JSON.stringify(st)));
}

// ---------------------------------------------------------------------------
// b1 synthesis (xhshow generators/fingerprint.py generate_b1)
// ---------------------------------------------------------------------------

/** The fingerprint fields that go into b1 (xhshow b1_fp subset). */
export interface B1Fingerprint {
	x33: string;
	x34: string;
	x35: string;
	x36: string;
	x37: string;
	x38: string;
	x39: number;
	x42: string;
	x43: string;
	x44: string;
	x45: string;
	x46: string;
	x48: string;
	x49: string;
	x50: string;
	x51: string;
	x52: string;
	x82: string;
}

/**
 * Derive b1 from a fingerprint dict. This reproduces xhshow exactly: compact
 * JSON -> RC4("xhswebmplfbt") -> percent-encode -> byte reassembly ->
 * custom base64. The percent-encode + split("%")[1:] dance is byte-identical
 * to UTF-8-encoding the RC4 output interpreted as a latin1 string (Python's
 * quote() UTF-8-encodes non-ASCII chars; the leading split segment is empty
 * because the first RC4 byte is always >0x7F for the fixed '{"x33"…' prefix).
 */
export function b1FromFingerprint(fp: B1Fingerprint): string {
	const json = JSON.stringify(fp);
	const cipherBytes = rc4(B1_SECRET_KEY, utf8Bytes(json));
	const latin1 = String.fromCharCode(...cipherBytes);
	const reassembled = utf8Bytes(latin1);
	return customB64(reassembled);
}

/** Synthesize b1 locally (MediaCrawler's approach when no real page b1 exists). */
export function generateB1(nowMs?: number): string {
	const ms = nowMs ?? Date.now();
	const fp: B1Fingerprint = {
		x33: "0",
		x34: "0",
		x35: "0",
		x36: String(1 + Math.floor(Math.random() * 20)),
		x37: "0|0|0|0|0|0|0|0|0|1|0|0|0|0|0|0|0|0|1|0|0|0|0|0",
		x38: "0|0|1|0|1|0|0|0|0|0|1|0|1|0|1|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0|0",
		x39: 0,
		x42: "3.4.4",
		x43: "742cc32c",
		x44: String(ms),
		x45: "__SEC_CAV__1-1-1-1-1|__SEC_WSA__|",
		x46: "false",
		x48: "",
		x49: "{list:[],type:}",
		x50: "",
		x51: "",
		x52: "",
		x82: "_0x17a2|_0x1954",
	};
	return b1FromFingerprint(fp);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function randomInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
}

function fullRandom(): Required<SignRandomOverride> {
	return {
		seed: randomInt(0, 0xffffffff),
		timeOffset: randomInt(10, 50),
		sequence: randomInt(15, 50),
		windowPropsLength: randomInt(1000, 1200),
	};
}

/**
 * Compute XHS signed headers locally.
 *
 * @param uri    API path, e.g. "/api/sns/web/v2/note/collect/page"
 * @param method "GET" | "POST"
 * @param data   GET params or POST payload (same object passed to request())
 * @param a1     a1 cookie value (required)
 * @param b1     b1 value (page localStorage b1 when available; may be "")
 * @param nowMs  epoch milliseconds (defaults to Date.now(); injectable for tests)
 */
export function xhsSign(
	uri: string,
	method: "GET" | "POST",
	data: unknown,
	a1: string,
	b1: string,
	nowMs?: number,
	randomOverride?: SignRandomOverride,
): XhsSignResult {
	const ms = nowMs ?? Date.now();
	const rnd: Required<SignRandomOverride> = randomOverride ?? fullRandom();
	const b1Value = b1 || generateB1(ms);
	return {
		"X-S": signXs(method, uri, a1, data, ms, rnd),
		"X-T": String(ms),
		"x-s-common": signXsCommon(a1, b1Value),
		"X-B3-Traceid": Array.from({ length: 16 }, () => HEX_CHARS[Math.floor(Math.random() * HEX_CHARS.length)]).join(""),
	};
}
