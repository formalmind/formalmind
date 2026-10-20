/**
 * The localhost demo's data from a real repository, when it's been built (`bun scripts/demo-data.ts`). It isn't
 * committed: without it the demo uses its sample folder.
 */
export type DemoAudit = Record<string, unknown> & { slices?: Record<string, string> };
export type DemoData = { name: string; path: string; files: string[]; sources: Record<string, string>; images?: Record<string, string>; audits: Record<string, DemoAudit>; formals?: Record<string, unknown> };

const found = import.meta.glob<DemoData>("./data.json", { import: "default" });
let loading: Promise<DemoData | null> | null = null;

export function loadDemoData(): Promise<DemoData | null> {
	loading ??= found["./data.json"] ? found["./data.json"]().catch(() => null) : Promise.resolve(null);
	return loading;
}
