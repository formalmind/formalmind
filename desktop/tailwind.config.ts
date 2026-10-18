import { fileURLToPath } from "node:url";
import type { Config } from "tailwindcss";
import base from "../tailwind.config";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** The web app's theme, scanning the shared components and the desktop entry. */
export default {
	...base,
	content: [`${repo}desktop/src/**/*.{ts,tsx}`, `${repo}components/**/*.{ts,tsx}`, `${repo}src/**/*.{ts,tsx}`],
} satisfies Config;
