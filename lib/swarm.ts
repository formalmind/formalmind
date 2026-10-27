/**
 * The swarm's shapes: its roles, items, notes and costs, as the Swarm canvas and the desktop app's local board draw
 * them, and a GitHub REST helper for issue and pull-request hover cards.
 */

export type SwarmRole = "dispatcher" | "planner" | "prover" | "rebuilder" | "reviewer" | "merger" | "editor" | "chief" | "assistant";

/** Where the rebuild cycle stands, from the editor's `<!-- fm-cycle n=<k> phase=<phase> -->` ledger marker. */
export interface SwarmCycle {
	n: number;
	phase: string;
	createdAt: string;
}

export interface SwarmItem {
	/** The proofs repository the issue or PR is in. */
	repo: string;
	number: number;
	title: string;
	kind: "issue" | "pr";
	labels: string[];
	url: string;
	updatedAt: string;
	createdAt: string;
	author: string;
	authorAvatar: string;
	/** First paragraph or so of the body, markdown stripped down to plain text. */
	excerpt: string;
	comments: number;
	merged: boolean;
	/** Set when closed items are included; the swarm's live queue only holds open ones. */
	state?: "open" | "closed" | "merged";
}

export interface SwarmComment {
	body: string;
	createdAt: string;
	url: string;
}

export interface SwarmCost {
	/** The proofs repository the run worked in. */
	repo: string;
	role: string;
	ref: string;
	usd: number;
	runId: number | null;
	createdAt: string;
}

/** One run's notebook entry: a task list the role ticks off as it works. */
export interface SwarmHandoff {
	/** A role, a human's handle (with @), or "nobody". */
	to: string;
	why: string;
}

export interface SwarmNote {
	/** The proofs repository `ref` is in. */
	repo: string;
	role: SwarmRole;
	ref: number | null;
	runId: number;
	title: string;
	tasks: { text: string; done: boolean; dropped: boolean }[];
	verified: string | null;
	left: string | null;
	/** Who the run handed the turn to, from its "**Next:** <role> — <why>" line. */
	next: SwarmHandoff | null;
	createdAt: string;
	updatedAt: string;
	url: string;
}

export type SwarmRunPhase = "queued" | "dispatching" | "setting up" | "building" | "working" | "recording cost" | "done";

export interface SwarmRun {
	id: number;
	status: string;
	conclusion: string | null;
	phase: SwarmRunPhase;
	startedAt: string;
	updatedAt: string;
	url: string;
	/** Filled in once the run has opened its notebook entry. */
	note: SwarmNote | null;
	/** What the run cost, once it has written its ledger line. */
	usd: number | null;
}

/** A project on the swarm's board. */
export interface SwarmProject {
	/** The protocol repository: the sidebar's project. */
	repo: string;
	/** Where its proofs and fm: issues live; null until it has a proofs repository. */
	proofsRepo: string | null;
	/** Listed in the swarm's projects.json, so the dispatcher sweeps it. */
	inSwarm: boolean;
	/** Why its issues could not be read, when they could not. */
	error?: string;
}

export interface SwarmState {
	/** The swarm's home repository (ledger, notebook, chief, assistant, runs). */
	repo: string;
	fetchedAt: string;
	/** Every project on the board, in the swarm's order, then the account's others. */
	projects: SwarmProject[];
	/** Open issues and PRs carrying an `fm:` label, across every project. */
	work: SwarmItem[];
	/** Each project's most recently merged PRs. */
	merged: SwarmItem[];
	/** Every cost line in the ledger issue, oldest first. */
	costs: SwarmCost[];
	spentToday: number;
	/** The spending cap the ledger measures against; $5 a day when unset. */
	budgetUsd?: number;
	chief: SwarmComment | null;
	/** The assistant's latest comment on the maintainer's thread. */
	assistant: SwarmComment | null;
	/** The rebuild cycle, or null before the editor has run. */
	cycle: SwarmCycle | null;
	notebook: SwarmComment[];
	ledger: SwarmComment[];
	/** The latest swarm workflow runs, newest first. */
	runs: SwarmRun[];
	/** Agents working right now, in any project's proofs repository. */
	active: SwarmActive[];
}

/** An agent job running now: who, in which proofs repository, on which issue or PR, and how far along. */
export interface SwarmActive {
	repo: string;
	role: SwarmRole;
	ref: number | null;
	/** What the job does, when the role alone doesn't say it (the POC writer runs as the prover). */
	task: string | null;
	phase: SwarmRunPhase;
	startedAt: string;
	/** Finished in the last few minutes: the agent that just handed this item on (it carries the card it moved). */
	finished?: boolean;
}

export type GitHubIssue = {
	number: number;
	title: string;
	html_url: string;
	updated_at: string;
	created_at: string;
	body: string | null;
	comments: number;
	user: { login: string; avatar_url: string } | null;
	labels: { name: string }[];
	pull_request?: { merged_at: string | null };
};

function excerptOf(body: string | null) {
	const text = (body ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#>*_`]|\[(.*?)\]\(.*?\)/g, (match, linkText) => linkText ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/** A GitHub REST call on `repo`. */
export async function github<T>(path: string, repo: string): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		// GitHub refuses requests without a User-Agent, and Workers' fetch doesn't send one.
		"User-Agent": "formalmind",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers, cache: "no-store" });
	if (!res.ok) throw new Error(`GitHub ${repo}${path}: ${res.status} ${res.statusText}`);
	return res.json() as Promise<T>;
}

export function toItem(repo: string, issue: GitHubIssue): SwarmItem {
	return {
		repo,
		number: issue.number,
		title: issue.title,
		kind: issue.pull_request ? "pr" : "issue",
		labels: issue.labels.map((label) => label.name),
		url: issue.html_url,
		updatedAt: issue.updated_at,
		createdAt: issue.created_at,
		author: issue.user?.login ?? "ghost",
		authorAvatar: issue.user?.avatar_url ?? "",
		excerpt: excerptOf(issue.body),
		comments: issue.comments,
		merged: Boolean(issue.pull_request?.merged_at),
	};
}
