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
 *  - for image notes: each image embedded as a remote `![](url)` (M2 temp)
 *  - for video notes: a markdown link to the video URL (M2 temp)
 *
 * @param record  The normalized note record.
 * @param tagPrefix  User tag prefix setting (default "xhs/").
 */
export function renderNoteMarkdown(record: RedNoteRecord, tagPrefix: string): string {
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
		bodyLines.push(record.body);
	}

	if (record.type === "image") {
		for (const url of record.images) {
			bodyLines.push(`![](${url})`);
		}
	} else if (record.type === "video") {
		if (record.video_url) {
			bodyLines.push(`[▶ 观看视频](${record.video_url})`);
		}
	}

	const body = bodyLines.join("\n\n");

	return `${frontmatter}\n\n${heading}\n\n${callout}\n\n${body}\n`;
}
