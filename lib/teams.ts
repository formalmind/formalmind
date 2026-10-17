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
