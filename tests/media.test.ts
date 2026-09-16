import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
	extFromUrl,
	extFromContentType,
	resolveImageExtension,
	imageFileName,
	mediaDirFor,
	noteMediaPath,
	VIDEO_FILE_NAME,
	findExistingMediaName,
	syncNoteMedia,
	httpsGet,
} from "../src/rednote/media";
import { EDGE_UA } from "../src/rednote/wire";

describe("extFromUrl", () => {
	it("reads a plain .webp extension", () => {
		expect(extFromUrl("https://sns-webpic-qc.xhscdn.com/2026/abc123.webp")).toBe(".webp");
	});

	it("reads .jpg / .jpeg / .png / .gif / .avif", () => {
		expect(extFromUrl("http://x/a.jpg")).toBe(".jpg");
		expect(extFromUrl("http://x/a.jpeg")).toBe(".jpeg");
		expect(extFromUrl("http://x/a.png")).toBe(".png");
		expect(extFromUrl("http://x/a.gif")).toBe(".gif");
		expect(extFromUrl("http://x/a.avif")).toBe(".avif");
	});

	it("is case-insensitive and lowercases the result", () => {
		expect(extFromUrl("http://x/IMAGE.JPG")).toBe(".jpg");
	});

	it("strips the CDN resize suffix after '!' (…!nd_dft_wlteh_webp_3)", () => {
		expect(
			extFromUrl(
				"http://sns-webpic-qc.xhscdn.com/202403051117/token/1040g00830nbhf4sg5s0048mchf2u3vs9oe03hn8!nd_dft_wlteh_webp_3",
			),
		).toBe("");
	});

	it("keeps the extension before a '!' suffix (…jpg!nc_n_webp_mw_1)", () => {
		expect(
			extFromUrl("http://sns-webpic-qc.xhscdn.com/202401251821/token/01e5ad2cbdd8_0.jpg!nc_n_webp_mw_1"),
		).toBe(".jpg");
	});

	it("ignores query strings and fragments", () => {
		expect(extFromUrl("http://x/a.webp?x-oss-process=1")).toBe(".webp");
		expect(extFromUrl("http://x/a.jpg#frag")).toBe(".jpg");
	});

	it("returns \"\" for extension-less URLs", () => {
		expect(extFromUrl("http://x/1040g00830nbhf4sg5s0048mchf2u3vs9oe03hn8")).toBe("");
	});

	it("returns \"\" for unknown extensions", () => {
		expect(extFromUrl("http://x/file.txt")).toBe("");
	});
});

describe("extFromContentType", () => {
	it("maps common image types", () => {
		expect(extFromContentType("image/webp")).toBe(".webp");
		expect(extFromContentType("image/jpeg")).toBe(".jpg");
		expect(extFromContentType("image/png")).toBe(".png");
		expect(extFromContentType("image/avif")).toBe(".avif");
	});

	it("strips parameters and tolerates case/absence", () => {
		expect(extFromContentType("Image/JPEG; charset=binary")).toBe(".jpg");
		expect(extFromContentType(undefined)).toBe("");
		expect(extFromContentType("application/octet-stream")).toBe("");
	});
});

describe("resolveImageExtension", () => {
	it("URL extension wins over Content-Type", () => {
		expect(resolveImageExtension("http://x/a.jpg", "image/webp")).toBe(".jpg");
	});

	it("falls back to Content-Type when the URL has none", () => {
		expect(resolveImageExtension("http://x/1040g008", "image/webp")).toBe(".webp");
	});

	it("defaults to .webp when neither is usable (M3 contract)", () => {
		expect(resolveImageExtension("http://x/1040g008")).toBe(".webp");
		expect(resolveImageExtension("http://x/a.txt", "text/html")).toBe(".webp");
	});
});

describe("imageFileName", () => {
	it("numbers images from 1 with the resolved extension", () => {
		expect(imageFileName(1, ".webp")).toBe("1.webp");
		expect(imageFileName(2, ".jpg")).toBe("2.jpg");
	});

	it("defaults to .webp when the extension is empty", () => {
		expect(imageFileName(3, "")).toBe("3.webp");
	});
});

describe("VIDEO_FILE_NAME", () => {
	it("is the fixed video.mp4 per the M3 contract", () => {
		expect(VIDEO_FILE_NAME).toBe("video.mp4");
	});
});

describe("mediaDirFor", () => {
	it("joins mediaFolder and note_id", () => {
		expect(mediaDirFor("RedNote/Media", "65f2a8b3")).toBe("RedNote/Media/65f2a8b3");
	});

	it("strips stray leading/trailing slashes", () => {
		expect(mediaDirFor("/RedNote/Media/", "65f2a8b3")).toBe("RedNote/Media/65f2a8b3");
	});

	it("degrades gracefully on empty parts", () => {
		expect(mediaDirFor("", "abc")).toBe("abc");
		expect(mediaDirFor("RedNote/Media", "")).toBe("RedNote/Media");
	});
});

describe("noteMediaPath", () => {
	it("builds {mediaFolder}/{note_id}/{file}", () => {
		expect(noteMediaPath("RedNote/Media", "65f2a8b3", "1.webp")).toBe(
			"RedNote/Media/65f2a8b3/1.webp",
		);
		expect(noteMediaPath("RedNote/Media", "65f2a8b3", VIDEO_FILE_NAME)).toBe(
			"RedNote/Media/65f2a8b3/video.mp4",
		);
	});
});

describe("findExistingMediaName (M3 review fix 4)", () => {
	it("matches any extension for the seq slot", () => {
		expect(findExistingMediaName(["1.webp", "2.jpg"], 1)).toBe("1.webp");
		expect(findExistingMediaName(["1.webp", "2.jpg"], 2)).toBe("2.jpg");
	});

	it("returns null when the seq slot is free", () => {
		expect(findExistingMediaName(["1.webp"], 2)).toBeNull();
		expect(findExistingMediaName([], 1)).toBeNull();
	});

	it("does not confuse seq prefixes (10. is not 1.)", () => {
		expect(findExistingMediaName(["10.webp"], 1)).toBeNull();
		expect(findExistingMediaName(["1.webp", "10.webp"], 10)).toBe("10.webp");
	});

	it("rejects malformed suffixes (dirs, long junk)", () => {
		expect(findExistingMediaName(["1.webp.bak"], 1)).toBeNull();
		expect(findExistingMediaName(["1.abcdefghi"], 1)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Transport-level integration (deterministic: the "https" module is stubbed,
// child_process is stubbed unavailable; NO external network is touched).
// ---------------------------------------------------------------------------

interface FakeOutcome {
	status: number;
	contentType?: string;
	body?: Buffer;
	error?: string;
}

/** In-memory DataAdapter double (cast at the call site — test-only). */
class MemoryAdapter {
	files = new Map<string, ArrayBuffer>();
	dirs = new Set<string>();
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p);
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p);
	}
	async writeBinary(p: string, data: ArrayBuffer): Promise<void> {
		this.files.set(p, data);
	}
	async remove(p: string): Promise<void> {
		this.files.delete(p);
	}
	async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		for (const f of this.files.keys()) {
			if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) {
				files.push(f);
			}
		}
		return { files, folders: [] };
	}
}

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
}

/**
 * Build a fake Node "https" module: request() reports outcomes keyed by URL
 * substring; requests are recorded for header/order assertions.
 */
function fakeHttps(outcomes: Record<string, FakeOutcome>): {
	module: unknown;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const module = {
		request: (
			opts: { hostname: string; path: string; headers: Record<string, string> },
			cb: (res: unknown) => void,
		) => {
			const req = new EventEmitter() as EventEmitter & {
				write: () => void;
				end: () => void;
				destroy: () => void;
			};
			const url = `https://${opts.hostname}${opts.path}`;
			req.write = () => {};
			req.end = () => {
				requests.push({ url, headers: opts.headers });
				const hit = Object.keys(outcomes).find((k) => url.includes(k));
				const outcome = hit ? outcomes[hit] : undefined;
				if (!outcome || outcome.error) {
					process.nextTick(() => req.emit("error", new Error(outcome?.error ?? "no fake outcome")));
					return;
				}
				const res = new EventEmitter() as EventEmitter & {
					statusCode: number;
					headers: Record<string, string | undefined>;
				};
				res.statusCode = outcome.status;
				res.headers = { "content-type": outcome.contentType };
				process.nextTick(() => {
					cb(res);
					if (outcome.body?.length) {
						res.emit("data", outcome.body);
					}
					res.emit("end");
				});
			};
			req.destroy = () => {};
			return req;
		},
	};
	return { module, requests };
}

const noopLog = (): void => {};

interface Harness {
	requests: CapturedRequest[];
	restore: () => void;
}

/**
 * Stub globalThis.window.require so media.ts resolves the fake https module
 * and a deliberately unavailable child_process (both-fail path stays fast).
 */
function stubRequire(httpsModule: unknown): Harness {
	const prev = (globalThis as { window?: unknown }).window;
	(globalThis as { window?: unknown }).window = {
		require: (m: string) => {
			if (m === "https") {
				return httpsModule;
			}
			if (m === "child_process") {
				return {}; // execFile missing -> curl fallback resolves as failed
			}
			return undefined;
		},
	};
	return {
		requests: (httpsModule as { requests: CapturedRequest[] }).requests,
		restore: () => {
			(globalThis as { window?: unknown }).window = prev;
		},
	};
}

describe("syncNoteMedia (integration, stubbed transports)", () => {
	const asAdapter = (a: MemoryAdapter): Parameters<typeof syncNoteMedia>[1] =>
		a as unknown as Parameters<typeof syncNoteMedia>[1];

	it("downloads images in image_list order as 1.webp / 2.webp with UA + Referer", async () => {
		const { module, requests } = fakeHttps({
			"img-a": { status: 200, contentType: "image/webp", body: Buffer.from("A") },
			"img-b": { status: 200, contentType: "image/webp", body: Buffer.from("BB") },
		});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: ["https://cdn/img-a.webp", "https://cdn/img-b.webp"],
					videoUrl: "",
					downloadVideos: false,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(requests.map((r) => r.url)).toEqual([
				"https://cdn/img-a.webp",
				"https://cdn/img-b.webp",
			]);
			for (const r of requests) {
				expect(r.headers["User-Agent"]).toBe(EDGE_UA);
				expect(r.headers["Referer"]).toBe("https://www.xiaohongshu.com/");
			}
			expect(res.imageLocal).toEqual([
				"RedNote/Media/note1/1.webp",
				"RedNote/Media/note1/2.webp",
			]);
			expect(res.downloaded).toBe(2);
			expect(res.failed).toBe(0);
			expect(Buffer.from(adapter.files.get("RedNote/Media/note1/2.webp")!).toString()).toBe("BB");
		} finally {
			h.restore();
		}
	});

	it("skips files that already exist on disk (gap-fill: no re-download)", async () => {
		const { module, requests } = fakeHttps({
			"img-a": { status: 200, contentType: "image/webp", body: Buffer.from("A") },
		});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			adapter.files.set("RedNote/Media/note1/2.webp", new ArrayBuffer(2));
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: ["https://cdn/img-a.webp", "https://cdn/img-b.webp"],
					videoUrl: "",
					downloadVideos: false,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(requests).toHaveLength(1); // only image 1 was fetched
			expect(res.imageLocal[1]).toBe("RedNote/Media/note1/2.webp");
			expect(res.skippedExisting).toBe(1);
			expect(res.downloaded).toBe(1);
		} finally {
			h.restore();
		}
	});

	it("keeps the note alive when one image fails on both channels (null -> remote URL)", async () => {
		const { module } = fakeHttps({
			"img-a": { status: 0, error: "refused" },
			"img-b": { status: 200, contentType: "image/webp", body: Buffer.from("B") },
		});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: ["https://cdn/img-a.webp", "https://cdn/img-b.webp"],
					videoUrl: "",
					downloadVideos: false,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(res.imageLocal[0]).toBeNull(); // falls back to the remote URL
			expect(res.imageLocal[1]).toBe("RedNote/Media/note1/2.webp");
			expect(res.failed).toBe(1);
			expect(res.downloaded).toBe(1);
		} finally {
			h.restore();
		}
	});

	it("refines the extension from Content-Type when the URL has none", async () => {
		const { module } = fakeHttps({
			"img-a": { status: 200, contentType: "image/jpeg", body: Buffer.from("J") },
		});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: ["https://cdn/img-a"],
					videoUrl: "",
					downloadVideos: false,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(res.imageLocal[0]).toBe("RedNote/Media/note1/1.jpg");
		} finally {
			h.restore();
		}
	});

	it("toggle OFF: video is never fetched, videoLocal stays null (M2 behavior)", async () => {
		const { module, requests } = fakeHttps({});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: [],
					videoUrl: "https://cdn/video-src.mp4",
					downloadVideos: false,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(requests).toHaveLength(0);
			expect(res.videoLocal).toBeNull();
		} finally {
			h.restore();
		}
	});

	it("toggle ON: video downloads to video.mp4; an existing file is skipped", async () => {
		const { module, requests } = fakeHttps({
			"video-src": { status: 200, contentType: "video/mp4", body: Buffer.from("VVV") },
		});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: [],
					videoUrl: "https://cdn/video-src.mp4",
					downloadVideos: true,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(requests).toHaveLength(1);
			expect(res.videoLocal).toBe("RedNote/Media/note1/video.mp4");
			expect(res.downloaded).toBe(1);
			expect(Buffer.from(adapter.files.get("RedNote/Media/note1/video.mp4")!).toString()).toBe("VVV");

			// Second run over the same note: file exists -> skipped.
			const res2 = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: [],
					videoUrl: "https://cdn/video-src.mp4",
					downloadVideos: true,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(requests).toHaveLength(1); // no new fetch
			expect(res2.videoLocal).toBe("RedNote/Media/note1/video.mp4");
			expect(res2.skippedExisting).toBe(1);
		} finally {
			h.restore();
		}
	});

	it("reuses a seq-slot file stored under a REFINED extension without re-downloading (fix 4)", async () => {
		// Previous run stored image 2 as 2.jpg (Content-Type refinement); this
		// run's URL is extension-less (provisional inference would say .webp).
		// The dir listing must reuse 2.jpg — NO second request.
		const { module, requests } = fakeHttps({
			"img-a": { status: 200, contentType: "image/webp", body: Buffer.from("A") },
		});
		const h = stubRequire(module);
		try {
			const adapter = new MemoryAdapter();
			adapter.files.set("RedNote/Media/note1/2.jpg", new ArrayBuffer(3));
			const res = await syncNoteMedia(
				{
					mediaFolder: "RedNote/Media",
					noteId: "note1",
					imageUrls: ["https://cdn/img-a.webp", "https://cdn/img-b"],
					videoUrl: "",
					downloadVideos: false,
				},
				asAdapter(adapter),
				noopLog,
			);
			expect(requests).toHaveLength(1); // only image 1; image 2 reused
			expect(res.imageLocal[0]).toBe("RedNote/Media/note1/1.webp");
			expect(res.imageLocal[1]).toBe("RedNote/Media/note1/2.jpg");
			expect(res.skippedExisting).toBe(1);
			expect(res.downloaded).toBe(1);
		} finally {
			h.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// httpsGet settle discipline (M3 review fix 3): the promise must settle
// exactly once even when the transport emits nothing further after a
// mid-body destroy. All fakes below use a destroy() that fires NO events —
// pre-fix these scenarios hung the promise (and the whole sync) forever.
// ---------------------------------------------------------------------------

interface DeadStreamReq extends EventEmitter {
	write: () => void;
	end: () => void;
	destroy: () => void;
}

/** res emits `chunk` then NOTHING (no end/error/close); destroy is a no-op. */
function overflowSilentHttps(chunk: Buffer): unknown {
	return {
		request: (
			opts: { hostname: string; path: string },
			cb: (res: EventEmitter & { statusCode: number; headers: Record<string, never> }) => void,
		) => {
			const req = new EventEmitter() as DeadStreamReq;
			req.write = () => {};
			req.end = () => {
				const res = new EventEmitter() as EventEmitter & {
					statusCode: number;
					headers: Record<string, never>;
				};
				res.statusCode = 200;
				res.headers = {};
				process.nextTick(() => {
					cb(res);
					res.emit("data", chunk);
				});
			};
			req.destroy = () => {}; // fires nothing
			return req;
		},
	};
}

/** res emits a small chunk then ONLY "close" (socket dies without end/error). */
function closeWithoutEndHttps(): unknown {
	return {
		request: (
			opts: { hostname: string; path: string },
			cb: (res: EventEmitter & { statusCode: number; headers: Record<string, never> }) => void,
		) => {
			const req = new EventEmitter() as DeadStreamReq;
			req.write = () => {};
			req.end = () => {
				const res = new EventEmitter() as EventEmitter & {
					statusCode: number;
					headers: Record<string, never>;
				};
				res.statusCode = 200;
				res.headers = {};
				process.nextTick(() => {
					cb(res);
					res.emit("data", Buffer.from("abc"));
					res.emit("close"); // dead socket, no end, no error
				});
			};
			req.destroy = () => {}; // fires nothing
			return req;
		},
	};
}

describe("httpsGet settle discipline (fix 3)", () => {
	it("settles with the overflow error even when destroy() emits nothing", async () => {
		const h = stubRequire(overflowSilentHttps(Buffer.alloc(16, 1)));
		try {
			const r = await httpsGet("https://cdn/big", 1000, 8);
			expect(r.ok).toBe(false);
			expect(r.error).toContain("上限");
			expect(r.via).toBe("https");
		} finally {
			h.restore();
		}
	});

	it("settles via the close fallback when the stream dies without end/error", async () => {
		const h = stubRequire(closeWithoutEndHttps());
		try {
			const r = await httpsGet("https://cdn/dying", 1000);
			expect(r.ok).toBe(false);
			expect(r.error).toBe("连接提前关闭");
		} finally {
			h.restore();
		}
	});

	it("a normal body under the limit still resolves ok (guard does not swallow success)", async () => {
		const { module } = fakeHttps({
			ok: { status: 200, contentType: "image/webp", body: Buffer.from("tiny") },
		});
		const h = stubRequire(module);
		try {
			const r = await httpsGet("https://cdn/ok.webp", 1000, 1024);
			expect(r.ok).toBe(true);
			expect(r.data?.toString()).toBe("tiny");
		} finally {
			h.restore();
		}
	});
});
