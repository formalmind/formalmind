/**
 * The standard audit format, `formalmind.audit/v1` (docs/audit-format.md): one JSON file per report, next to it as
 * `<name>.audit.json`. External reports (PDF or Markdown) are turned into it by the swarm's auditor; Formal Mind's own
 * internal audits are written in it; the Bugs page reads only this (plus legacy README index tables).
 */
export type AuditSeverity = "critical" | "high" | "medium" | "low" | "informational" | "gas";
export type AuditStatus = "open" | "fixed" | "acknowledged" | "works as expected" | "rejected";

export type AuditLocation = { file: string; line?: number };

export type AuditFindingDoc = {
	id: string;
	title: string;
	severity: AuditSeverity | string;
	/** Where it stands in the current code. */
	status: AuditStatus;
	/** What the report itself said, e.g. "Fixed in PR #123". */
	reportStatus?: string;
	locations?: AuditLocation[];
	description: string;
	impact?: string;
	recommendation?: string;
	/** The team's response in the report. */
	response?: string;
	/** Why this status: what changed and the test that covers it. */
	evidence?: string;
	tests?: string[];
	poc?: string;
	/** The fix: its commit and pull request (`url` links whichever is known). */
	fix?: { commit?: string; pr?: number; url?: string };
	page?: number;
};

/** A function's standing in the Lean model, as the Proofs page shows it. */
export type AuditCoverageRow = { function: string; status: "proved" | "sorry" | "modeled" | "not modeled"; theorems: string[]; why?: string };

/** One contract's Proofs coverage (an internal audit's formal verification). */
export type AuditCoverage = { contract: string; functions: number; inLean: number; proved: number; notModeled: number; theorems: number; sorry?: number; rows?: AuditCoverageRow[] };

/** A property proved about the code (an internal audit's reviewed proofs). */
export type AuditProperty = {
	id: string;
	title: string;
	status: "verified" | "sorry" | "unproved";
	locations?: AuditLocation[];
	/** What was proved (Markdown). */
	description: string;
	/** The theorems that prove it, each where it is. */
	theorems?: { name: string; file?: string; line?: number; sorry?: boolean }[];
	/** The proof files, repository paths. */
	files?: string[];
};

/** A difference the rebuild cycle's editor found between the code and the rebuild from the proofs. */
export type AuditDifference = {
	id: string;
	cycle: number;
	contract: string;
	/** gap: the code does what the spec doesn't state; improvement: the rebuild is simpler or safer; divergence: neither is clearly right; bug: a theorem or invariant breaks. */
	class: "gap" | "improvement" | "divergence" | "bug";
	/** asked: a question with the maintainer; fixing: sent to the rebuilder. */
	status: "open" | "asked" | "fixing" | "decided" | "closed";
	title: string;
	description: string;
	draft?: AuditLocation[];
	rebuild?: AuditLocation[];
	/** A gap: the theorem the spec is missing; otherwise the Lean it bears on. */
	theorem?: string;
	/** What the rebuild should do, citing the Lean. */
	fix?: string;
	question?: string;
	recommendation?: string;
	decision?: string;
	/** A bug in the code: the finding's id in this file. */
	finding?: string;
};

/** The rebuild cycle: the contracts rebuilt from the proofs alone (under rebuild/) and how they compare with the code. */
export type AuditRebuild = {
	cycle: number;
	phase: "rebuild" | "compare" | "polish" | "close" | "rest";
	contracts?: { contract: string; draft: string; rebuild: string[]; state: "queued" | "rebuilt" | "polish" | "agreed" | "compared" | "blocked" }[];
	tests?: string[];
	/** What the proofs did not determine, in the rebuilder's words. */
	undetermined?: string[];
	summary?: string;
	confidence?: "low" | "medium" | "high";
	differences: AuditDifference[];
};

export type AuditDoc = {
	schema: "formalmind.audit/v1";
	kind: "external" | "internal";
	title: string;
	auditor?: string;
	authors?: string[];
	date?: string;
	commit?: string;
	repository?: string;
	scope?: string[];
	summary?: string;
	/** The report it was read from, folder-relative (absent for an internal audit written directly). */
	source?: string;
	findings: AuditFindingDoc[];
	/** Internal audits: the Proofs coverage per contract in scope. */
	coverage?: AuditCoverage[];
	/** Internal audits: the properties proved and reviewed. */
	properties?: AuditProperty[];
	/** Internal audits: the rebuild cycle. */
	rebuild?: AuditRebuild;
};

/** `docs/audits/Spearbit.pdf` → `docs/audits/Spearbit.audit.json`. */
export const auditJsonPath = (report: string) => report.replace(/\.[^./]+$/, "") + ".audit.json";

export function parseAuditDoc(text: string): AuditDoc | null {
	try {
		const doc = JSON.parse(text) as AuditDoc;
		return doc?.schema === "formalmind.audit/v1" && Array.isArray(doc.findings) ? doc : null;
	} catch {
		return null;
	}
}
