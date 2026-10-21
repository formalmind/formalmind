/**
 * The localhost demo's data from a real repository, when it's been built (`bun scripts/demo-data.ts`). It isn't
 * committed: without it the demo uses its sample folder.
 */
export type DemoAudit = Record<string, unknown> & { slices?: Record<string, string> };
export type DemoData = { name: string; path: string; files: string[]; sources: Record<string, string>; images?: Record<string, string>; audits: Record<string, DemoAudit>; formals?: Record<string, unknown>; scripts?: unknown };

const found = import.meta.glob<{ repos?: DemoData[] } & Partial<DemoData>>("./data.json", { import: "default" });
let loading: Promise<DemoData[]> | null = null;

/** Every repo in the demo data (`{ repos }`, or one repo as older builds wrote it). */
export function loadDemoRepos(): Promise<DemoData[]> {
	loading ??= found["./data.json"]
		? found["./data.json"]()
				.then((d) => (Array.isArray(d.repos) ? d.repos : d.path ? [d as DemoData] : []))
				.catch(() => [])
		: Promise.resolve([]);
	return loading;
}

/** One demo repo by name (the `repo` URL parameter), else the first. */
export function loadDemoData(name?: string | null): Promise<DemoData | null> {
	return loadDemoRepos().then((repos) => repos.find((r) => r.name === name) ?? repos[0] ?? null);
}
