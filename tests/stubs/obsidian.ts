// Minimal obsidian runtime stub for the vitest "obsidian" alias
// (vitest.config.ts). sync.ts needs only the TFile constructor (for an
// `instanceof` check) and the Vault / TFolder type shapes at runtime; the
// type checking itself keeps using the real node_modules/obsidian d.ts.
// requestUrl is exported because api.ts imports it (unused at runtime, but
// the named binding must exist when the module graph loads under vitest).

export class TFile {}
export class TFolder {}
export class Vault {}

export function requestUrl(): never {
	throw new Error("requestUrl 不得在单元测试中被调用");
}
