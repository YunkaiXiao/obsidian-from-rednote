// Pure Markdown rendering for RedNote notes, strictly following
// docs/note-template.md (ADR-006 frontmatter layout + `> [!info] 来源` callout).
// No runtime side effects, no obsidian/electron imports.

import type { RedNoteRecord } from "./types";

/**
 * Escape a value for use as a single-line YAML scalar in frontmatter.
 * Wraps in double quotes and escapes backslashes + double quotes.
 */
export function yamlScalar(value: string): string {
	return `"${(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Convert an epoch-milliseconds timestamp to ISO 8601 with a UTC offset,
 * e.g. 1727749800000 -> "2026-09-01T10:30:00+08:00".
 *
 * The offset is computed from a fixed zone offset (in minutes) supplied by the
 * caller so the function stays pure/deterministic. XHS publish times are in
 * the account's local zone; for a Chinese account that is +08:00.
 *
 * @param ms        Epoch milliseconds.
 * @param offsetMin UTC offset in minutes (e.g. 480 for +08:00).
 * @returns ISO 8601 string with offset, or "" when ms is not a positive number.
 */
export function epochToIso(ms: number, offsetMin: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return "";
	}
	// Shift into the target zone, then format the calendar fields from the
	// shifted value while the wall-clock is derived from the shifted epoch.
	const shifted = new Date(ms + offsetMin * 60000);
	const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
	const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
	const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
	const sign = offsetMin < 0 ? "-" : "+";
	const abs = Math.abs(offsetMin);
	const off = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
	return `${date}T${time}${off}`;
}

/**
 * Format a date-only string for the source callout (e.g. "2026-09-01"),
 * derived from an ISO 8601 value. Falls back to "未知" when empty.
 */
export function isoToDateOnly(iso: string): string {
	if (!iso) {
		return "未知";
	}
	const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
	return m && m[1] ? m[1] : "未知";
}

/**
 * Apply the user-configurable tag prefix to a list of raw tags.
 * A prefix of "" means "no prefix" (tags written as-is). A missing/empty raw
 * tag is dropped.
 *
 * @param tags  Raw topic tag names.
 * @param prefix Tag prefix, e.g. "xhs/".
 */
export function applyTagPrefix(tags: string[], prefix: string): string[] {
	const p = prefix ?? "";
	return (tags ?? [])
		.map((t) => (t ?? "").trim())
		.filter((t) => t.length > 0)
		.map((t) => (p ? `${p}${t}` : t));
}

/** Render a YAML list of strings (inline if empty, block otherwise). */
function renderYamlStringList(items: string[], indent: string): string {
	if (items.length === 0) {
		return `${indent}[]`;
	}
	return items.map((v) => `${indent}- ${v}`).join("\n");
}

/**
 * Local media paths resolved by the M3 media downloader, mapped onto the
 * rendered body. Absent entries (or null slots) fall back to the M2 remote
 * URL behavior, so a failed download degrades gracefully per file.
 */
export interface NoteMediaMap {
	/** Local vault-relative path per image (index-aligned with record.images); null = keep remote URL. */
	imageLocal: ReadonlyArray<string | null>;
	/** Local video path when downloaded; null = remote link. */
	videoLocal: string | null;
}

/**
 * Make a vault-relative local media path vault-ABSOLUTE ("/RedNote/...").
 * Obsidian resolves markdown-link targets relative to the NOTE's folder, so a
 * plain "RedNote/Media/..." embed breaks for notes inside collection
 * subdirectories; the leading "/" anchors it to the vault root. Remote URLs
 * are never passed here.
 */
export function toVaultAbsolutePath(path: string): string {
	const p = path ?? "";
	return p.startsWith("/") ? p : `/${p}`;
}

/**
 * Escape the note body's standalone `---` lines as `***` (both are horizontal
 * rules in Markdown, but a body-level `---` line would prematurely close the
 * YAML frontmatter). Only whole-line `---` (optional surrounding whitespace)
 * is rewritten; `---` inside a sentence is untouched. Pure.
 */
export function sanitizeBodyHr(body: string): string {
	return (body ?? "").replace(/^[ \t]*---[ \t]*$/gm, "***");
}

/**
 * Render the full note Markdown for a record, per docs/note-template.md.
 *
 * Field ordering matches the template: note_id, type, title, author, author_id,
 * author_link, link, collection, tags, created_at, collected_at, synced_at.
 * (category / ai_* are AI-only (M4) and intentionally omitted here.)
 *
 * Body:
 *  - H1 title
 *  - `> [!info] 来源` callout with author / publish / collected / open-link
 *  - body text
 *  - for image notes: each image embedded as a LOCAL vault-relative
 *    `![](RedNote/Media/{note_id}/n.ext)` when downloaded (M3), else the
 *    remote `![](url)` fallback (M2 behavior)
 *  - for video notes: a markdown link — local `[▶ 视频](path)` when the video
 *    was downloaded (M3, toggle on), else the remote `[▶ 观看视频](url)` link
 *
 * @param record  The normalized note record.
 * @param tagPrefix  User tag prefix setting (default "xhs/").
 * @param media  Optional local-media path map (M3 downloads).
 */
export function renderNoteMarkdown(
	record: RedNoteRecord,
	tagPrefix: string,
	media?: NoteMediaMap,
): string {
	const tags = applyTagPrefix(record.tags, tagPrefix);

	const fm: string[] = [];
	fm.push(`note_id: ${yamlScalar(record.note_id)}`);
	fm.push(`type: ${record.type}`);
	fm.push(`title: ${yamlScalar(record.title)}`);
	fm.push(`author: ${yamlScalar(record.author)}`);
	fm.push(`author_id: ${yamlScalar(record.author_id)}`);
	fm.push(`author_link: ${yamlScalar(record.author_link)}`);
	fm.push(`link: ${yamlScalar(record.link)}`);
	fm.push(`collection: ${record.collection ? yamlScalar(record.collection) : ''}`);
	fm.push(`tags:`);
	fm.push(renderYamlStringList(tags, "  "));
	fm.push(`created_at: ${record.created_at ? yamlScalar(record.created_at) : ''}`);
	fm.push(`collected_at: ${record.collected_at ? yamlScalar(record.collected_at) : ''}`);
	fm.push(`synced_at: ${record.synced_at ? yamlScalar(record.synced_at) : ''}`);
	const frontmatter = `---\n${fm.join("\n")}\n---`;

	// Source callout.
	const authorDisplay = record.author
		? `[${record.author}](${record.author_link})`
		: "未知作者";
	const openLink = `[打开原文](${record.link})`;
	const callout =
		`> [!info] 来源\n` +
		`> 作者：${authorDisplay} ｜ 发布：${isoToDateOnly(record.created_at)}` +
		` ｜ 收藏于：${record.collected_at ? isoToDateOnly(record.collected_at) : "不可得"}` +
		` ｜ ${openLink}`;

	const heading = `# ${record.title || record.note_id}`;

	const bodyLines: string[] = [];
	if (record.body) {
		bodyLines.push(sanitizeBodyHr(record.body));
	}

	if (record.type === "image") {
		record.images.forEach((url, i) => {
			const local = media?.imageLocal[i];
			// Local downloads embed vault-ABSOLUTE (leading "/") so the link
			// resolves from any note folder; remote fallback stays untouched.
			bodyLines.push(`![](${local ? toVaultAbsolutePath(local) : url})`);
		});
	} else if (record.type === "video") {
		if (media?.videoLocal) {
			bodyLines.push(`[▶ 视频](${toVaultAbsolutePath(media.videoLocal)})`);
		} else if (record.video_url) {
			bodyLines.push(`[▶ 观看视频](${record.video_url})`);
		}
	}

	const body = bodyLines.join("\n\n");

	return `${frontmatter}\n\n${heading}\n\n${callout}\n\n${body}\n`;
}

/**
 * Heading that opens the AI block (M4 writes it; M3 must preserve it).
 * Kept as a single constant so producer (M4) and preserver (M3) agree.
 */
export const AI_SECTION_HEADING = "## 🤖 AI 摘要";

/**
 * Extract the AI section (`## 🤖 AI 摘要` line to end-of-file) from an
 * existing note's markdown, for the M3 rewrite path's hard constraint:
 * re-synced notes keep their AI block verbatim. Returns null when the note
 * has no AI section (the rewritten note then gets none either).
 */
export function splitAiSection(existing: string): string | null {
	if (!existing) {
		return null;
	}
	const idx = existing.indexOf(`\n${AI_SECTION_HEADING}`);
	if (idx < 0) {
		// Headless edge: the heading as the very first line of the file.
		if (existing.startsWith(AI_SECTION_HEADING)) {
			return existing;
		}
		return null;
	}
	return existing.slice(idx + 1);
}

/**
 * Append the preserved AI block from `oldContent` (if any) to freshly
 * rendered `newContent`, separated by one blank line. Pure.
 */
export function appendAiSection(newContent: string, oldContent: string): string {
	const ai = splitAiSection(oldContent);
	if (!ai) {
		return newContent;
	}
	// renderNoteMarkdown ends with exactly one "\n"; add one blank line so the
	// heading starts its own paragraph, then the block verbatim to EOF.
	return `${newContent.replace(/\n*$/, "\n")}\n${ai}`;
}

/**
 * One-time repair for notes synced before the vault-absolute embed fix: rewrite
 * markdown link/embed targets `](RedNote/Media/...` (and `](/RedNote/Media/...`
 * with an existing slash) to the anchored `](/RedNote/Media/...` form. Only
 * vault-internal paths under `mediaFolder` match — remote http(s) URLs are
 * untouched. Pure; returns the new text and the number of rewritten targets.
 */
export function fixMediaEmbedPaths(
	content: string,
	mediaFolder: string,
): { text: string; replaced: number } {
	const folder = (mediaFolder ?? "").replace(/^\/+|\/+$/g, "");
	if (!folder) {
		return { text: content ?? "", replaced: 0 };
	}
	const re = new RegExp(`\\]\\((\\/?)(${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/)`, "g");
	let replaced = 0;
	const text = (content ?? "").replace(re, (_all, slash: string, rest: string) => {
		if (slash === "/") {
			// Already vault-absolute — leave as-is without counting.
			return `](${slash}${rest}`;
		}
		replaced += 1;
		return `](/${rest}`;
	});
	return { text, replaced };
}
