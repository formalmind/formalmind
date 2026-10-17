/** The board's columns, shared by the Worker (which sorts items into them) and the browser. */
export type ProjectStatus = "none" | "todo" | "in-progress" | "review" | "approved" | "blocked" | "done";

export const PROJECT_STATUSES: { key: ProjectStatus; name: string; description: string }[] = [
	{ key: "none", name: "No Status", description: "Open issues the swarm has not been asked to pick up" },
	{ key: "todo", name: "Todo", description: "Queued for a prover (fm:todo) or the rebuilder (fm:rebuild), or a finding or intent to specify" },
	{ key: "in-progress", name: "In progress", description: "A prover or the rebuilder is on it, or it went back for changes" },
	{ key: "review", name: "In review", description: "Open PRs waiting for the reviewer" },
	{ key: "approved", name: "Approved", description: "Reviewed; the merger checks and merges" },
	{ key: "blocked", name: "Blocked", description: "Waiting on a decision the assistant has put to you" },
	{ key: "done", name: "Done", description: "Merged or closed as completed" },
];
