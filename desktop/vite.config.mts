import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** The desktop app's webview bundle: the web app's components through the same `@/` alias, its own entry in desktop/src. */
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react()],
	resolve: { alias: { "@": repo } },
	define: {
		"process.env": "{}",
		__APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("src-tauri/tauri.conf.json", import.meta.url), "utf8")).version),
		__COMMIT__: JSON.stringify(execSync("git rev-parse --short HEAD").toString().trim()),
	},
	// Tauri expects a fixed port and loads the build from desktop/dist.
	server: { port: 1420, strictPort: true },
	clearScreen: false,
	envPrefix: ["VITE_", "TAURI_ENV_"],
	build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
});
