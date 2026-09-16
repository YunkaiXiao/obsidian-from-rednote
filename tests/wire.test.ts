import { describe, it, expect } from "vitest";
import {
	buildBoardNoteParams,
	buildCollectPageParams,
	buildGetQueryString,
	joinCookies,
	extractCookieValue,
	buildXrayTraceid,
	newXrayTraceid,
} from "../src/rednote/wire";
import { xhsQueryEscape } from "../src/rednote/sign";

// ---------------------------------------------------------------------------
// Request-shape helpers for the plugin-process (requestUrl) pipeline. The
// query composition here is shared by the signed content string AND the
// requested URL, so these tests pin the exact wire bytes.
// ---------------------------------------------------------------------------

describe("buildCollectPageParams (query order per reference sign-manager)", () => {
	it("orders cursor -> num -> user_id -> image_formats on paged requests", () => {
		const p = buildCollectPageParams("5a89c2c39e52e17b3b7f9403c", "abc123");
		expect(Object.keys(p)).toEqual(["cursor", "num", "user_id", "image_formats", "xsec_token", "xsec_source"]);
		expect(p["cursor"]).toBe("abc123");
		expect(p["num"]).toBe("30");
		expect(p["user_id"]).toBe("5a89c2c39e52e17b3b7f9403c");
		expect(p["image_formats"]).toBe("jpg,webp,avif");
	});

	it("omits cursor on the first page (cursor=\"\" -> param absent)", () => {
		const p = buildCollectPageParams("u1", "");
		expect(Object.keys(p)).toEqual(["num", "user_id", "image_formats", "xsec_token", "xsec_source"]);
	});
});

describe("buildBoardNoteParams (M3.1 board/note: board_id -> cursor -> num)", () => {
	it("orders board_id -> cursor -> num on paged requests", () => {
		const p = buildBoardNoteParams("65f2a8b3000000001234", "c1");
		expect(Object.keys(p)).toEqual(["board_id", "cursor", "num"]);
		expect(p["board_id"]).toBe("65f2a8b3000000001234");
		expect(p["cursor"]).toBe("c1");
		expect(p["num"]).toBe("30");
	});

	it("omits cursor on the first page and defaults num to 30", () => {
		const p = buildBoardNoteParams("b1", "");
		expect(Object.keys(p)).toEqual(["board_id", "num"]);
		expect(p["num"]).toBe("30");
	});

	it("honors an explicit page size", () => {
		expect(buildBoardNoteParams("b1", "c", 50)["num"]).toBe("50");
	});

	it("serializes to the exact query the signature is computed over", () => {
		expect(buildGetQueryString(buildBoardNoteParams("b/1", "c=2"))).toBe(
			"board_id=b%2F1&cursor=c%3D2&num=30",
		);
	});
});

describe("buildGetQueryString (signed content string == URL query)", () => {
	it("serializes in insertion order with commas kept literal", () => {
		const qs = buildGetQueryString(
			buildCollectPageParams("5a89c2c39e52e17b3b7f9403c", "abc123"),
		);
		expect(qs).toBe(
			"cursor=abc123&num=30&user_id=5a89c2c39e52e17b3b7f9403c&image_formats=jpg,webp,avif&xsec_token=&xsec_source=",
		);
	});

	it("escapes reserved chars the way the signature content string does", () => {
		const qs = buildGetQueryString(buildCollectPageParams("u/1+2", "c=1"));
		expect(qs).toBe("cursor=c%3D1&num=30&user_id=u%2F1%2B2&image_formats=jpg,webp,avif&xsec_token=&xsec_source=");
	});

	it("uses xhsQueryEscape verbatim for every value", () => {
		const value = "AB3rO-QopW5s==;!~'";
		const qs = buildGetQueryString({ t: value });
		expect(qs).toBe(`t=${xhsQueryEscape(value)}`);
	});
});

describe("joinCookies (Cookie header value)", () => {
	it("joins name=value pairs with '; ' separators", () => {
		expect(
			joinCookies([
				{ name: "a1", value: "18ab1e5ce487139a3b7f9403557a0a11a52cef1b52" },
				{ name: "web_session", value: "0400699abcde" },
				{ name: "abRequestId", value: "xyz" },
			]),
		).toBe(
			"a1=18ab1e5ce487139a3b7f9403557a0a11a52cef1b52; web_session=0400699abcde; abRequestId=xyz",
		);
	});

	it("returns '' for an empty cookie list and preserves '=' inside values", () => {
		expect(joinCookies([])).toBe("");
		expect(joinCookies([{ name: "t", value: "v=1" }])).toBe("t=v=1");
	});
});

describe("extractCookieValue (a1 for local signing)", () => {
	const cs = "webId=abc; a1=18ab1e5ce487139a3b7f9403557a0a11a52cef1b52; web_session=0400699; abRequest=%2Fpath";

	it("extracts a cookie value from a raw Cookie header string", () => {
		expect(extractCookieValue(cs, "a1")).toBe("18ab1e5ce487139a3b7f9403557a0a11a52cef1b52");
		expect(extractCookieValue(cs, "web_session")).toBe("0400699");
	});

	it("best-effort decodes percent-encoded values and returns '' when absent", () => {
		expect(extractCookieValue(cs, "abRequest")).toBe("/path");
		expect(extractCookieValue(cs, "missing")).toBe("");
		expect(extractCookieValue("a=%ZZ", "a")).toBe("%ZZ");
	});
});

describe("x-xray-traceid format (hex((ms << 23) | seq) + 16 random hex)", () => {
	const NOW_MS = 1764896636081;

	it("matches the precomputed wire format for a fixed sequence and suffix", () => {
		// Golden: BigInt(1764896636081) << 23n | 42n -> 0xcd7604be5880002a.
		expect(buildXrayTraceid(NOW_MS, 42, "0123456789abcdef")).toBe(
			"cd7604be5880002a0123456789abcdef",
		);
	});

	it("ORs the sequence into the low 23 bits without carrying", () => {
		expect(buildXrayTraceid(NOW_MS, 0x7fffff, "ffffffffffffffff")).toBe(
			"cd7604be58ffffffffffffffffffffff",
		);
	});

	it("newXrayTraceid: lowercase hex, 16-char random tail, timestamp recoverable", () => {
		const tid = newXrayTraceid(NOW_MS);
		expect(tid).toMatch(/^[0-9a-f]+$/);
		expect(tid.length).toBeGreaterThan(16);
		const tail = tid.slice(-16);
		expect(tail).toMatch(/^[0-9a-f]{16}$/);
		// Stripping the random tail and shifting back recovers the exact ms
		// (the 23-bit sequence ORs below the timestamp, never into it).
		expect(BigInt("0x" + tid.slice(0, tid.length - 16)) >> 23n).toBe(BigInt(NOW_MS));
	});
});
