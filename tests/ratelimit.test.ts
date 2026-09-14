import { describe, it, expect } from "vitest";
import {
	evaluateRateLimit,
	recordProcessed,
	normalizeRateLimitState,
	parseRateLimitConfig,
	DEFAULT_RATE_LIMIT_CONFIG,
	type RateLimitConfig,
	type RateLimitState,
} from "../src/rednote/ratelimit";

const CFG: RateLimitConfig = { maxNotes: 3, windowMinutes: 10 };
const WINDOW_MS = 10 * 60_000;

function state(windowStart: number, notesInWindow: number): RateLimitState {
	return { windowStart, notesInWindow };
}

describe("evaluateRateLimit", () => {
	it("allows while notesInWindow is below the max", () => {
		const d = evaluateRateLimit(state(1000, 2), CFG, 1000 + 5_000);
		expect(d.action).toBe("allow");
		if (d.action === "allow") {
			expect(d.state).toEqual(state(1000, 2));
		}
	});

	it("waits when the window budget is exhausted, with the exact remaining ms", () => {
		const start = 1000;
		const now = start + 60_000;
		const d = evaluateRateLimit(state(start, 3), CFG, now);
		expect(d.action).toBe("wait");
		if (d.action === "wait") {
			expect(d.waitMs).toBe(WINDOW_MS - 60_000);
			expect(d.state).toEqual(state(start, 3));
		}
	});

	it("rolls the window exactly at the boundary (now == windowStart + windowMs)", () => {
		const start = 1000;
		const d = evaluateRateLimit(state(start, 3), CFG, start + WINDOW_MS);
		expect(d.action).toBe("allow");
		if (d.action === "allow") {
			expect(d.state).toEqual(state(start + WINDOW_MS, 0));
		}
	});

	it("keeps the old window one ms before the boundary", () => {
		const start = 1000;
		const d = evaluateRateLimit(state(start, 3), CFG, start + WINDOW_MS - 1);
		expect(d.action).toBe("wait");
	});

	it("resets the budget after the window expired", () => {
		const start = 1000;
		const now = start + 3 * WINDOW_MS;
		const d = evaluateRateLimit(state(start, 3), CFG, now);
		expect(d.action).toBe("allow");
		if (d.action === "allow") {
			expect(d.state).toEqual(state(now, 0));
		}
	});

	it("is unlimited when maxNotes is 0 or negative", () => {
		const exhausted = state(1000, 999);
		for (const cfg of [
			{ maxNotes: 0, windowMinutes: 10 },
			{ maxNotes: -1, windowMinutes: 10 },
			{ maxNotes: 5, windowMinutes: 0 },
			{ maxNotes: 5, windowMinutes: -3 },
		]) {
			const d = evaluateRateLimit(exhausted, cfg, 1000 + 1);
			expect(d.action).toBe("allow");
		}
	});
});

describe("recordProcessed", () => {
	it("increments the count within the live window", () => {
		const s = recordProcessed(state(1000, 1), CFG, 1000 + 30_000);
		expect(s).toEqual(state(1000, 2));
	});

	it("rolls an expired window first, then counts the note", () => {
		const start = 1000;
		const now = start + WINDOW_MS + 5;
		const s = recordProcessed(state(start, 3), CFG, now);
		expect(s).toEqual(state(now, 1));
	});

	it("reaching the max flips evaluateRateLimit to wait", () => {
		let s = state(1000, 0);
		for (let i = 0; i < 3; i++) {
			s = recordProcessed(s, CFG, 1000 + i);
		}
		expect(evaluateRateLimit(s, CFG, 1003).action).toBe("wait");
	});
});

describe("restart / persistence semantics", () => {
	it("keeps the persisted budget after a restart within the same window", () => {
		// Simulated data.json round-trip: state persisted, app restarted, the
		// same state is loaded back and must still be bound by the old window.
		const before = recordProcessed(state(1000, 2), CFG, 1000 + 30_000);
		const loaded = normalizeRateLimitState(JSON.parse(JSON.stringify(before)));
		expect(loaded).toEqual(state(1000, 3));
		expect(evaluateRateLimit(loaded as RateLimitState, CFG, 1000 + 60_000).action).toBe("wait");
	});

	it("a restart after window expiry starts with a fresh budget", () => {
		const persisted = state(1000, 3);
		const now = 1000 + WINDOW_MS + 1;
		const d = evaluateRateLimit(persisted, CFG, now);
		expect(d.action).toBe("allow");
		if (d.action === "allow") {
			expect(d.state).toEqual(state(now, 0));
		}
	});
});

describe("normalizeRateLimitState", () => {
	it("accepts a valid state", () => {
		expect(normalizeRateLimitState({ windowStart: 5, notesInWindow: 2 })).toEqual(
			state(5, 2),
		);
	});

	it("rejects garbage, wrong shapes and negative values", () => {
		expect(normalizeRateLimitState(null)).toBeNull();
		expect(normalizeRateLimitState(undefined)).toBeNull();
		expect(normalizeRateLimitState("x")).toBeNull();
		expect(normalizeRateLimitState({})).toBeNull();
		expect(normalizeRateLimitState({ windowStart: "5", notesInWindow: 1 })).toBeNull();
		expect(normalizeRateLimitState({ windowStart: 5 })).toBeNull();
		expect(normalizeRateLimitState({ windowStart: 5, notesInWindow: -1 })).toBeNull();
		expect(normalizeRateLimitState({ windowStart: Number.NaN, notesInWindow: 1 })).toBeNull();
	});
});

describe("parseRateLimitConfig", () => {
	it("accepts valid numeric input (including string form from the settings field)", () => {
		expect(parseRateLimitConfig(30, 15)).toEqual({ maxNotes: 30, windowMinutes: 15 });
		expect(parseRateLimitConfig("30", "15")).toEqual({ maxNotes: 30, windowMinutes: 15 });
		expect(parseRateLimitConfig(2.5, 0.5)).toEqual({ maxNotes: 2, windowMinutes: 0.5 });
	});

	it("falls back to defaults for invalid input", () => {
		expect(parseRateLimitConfig("abc", "abc")).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
		expect(parseRateLimitConfig(0, 10)).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
		expect(parseRateLimitConfig(-4, 10)).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
		expect(parseRateLimitConfig(20, 0)).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
		expect(parseRateLimitConfig(undefined, undefined)).toEqual(DEFAULT_RATE_LIMIT_CONFIG);
	});
});
