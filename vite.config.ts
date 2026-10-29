import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: { alias: [{ find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) }] },
	// Shared modules read process.env on the Worker; in the browser there is none.
	define: {
		"process.env": "{}",
		// One version for the product: the desktop app's, which the web shows too.
		__APP_VERSION__: JSON.stringify((JSON.parse(readFileSync(new URL("./desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version: string }).version),
		__COMMIT__: JSON.stringify(execSync("git rev-parse --short HEAD").toString().trim()),
	},
	server: {
		port: 3000,
		// `wrangler dev` serves the API and auth on 8787 during development.
		proxy: { "/api": "http://localhost:8787", "/auth": "http://localhost:8787" },
	},
	build: { outDir: "dist", sourcemap: true },
});
