// Pure filename helpers for writing notes into the Obsidian vault.
// No runtime side effects, no obsidian/electron imports.

/**
 * Windows-reserved characters that must be stripped from a file name.
 *   / \ : * ? " < > |
 * See docs/note-template.md "文件与附件位置".
 */
const WINDOWS_INVALID_CHARS = /[/\\:*?"<>|]/g;

/**
 * Remove Windows-invalid characters from a raw title and normalize it for use
 * as a file name stem (without extension).
 *
 * Rules:
 *  - strip `/ \ : * ? " < > |`
 *  - collapse runs of whitespace and strip leading/trailing whitespace
 *  - strip leading/trailing dots (Windows treats these as invisible)
 *  - if the result is empty, fall back to the note id (so a note can always be saved)
 *
 * @param rawTitle  The raw note title.
 * @param noteId    Fallback when the cleaned title is empty.
 */
export function cleanNoteFileName(rawTitle: string, noteId: string): string {
	const stripped = (rawTitle ?? "").replace(WINDOWS_INVALID_CHARS, "");
	const collapsed = stripped.replace(/\s+/g, " ").trim();
	const noTrailingDot = collapsed.replace(/\.+$/g, "").replace(/^\.+/, "");
	return noTrailingDot.length > 0 ? noTrailingDot : (noteId ?? "note");
}

/**
 * Resolve the final file name for a note, handling same-title collisions.
 *
 * If the cleaned title alone is not already used, the name is
 * `<cleanedTitle>.md`. Otherwise we append the last 4 chars of the note id:
 * `<cleanedTitle>-<noteId4>.md`. If that still collides (two distinct notes
 * sharing both title AND last-4 id — extremely unlikely but possible), we keep
 * appending the next 4-char window of the note id so the name is unique.
 *
 * @param rawTitle      The raw note title.
 * @param noteId        The full note id (used for the collision suffix).
 * @param takenNames    Set of file names already present / reserved.
 * @returns A unique `.md` file name.
 */
export function resolveNoteFileName(
	rawTitle: string,
	noteId: string,
	takenNames: ReadonlySet<string>,
): string {
	const stem = cleanNoteFileName(rawTitle, noteId);
	let candidate = `${stem}.md`;
	if (!takenNames.has(candidate)) {
		return candidate;
	}

	const idFull = noteId ?? "";
	// Canonical first choice: last 4 chars of the note id (per docs/note-template.md).
	let candidate2 = `${stem}-${idFull.slice(-4)}.md`;
	if (!takenNames.has(candidate2)) {
		return candidate2;
	}

	// Extremely rare: same title and same last-4 id. Step the 4-char window left
	// from the second-to-last window until unique (e.g. a8b3 -> f2a8 -> 5f2a -> …).
	for (let end = idFull.length - 5; end >= 0; end -= 4) {
		const win = idFull.slice(end, end + 4);
		const c = `${stem}-${win}.md`;
		if (!takenNames.has(c)) {
			return c;
		}
	}
	// Absolute last resort (note id shorter than expected): fall back to full id.
	let fallback = `${stem}-${idFull}.md`;
	let i = 1;
	while (takenNames.has(fallback)) {
		fallback = `${stem}-${idFull}-${i}.md`;
		i += 1;
	}
	return fallback;
}
