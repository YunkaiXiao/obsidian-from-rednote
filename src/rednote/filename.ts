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
	// Windows MAX_PATH: vault root + folder chain + name + ".md" (+ collision
	// suffix room) must stay under ~260 chars. Cap the stem at 120 — enough
	// for any realistic folder depth (observed failure: a 200+ char XHS title
	// produced ENOENT on adapter.write).
	const capped = noTrailingDot.slice(0, 120).trim();
	return capped.length > 0 ? capped : (noteId ?? "note");
}

/**
 * Windows-reserved device names (case-insensitive). A folder named one of
 * these is unusable on Windows (the OS resolves the name to a device), so a
 * trailing underscore is appended — Windows' own convention ("CON" -> "CON_").
 */
const WINDOWS_RESERVED_NAMES = new Set([
	"CON", "PRN", "AUX", "NUL",
	"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Fallback folder name when a 收藏夹 name cleans to empty. */
const FALLBACK_COLLECTION_FOLDER = "未命名收藏夹";

/**
 * Clean a 收藏夹 (favorites board) name for use as a sub-directory under the
 * notes folder. Same cleaning rules as cleanNoteFileName (Windows-invalid
 * characters stripped, whitespace collapsed/trimmed, dots trimmed) plus:
 *  - Windows-reserved device names (also before a ".ext" suffix) get a
 *    trailing underscore after the reserved stem;
 *  - an empty result falls back to a fixed placeholder.
 *
 * The caller maps an EMPTY collection string (flat ungrouped favorites) to
 * the notes-folder root BEFORE this runs — "" never reaches here.
 */
export function cleanCollectionFolderName(rawCollection: string): string {
	const cleaned = cleanNoteFileName(rawCollection, FALLBACK_COLLECTION_FOLDER);
	const stem = cleaned.split(".")[0] ?? cleaned;
	if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
		return `${stem}_${cleaned.slice(stem.length)}`;
	}
	return cleaned;
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

/**
 * Resolve the file name for a RE-SYNC (M3 rewrite path).
 *
 * The note's previous file (if any) is REMOVED from the taken-name set before
 * resolving, so an unchanged title re-resolves to the SAME name and the note
 * is rewritten in place — feeding the old name into the taken set would force
 * a new suffixed copy on every sync (the M3 review's copy-accumulation
 * defect). A genuinely changed title resolves to a fresh free name; the
 * caller then writes the new file and deletes `prevFile`.
 *
 * @param rawTitle    The (new) raw note title.
 * @param noteId      The full note id (collision suffix source).
 * @param takenNames  File names currently present in the notes folder.
 * @param prevFile    Vault-relative path of the note's previous .md (or undefined).
 * @returns The target `.md` file NAME (basename).
 */
export function resolveRewriteFileName(
	rawTitle: string,
	noteId: string,
	takenNames: ReadonlySet<string>,
	prevFile: string | undefined,
): string {
	const taken = new Set(takenNames);
	if (prevFile) {
		const prevBase = prevFile.slice(prevFile.lastIndexOf("/") + 1);
		if (prevBase) {
			taken.delete(prevBase);
		}
	}
	return resolveNoteFileName(rawTitle, noteId, taken);
}
