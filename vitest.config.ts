import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	// M3.2: sync.ts imports obsidian at runtime (TFile instanceof + Vault /
	// TFolder types), so "obsidian" is aliased to a minimal stub and the sync
	// pipeline is unit-testable in node. Pure modules never import obsidian,
	// so the alias only affects the sync tests; api/login remain untested
	// here (they additionally need electron/webview internals).
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		// Pure-function unit tests, plus the sync pipeline tests (sync.ts via
		// the obsidian stub above). The api/login side-effect modules are
		// intentionally not unit-tested here.
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
