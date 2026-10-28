import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where `@formalmind/ui/*` resolves, for Vite: the private UI package (packages/ui, a submodule of the private
 * formalmind/affectui repository) when it is checked out, else the app's own fallbacks in desktop/src/ui-fallback.
 * tsconfig's `paths` list the same two places in the same order.
 */
export const uiPackage = {
	find: /^@formalmind\/ui\/(.*)$/,
	replacement: existsSync(`${repo}packages/ui/package.json`) ? `${repo}packages/ui/formalmind/$1` : `${repo}desktop/src/ui-fallback/$1`,
};
