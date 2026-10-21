import { fileURLToPath } from "node:url";
import type { Config } from "tailwindcss";
import base from "../tailwind.config";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** The web app's theme, scanning the shared components, the desktop views the phone reuses, and the phone's entry. */
export default {
	...base,
	content: [`${repo}mobile/src/**/*.{ts,tsx}`, `${repo}desktop/src/**/*.{ts,tsx}`, `${repo}components/**/*.{ts,tsx}`, `${repo}src/**/*.{ts,tsx}`],
} satisfies Config;
