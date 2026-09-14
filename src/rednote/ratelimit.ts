// Pure module: rolling-window rate limit for the sync pipeline.
//
// Goal (feature #14): process at most N notes per time window (default 20 per
// 10 minutes) so the sync pattern does not look like a bot to Xiaohongshu.
//
// Pure by contract: input is the persisted state + the current time; output is
// the decision (allow / wait-ms) plus the new state. All side effects
// (persisting to data.json, sleeping, Notices) stay in the sync/main layer.
// No obsidian/electron imports, so this file is unit-testable.

/** Budget state for the current window; persisted in data.json. */
export interface RateLimitState {
	/** Epoch ms when the current window started. */
	windowStart: number;
	/** Notes fully processed (detail fetch + write) within the current window. */
	notesInWindow: number;
}

export interface RateLimitConfig {
	/** Max notes processed per window. */
	maxNotes: number;
	/** Window length in minutes (fractional allowed). */
	windowMinutes: number;
}

/** Product defaults (also mirrored in main.ts DEFAULT_SETTINGS). */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
	maxNotes: 20,
	windowMinutes: 10,
};

export type RateLimitDecision =
	| { action: "allow"; state: RateLimitState }
	| { action: "wait"; waitMs: number; state: RateLimitState };

/** Window length in whole ms (>= 1). */
function windowDurationMs(config: RateLimitConfig): number {
	return Math.max(1, Math.round(config.windowMinutes * 60_000));
}

/** Whether the limiter is effectively off (non-positive budget or window). */
function isUnlimited(config: RateLimitConfig): boolean {
	return !(config.maxNotes > 0) || !(config.windowMinutes > 0);
}

/** Fill missing fields of a (possibly degraded) state without inventing budget. */
function withDefaults(state: RateLimitState, nowMs: number): RateLimitState {
	return {
		windowStart: typeof state.windowStart === "number" && Number.isFinite(state.windowStart)
			? state.windowStart
			: nowMs,
		notesInWindow: typeof state.notesInWindow === "number" && Number.isFinite(state.notesInWindow)
			? state.notesInWindow
			: 0,
	};
}

/** Roll the state into the current window if the previous window has expired. */
function rolled(state: RateLimitState, config: RateLimitConfig, nowMs: number): RateLimitState {
	const cur = withDefaults(state, nowMs);
	if (nowMs >= cur.windowStart + windowDurationMs(config)) {
		return { windowStart: nowMs, notesInWindow: 0 };
	}
	return cur;
}

/**
 * Decide whether another note may be processed at `nowMs`.
 *
 * Returns "allow" (with the possibly window-rolled state) or "wait" with the
 * remaining ms until the current window ends. The returned state must be
 * persisted by the caller; the per-note increment itself is applied by
 * `recordProcessed()` once a note has actually been processed.
 */
export function evaluateRateLimit(
	state: RateLimitState,
	config: RateLimitConfig,
	nowMs: number,
): RateLimitDecision {
	if (isUnlimited(config)) {
		return { action: "allow", state };
	}
	const active = rolled(state, config, nowMs);
	if (active.notesInWindow < config.maxNotes) {
		return { action: "allow", state: active };
	}
	return {
		action: "wait",
		waitMs: Math.max(0, active.windowStart + windowDurationMs(config) - nowMs),
		state: active,
	};
}

/**
 * Record one fully processed note (detail fetch + write done) at `nowMs`.
 * Rolls the window first if it expired between the check and the completion.
 */
export function recordProcessed(
	state: RateLimitState,
	config: RateLimitConfig,
	nowMs: number,
): RateLimitState {
	if (isUnlimited(config)) {
		return state;
	}
	const active = rolled(state, config, nowMs);
	return { windowStart: active.windowStart, notesInWindow: active.notesInWindow + 1 };
}

/**
 * Normalize an unknown value (e.g. read back from data.json) into a valid
 * RateLimitState, or null when it is not shape-compatible (caller then starts
 * a fresh window).
 */
export function normalizeRateLimitState(raw: unknown): RateLimitState | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const r = raw as Record<string, unknown>;
	const ws = r.windowStart;
	const n = r.notesInWindow;
	if (typeof ws !== "number" || !Number.isFinite(ws) || ws < 0) {
		return null;
	}
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
		return null;
	}
	return { windowStart: Math.floor(ws), notesInWindow: Math.floor(n) };
}

/**
 * Parse the two user-facing settings values into a valid config, falling back
 * to the product defaults for anything non-numeric or non-positive.
 */
export function parseRateLimitConfig(
	maxNotesRaw: unknown,
	windowMinutesRaw: unknown,
): RateLimitConfig {
	const max = typeof maxNotesRaw === "number" ? maxNotesRaw : Number(maxNotesRaw);
	const minutes =
		typeof windowMinutesRaw === "number" ? windowMinutesRaw : Number(windowMinutesRaw);
	return {
		maxNotes:
			Number.isFinite(max) && max > 0
				? Math.floor(max)
				: DEFAULT_RATE_LIMIT_CONFIG.maxNotes,
		windowMinutes:
			Number.isFinite(minutes) && minutes > 0
				? minutes
				: DEFAULT_RATE_LIMIT_CONFIG.windowMinutes,
	};
}
