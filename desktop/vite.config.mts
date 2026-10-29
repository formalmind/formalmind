import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { uiPackage } from "../lib/ui-package";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** AffectUI's own files import each other as `@/components/ui/<name>`: inside packages/ui that is its components
 * folder (or its screens, blocks, illustrations and motion), not the app's. */
const affectui: Plugin = {
	name: "affectui-paths",
	enforce: "pre",
	resolveId(id, importer) {
		// Vite's `@` alias may already have turned it into <repo>/components/ui/<name>.
		const m = /^(?:@|.*\/)\/?components\/ui\/([^/]+)$/.exec(id);
		if (!m || !importer?.includes("/packages/ui/")) return null;
		const file = ["components", "screens", "blocks", "illustrations", "motion"].map((d) => `${repo}packages/ui/${d}/${m[1]}.tsx`).find((f) => existsSync(f));
		return file ?? null;
	},
};

/** The desktop app's webview bundle: the web app's components through the same `@/` alias, its own entry in desktop/src. */
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [affectui, react()],
	resolve: { alias: [uiPackage, { find: "@", replacement: repo }] },
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
