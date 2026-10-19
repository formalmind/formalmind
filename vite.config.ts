import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
	// Shared modules read process.env on the Worker; in the browser there is none.
	define: {
		"process.env": "{}",
		__APP_VERSION__: JSON.stringify(""),
		__COMMIT__: JSON.stringify(execSync("git rev-parse --short HEAD").toString().trim()),
	},
	server: {
		port: 3000,
		// `wrangler dev` serves the API and auth on 8787 during development.
		proxy: { "/api": "http://localhost:8787", "/auth": "http://localhost:8787" },
	},
	build: { outDir: "dist", sourcemap: true },
});
