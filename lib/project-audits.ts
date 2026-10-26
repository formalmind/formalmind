import { parseAuditDoc, type AuditDoc, type AuditFindingDoc, type AuditLocation } from "@/lib/audit-format";
import type { ProjectRepo } from "@/lib/project-repo";

/**
 * A project's audits as the Bugs and Proofs tabs read them, server side: every `formalmind.audit/v1` file
 * (`<report>.audit.json`, docs/audit-format.md) in the report folders, the swarm's `.formal/bugs/` and its plan's
 * progress in `.formal/plan.md` when those are committed. Shaped for agents: counts and short rows first, the whole
 * finding only when asked for.
 */

/** The report folders the Bugs tab looks in when a project sets none (lib/report-dirs.ts, which is browser-side). */
export const REPORT_DIRS = ["audit", "audits", "reports"];
/** Report files that are not yet in the standard format (the swarm's auditor turns them into one). */
const REPORT_EXT = /\.(pdf|md|adoc)$/i;

const under = (path: string, dirs: string[]) => dirs.some((d) => path === d || path.startsWith(`${d.replace(/\/+$/, "")}/`));
const countBy = <T>(items: T[], key: (item: T) => string) =>
	items.reduce<Record<string, number>>((acc, item) => ((acc[key(item)] = (acc[key(item)] ?? 0) + 1), acc), {});
export const where = (locations: AuditLocation[] = []) => locations.map((l) => (l.line ? `${l.file}:${l.line}` : l.file));

export type ProjectAudits = {
	reports: { path: string; doc: AuditDoc }[];
	/** `.audit.json` files that did not parse as formalmind.audit/v1. */
	invalid: string[];
	/** Report files in the folders with no `.audit.json` beside them. */
	unconverted: string[];
	swarmBugs: string[];
	files: string[];
	truncated: boolean;
};

export async function readAudits(project: ProjectRepo, dirs: string[] = REPORT_DIRS): Promise<ProjectAudits> {
	const { files, truncated } = await project.tree();
	const jsonPaths = files.filter((f) => f.endsWith(".audit.json") && under(f, dirs));
	const docs = await Promise.all(jsonPaths.map(async (path) => ({ path, doc: parseAuditDoc((await project.file(path)) ?? "") })));
	const converted = new Set(jsonPaths.map((p) => p.replace(/\.audit\.json$/, "")));
	return {
		reports: docs.filter((d): d is { path: string; doc: AuditDoc } => d.doc !== null),
		invalid: docs.filter((d) => !d.doc).map((d) => d.path),
		unconverted: files.filter((f) => under(f, dirs) && REPORT_EXT.test(f) && !/readme\.md$/i.test(f) && !converted.has(f.replace(REPORT_EXT, ""))),
		swarmBugs: files.filter((f) => f.startsWith(".formal/bugs/") && f.endsWith(".md")),
		files,
		truncated,
	};
}

/** One report in a line: its facts and what is in it, without the findings themselves. */
export function reportSummary(path: string, doc: AuditDoc) {
	const coverage = doc.coverage ?? [];
	return {
		path,
		kind: doc.kind,
		title: doc.title,
		auditor: doc.auditor,
		date: doc.date,
		commit: doc.commit,
		source: doc.source,
		findings: doc.findings.length,
		bySeverity: countBy(doc.findings, (f) => String(f.severity).toLowerCase()),
		byStatus: countBy(doc.findings, (f) => f.status),
		...(coverage.length
			? {
					coverage: {
						contracts: coverage.length,
						functions: coverage.reduce((s, c) => s + c.functions, 0),
						proved: coverage.reduce((s, c) => s + c.proved, 0),
						inLean: coverage.reduce((s, c) => s + c.inLean, 0),
					},
				}
			: {}),
		...(doc.properties?.length ? { properties: doc.properties.length } : {}),
	};
}

/** A finding as a row: enough to pick which one to read. */
export const findingRow = (report: string, f: AuditFindingDoc) => ({ report, id: f.id, title: f.title, severity: f.severity, status: f.status, at: where(f.locations) });

/** `- [x]` proved and reviewed, `- [ ]` to do, `- [!]` failed or a bug filed: the swarm's plan, counted. */
export function planProgress(plan: string) {
	const items = [...plan.matchAll(/^\s*- \[([ x!])\]\s+(.*)$/gm)];
	const state = { done: 0, todo: 0, stuck: 0 };
	const stuck: string[] = [];
	for (const [, mark, line] of items) {
		if (mark === "x") state.done++;
		else if (mark === "!") {
			state.stuck++;
			stuck.push(line.slice(0, 200));
		} else state.todo++;
	}
	return { items: items.length, ...state, stuckItems: stuck.slice(0, 50) };
}
