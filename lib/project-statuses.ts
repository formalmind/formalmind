/** The board's columns, shared by the Worker (which sorts items into them) and the browser. */
export type ProjectStatus = "none" | "todo" | "in-progress" | "review" | "approved" | "blocked" | "done";

export const PROJECT_STATUSES: { key: ProjectStatus; name: string; description: string }[] = [
	{ key: "none", name: "No Status", description: "Open issues the swarm has not been asked to pick up" },
	{ key: "todo", name: "Todo", description: "Queued with fm:todo for a prover" },
	{ key: "in-progress", name: "In progress", description: "A prover is on it, or it went back for changes" },
	{ key: "review", name: "In review", description: "Open PRs waiting for the reviewer" },
	{ key: "approved", name: "Approved", description: "Reviewed; the merger checks and merges" },
	{ key: "blocked", name: "Blocked", description: "Waiting on a human decision" },
	{ key: "done", name: "Done", description: "Merged or closed as completed" },
];
