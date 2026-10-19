/**
 * Team presets: how many agents work at once and how the roles are split between them.
 * The protocol (labels, turns, /ask, the ledger) addresses roles, never agents, so it works
 * the same for every preset. The planner and the chief are on call in all of them: pulled in
 * at the start, when the queue runs dry, on "/ask planner", and for the daily report.
 */
export type TeamPreset = "solo" | "pair" | "trio" | "squad";

export const TEAM_PRESETS: { key: TeamPreset; name: string; agents: string; split: string; bestFor: string }[] = [
	{ key: "solo", name: "Solo", agents: "1 agent", split: "One agent proves, then reviews its own PR in a fresh session before merging.", bestFor: "Small contracts, lowest cost" },
	{ key: "pair", name: "Pair", agents: "2 agents", split: "Two peers who both write and both review, never their own PR.", bestFor: "Most protocols" },
	{ key: "trio", name: "Trio", agents: "3 agents", split: "The pair, plus a verifier who owns the clean-build gate and merging.", bestFor: "Audit-grade work" },
	{ key: "squad", name: "Squad", agents: "4 to 7 agents", split: "Pairs on disjoint issues and one verifier. Faster; past four, conflicts and review queues grow.", bestFor: "Large protocols, deadlines" },
];

export const DEFAULT_TEAM: TeamPreset = "pair";

/**
 * What a project is for. An audit freezes a commit, starts every agent at once and ends with one
 * report (findings, POCs, fixes, proofs); specs keep the proofs growing with the code, within a daily budget.
 */
export type SwarmMode = "audit" | "specs";

export const SWARM_MODES: { key: SwarmMode; name: string; lead: string; ends: string }[] = [
	{ key: "audit", name: "Audit this code", lead: "Every agent starts at once on the commit you pick. Invariants are proved in Lean 4 or turned into findings with a Foundry POC and a fix.", ends: "Ends with one report you can submit" },
	{ key: "specs", name: "Build formal specs", lead: "The swarm writes the Lean 4 spec and proofs one small PR at a time, and keeps them in step with your code.", ends: "Runs every day within your budget" },
];

export const DEFAULT_MODE: SwarmMode = "specs";

/** The audit report's path: audit/FM_AUDIT_<MM>_<YYYY>.md, for the month the audit started. */
export const auditReportName = (at = new Date()) => `audit/FM_AUDIT_${String(at.getUTCMonth() + 1).padStart(2, "0")}_${at.getUTCFullYear()}.md`;
