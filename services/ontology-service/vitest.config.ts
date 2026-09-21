import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Node, not jsdom: this is a server, and every unit under test is either
		// a pure function or one that talks to Postgres.
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
