import { describe, it, expect } from "vitest";
import {
	shouldAutoSync,
	nextAutoSyncAtMs,
	AUTO_SYNC_OPTIONS,
} from "../src/rednote/autosync";

const MIN = 60_000;

function args(overrides: Partial<Parameters<typeof shouldAutoSync>[0]> = {}) {
	return {
		now: 1_000_000 * MIN,
		lastAutoSyncAt: 1_000_000 * MIN - 30 * MIN,
		autoSyncMinutes: 30,
		syncRunning: false,
		...overrides,
	};
}

describe("shouldAutoSync", () => {
	it("never fires when disabled (autoSyncMinutes = 0, the default)", () => {
		expect(shouldAutoSync(args({ autoSyncMinutes: 0 }))).toBe(false);
	});

	it("never fires on a negative/NaN-ish interval", () => {
		expect(shouldAutoSync(args({ autoSyncMinutes: -5 }))).toBe(false);
	});

	it("does not fire before the interval has elapsed", () => {
		expect(shouldAutoSync(args({ now: args().lastAutoSyncAt + 29 * MIN }))).toBe(false);
	});

	it("fires at exactly the interval boundary", () => {
		expect(shouldAutoSync(args({ now: args().lastAutoSyncAt + 30 * MIN }))).toBe(true);
	});

	it("fires after the interval has elapsed", () => {
		expect(shouldAutoSync(args({ now: args().lastAutoSyncAt + 31 * MIN }))).toBe(true);
	});

	it("does not fire while a sync run is in flight", () => {
		expect(shouldAutoSync(args({ syncRunning: true }))).toBe(false);
	});

	it("cross-restart semantics: never-run stamp (0) fires on the first tick (catch-up after long closure)", () => {
		expect(
			shouldAutoSync(args({ lastAutoSyncAt: 0 })),
		).toBe(true);
	});

	it("cross-restart semantics: a stamp persisted long ago fires exactly once due — the caller re-stamps before running, so no storm", () => {
		// Stamp from 3 days ago with a 15-minute interval.
		const stale = args({ lastAutoSyncAt: args().now - 3 * 24 * 60 * MIN, autoSyncMinutes: 15 });
		expect(shouldAutoSync(stale)).toBe(true);
		// After the caller stamps lastAutoSyncAt = now (persisted BEFORE the
		// run starts), the immediately following tick must not re-fire even
		// though the previous run is still going or just failed.
		expect(shouldAutoSync({ ...stale, lastAutoSyncAt: stale.now })).toBe(false);
	});
});

describe("nextAutoSyncAtMs", () => {
	it("returns null when disabled", () => {
		expect(nextAutoSyncAtMs(123, 0)).toBeNull();
	});

	it("returns null when never run (nothing meaningful to show)", () => {
		expect(nextAutoSyncAtMs(0, 30)).toBeNull();
	});

	it("returns lastAutoSyncAt + interval", () => {
		expect(nextAutoSyncAtMs(1000, 15)).toBe(1000 + 15 * MIN);
	});
});

describe("AUTO_SYNC_OPTIONS", () => {
	it("starts with the off value and covers the contract choices", () => {
		expect(AUTO_SYNC_OPTIONS.map((o) => o.value)).toEqual([
			0, 15, 30, 60, 180, 360, 720, 1440,
		]);
	});
});
