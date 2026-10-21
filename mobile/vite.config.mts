import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** The iPhone app's webview bundle: the web app's components through the same `@/` alias, its own entry in mobile/src. */
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react()],
	// Its own pre-bundled deps: sharing node_modules/.vite with the Mac app's dev server, each invalidates the other's.
	cacheDir: fileURLToPath(new URL("../node_modules/.vite-mobile", import.meta.url)),
	resolve: { alias: { "@": repo } },
	define: {
		"process.env": "{}",
		__APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("src-tauri/tauri.conf.json", import.meta.url), "utf8")).version),
		__COMMIT__: JSON.stringify(execSync("git rev-parse --short HEAD").toString().trim()),
	},
	// Tauri expects a fixed port; the simulator reaches it on localhost. A device needs TAURI_DEV_HOST (tauri sets it).
	server: { port: 1421, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
	clearScreen: false,
	envPrefix: ["VITE_", "TAURI_ENV_"],
	worker: { format: "es" },
	build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
});
