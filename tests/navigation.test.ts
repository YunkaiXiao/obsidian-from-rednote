import { describe, it, expect } from "vitest";
import { isXhsHost } from "../src/rednote/api";

// isXhsHost is the pure predicate behind the in-webview navigation gate
// (api.ts). It must accept xiaohongshu.com AND its subdomains (www., edith.,
// xhscdn., rednote.) and reject everything else, so the gate can pull the
// webview back to the XHS home page on an off-domain navigation.

describe("isXhsHost", () => {
	it("accepts the apex xiaohongshu.com host", () => {
		expect(isXhsHost("https://xiaohongshu.com/")).toBe(true);
	});

	it("accepts www.xiaohongshu.com", () => {
		expect(isXhsHost("https://www.xiaohongshu.com/explore/abc")).toBe(true);
	});

	it("accepts edith.xiaohongshu.com (the API host)", () => {
		expect(isXhsHost("https://edith.xiaohongshu.com/api/sns/web/v1/feed")).toBe(true);
	});

	it("accepts deeper subdomains of xiaohongshu.com", () => {
		expect(isXhsHost("https://passport.xiaohongshu.com/login")).toBe(true);
	});

	it("accepts xhscdn.com and its subdomains (media CDN)", () => {
		expect(isXhsHost("https://sns-img-bd.xhscdn.com/abc.webp")).toBe(true);
		expect(isXhsHost("https://xhscdn.com/")).toBe(true);
	});

	it("accepts rednote.com (international domain)", () => {
		expect(isXhsHost("https://www.rednote.com/explore/abc")).toBe(true);
	});

	it("rejects unrelated hosts", () => {
		expect(isXhsHost("https://evil.com/")).toBe(false);
		expect(isXhsHost("https://xiaohongshu.com.evil.com/")).toBe(false);
		expect(isXhsHost("https://xiaohongshu.com.attacker.example/")).toBe(false);
	});

	it("rejects a lookalike that only shares a suffix but is a different TLD", () => {
		// endsWith(".xiaohongshu.com") guard means "not-xiaohongshu.com" must NOT match.
		expect(isXhsHost("https://notxiaohongshu.com/")).toBe(false);
	});

	it("rejects an unparseable URL", () => {
		expect(isXhsHost("not a url")).toBe(false);
		expect(isXhsHost("")).toBe(false);
	});
});
