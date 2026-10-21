/**
 * A folder's entry points for Proofs: the contracts it models first (the first one opens by default), relative to the
 * folder. Set in Settings, or by picking a contract on the Proofs page. Kept in this browser / app.
 */
const keyOf = (folder: string) => `fm:entry-points:${folder}`;

export function readEntryPoints(folder: string): string[] {
	try {
		const saved = JSON.parse(localStorage.getItem(keyOf(folder)) ?? "[]");
		return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

export function saveEntryPoints(folder: string, list: string[]): string[] {
	const clean = [...new Set(list.map((p) => p.trim().replace(/^\.?\/+/, "")).filter(Boolean))];
	try {
		localStorage.setItem(keyOf(folder), JSON.stringify(clean));
	} catch {
		/* not kept */
	}
	return clean;
}

/** Makes `path` the main entry point (first), keeping the others. */
export function setMainEntryPoint(folder: string, path: string): string[] {
	return saveEntryPoints(folder, [path, ...readEntryPoints(folder).filter((p) => p !== path)]);
}
