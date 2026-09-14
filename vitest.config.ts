import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Pure-function unit tests only. The side-effect modules (api/login/sync)
		// import obsidian and are intentionally not unit-tested here.
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
