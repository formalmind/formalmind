import { fileURLToPath } from "node:url";

/** Tailwind with the phone's config (mobile/tailwind.config.ts), which reuses the web app's theme. */
export default {
	plugins: { tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.ts", import.meta.url)) } },
};
