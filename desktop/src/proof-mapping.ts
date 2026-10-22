import type { Formal } from "./swarm-panel";
/** Preserve formal-ast's theorem indices; no matching by basename or guessed namespace. */
export function mappedSources(data: Formal, theorem: number) {
	if (!Number.isInteger(theorem) || !data.theorems[theorem]) return [];
	return data.functions.filter(fn => fn.file && fn.theorems.includes(theorem));
}
