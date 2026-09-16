// Pure content-hash + incremental note-index helpers (M3).
// No obsidian/electron imports, so this file is unit-testable in vitest.
// `import crypto from "crypto"` mirrors sign-ref.ts; the esbuild config keeps
// node builtins external, so the desktop plugin resolves it via require.

import crypto from "crypto";

/**
 * The source-data fields a note's content hash covers (M3 contract):
 * note_id / type / title / desc / author_id / tags / image URL list / video URL.
 * Deliberately EXCLUDED: synced_at (changes every run), created_at, collected_at,
 * collection, author nickname, render-time values — they are presentation or
 * bookkeeping, not content; hashing them would cause perpetual rewrites.
 */
export interface NoteHashInput {
	note_id: string;
	type: string;
	title: string;
	desc: string;
	author_id: string;
	tags: string[];
	/** Image URL list IN ORDER (order is content: the embed sequence follows it). */
	images: string[];
	video_url: string;
}

/**
 * Normalize a media URL for hashing: keep everything up to the query string /
 * fragment and drop the rest. XHS CDN content identity lives in the PATH; the
 * query carries rotating signature tokens, so hashing them verbatim would
 * make every token rotation look like a content change and trigger spurious
 * rewrites. Pure and tolerant of odd URL shapes (no URL parsing).
 */
export function normalizeUrlForHash(url: string): string {
	const raw = url ?? "";
	let cut = raw.length;
	const q = raw.indexOf("?");
	if (q >= 0) {
		cut = Math.min(cut, q);
	}
	const h = raw.indexOf("#");
	if (h >= 0) {
		cut = Math.min(cut, h);
	}
	return raw.slice(0, cut);
}

/**
 * Compute the content hash (sha256 hex, 64 chars) of a note's source data.
 * Pure: same input -> same output; any covered field change -> different output.
 * Tag/image order is significant (it shapes the rendered note), so reordering
 * hashes differently by design. Image / video URLs are normalized via
 * normalizeUrlForHash (query tokens excluded).
 */
export function computeNoteHash(input: NoteHashInput): string {
	const payload = JSON.stringify({
		note_id: input.note_id ?? "",
		type: input.type ?? "",
		title: input.title ?? "",
		desc: input.desc ?? "",
		author_id: input.author_id ?? "",
		tags: [...(input.tags ?? [])],
		images: (input.images ?? []).map(normalizeUrlForHash),
		video_url: normalizeUrlForHash(input.video_url ?? ""),
	});
	return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * One entry of the incremental note index persisted in data.json (M3).
 *  - hash:     content hash at last write; "" = content unknown (migrated from
 *              the legacy syncedNoteIds array — reconciled on the next sync).
 *  - syncedAt: ISO 8601 (+08:00) of the last write/reconcile.
 *  - file:     vault-relative .md path of the last write (absent for
 *              reconciled-only legacy entries).
 */
export interface NoteIndexEntry {
	hash: string;
	syncedAt: string;
	file?: string;
}

/** note_id -> index entry. Entries exist per synced note (no unbounded array). */
export type NoteIndex = Record<string, NoteIndexEntry>;

/**
 * Migrate the legacy `syncedNoteIds: string[]` setting into a NoteIndex.
 * Entries are created with hash "" ("content unknown, reconcile next sync").
 * Existing index entries are never overwritten; non-string ids are dropped;
 * duplicates collapse. Pure (returns a new record; inputs untouched).
 *
 * @param legacy   The raw legacy value as loaded from data.json (may be absent
 *                 or of any shape — anything but a string[] yields the base).
 * @param base     Current noteIndex to merge into.
 * @param syncedAt Timestamp recorded on migrated entries.
 */
export function migrateLegacyNoteIds(
	legacy: unknown,
	base: NoteIndex,
	syncedAt: string,
): NoteIndex {
	const out: NoteIndex = { ...base };
	if (!Array.isArray(legacy)) {
		return out;
	}
	for (const id of legacy) {
		if (typeof id !== "string" || id.length === 0) {
			continue;
		}
		if (out[id]) {
			continue;
		}
		out[id] = { hash: "", syncedAt };
	}
	return out;
}

/** Whether a legacy syncedNoteIds value is present (drives the one-shot migration). */
export function hasLegacyNoteIds(raw: unknown): boolean {
	return Array.isArray(raw);
}
