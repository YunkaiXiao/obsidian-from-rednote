// M5 (ADR-025): pure decision helpers for the auto-scheduled sync.
//
// The plugin registers a central 1-minute tick; each tick calls
// shouldAutoSync with the current settings snapshot to decide whether to
// fire runSync in auto mode. Kept pure so vitest can cover the semantics
// (disabled / not due / due / sync already running / cross-restart catch-up)
// without any Obsidian runtime.

/** Dropdown choices for the settings tab (0 = off). */
export const AUTO_SYNC_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 0, label: "关闭" },
	{ value: 15, label: "15 分钟" },
	{ value: 30, label: "30 分钟" },
	{ value: 60, label: "60 分钟" },
	{ value: 180, label: "3 小时" },
	{ value: 360, label: "6 小时" },
	{ value: 720, label: "12 小时" },
	{ value: 1440, label: "24 小时" },
];

export interface ShouldAutoSyncArgs {
	/** Current time (epoch ms). */
	now: number;
	/** Epoch ms of the last auto-sync trigger (0 = never). */
	lastAutoSyncAt: number;
	/** Interval in minutes; 0 (or negative) = auto sync disabled. */
	autoSyncMinutes: number;
	/** True while a sync run is in flight (manual or auto). */
	syncRunning: boolean;
}

/**
 * Whether the central tick should trigger an auto sync right now.
 *
 * Semantics (ADR-025):
 * - autoSyncMinutes <= 0  -> never (feature default is off);
 * - a running sync blocks a new trigger (tick simply waits for the next
 *   minute; lastAutoSyncAt is stamped before the run starts, so no storm);
 * - due when never-run (lastAutoSyncAt = 0) OR elapsed >= interval. The
 *   never-run case also covers "Obsidian was closed past the deadline and
 *   just reopened": the first tick catches up exactly once, because the
 *   stamp is persisted before the run begins.
 */
export function shouldAutoSync(args: ShouldAutoSyncArgs): boolean {
	if (!(args.autoSyncMinutes > 0)) {
		return false;
	}
	if (args.syncRunning) {
		return false;
	}
	if (args.lastAutoSyncAt <= 0) {
		return true;
	}
	return args.now - args.lastAutoSyncAt >= args.autoSyncMinutes * 60_000;
}

/**
 * Next due time (epoch ms) for the settings display, or null when the
 * feature is off. A due-but-not-yet-fired time (in the past) is returned
 * as-is; the UI renders it as "upcoming on the next tick".
 */
export function nextAutoSyncAtMs(
	lastAutoSyncAt: number,
	autoSyncMinutes: number,
): number | null {
	if (!(autoSyncMinutes > 0)) {
		return null;
	}
	if (lastAutoSyncAt <= 0) {
		return null;
	}
	return lastAutoSyncAt + autoSyncMinutes * 60_000;
}
