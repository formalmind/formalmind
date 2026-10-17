/**
 * The proofs repository laid out as a GitHub-style project: every issue and pull request with a
 * Status derived from its `fm:` labels, plus the README's numbered Roadmap as milestones.
 */
import { CHIEF_ISSUE, LEDGER_ISSUE, NOTEBOOK_ISSUE, SWARM_REPO, github, type SwarmItem } from "@/lib/swarm";

import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/project-statuses";

export { PROJECT_STATUSES, type ProjectStatus };

export interface ProjectItem extends SwarmItem {
	state: "open" | "closed" | "merged";
	status: ProjectStatus;
	closedAt: string | null;
	/** README roadmap item this work belongs to, when its title or body names one. */
	milestone: number | null;
}

export interface ProjectMilestone {
	number: number;
	title: string;
	done: boolean;
	summary: string;
}

export interface ProjectData {
	repo: string;
	fetchedAt: string;
	items: ProjectItem[];
	milestones: ProjectMilestone[];
}

type GitHubIssue = {
	number: number;
	title: string;
	html_url: string;
	state: "open" | "closed";
	state_reason?: string | null;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	body: string | null;
	comments: number;
	user: { login: string; avatar_url: string } | null;
	labels: { name: string }[];
	pull_request?: { merged_at: string | null };
};

/** The swarm's own bookkeeping issues are not work items. */
const PINNED = new Set([LEDGER_ISSUE, NOTEBOOK_ISSUE, CHIEF_ISSUE]);
const CACHE_MS = 10_000;

function statusOf(issue: GitHubIssue, labels: string[]): ProjectStatus {
	if (issue.state === "closed") return "done";
	const has = (l: string) => labels.includes(l);
	if (has("fm:blocked")) return "blocked";
	if (has("fm:approved")) return "approved";
	if (has("fm:in-progress") || has("fm:changes") || has("fm:needs-rebase")) return "in-progress";
	if (issue.pull_request) return "review";
	return has("fm:todo") ? "todo" : "none";
}

function plain(body: string | null) {
	return (body ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#>*_`~]|\[(.*?)\]\(.*?\)/g, (match, text) => text ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function milestoneOf(issue: GitHubIssue) {
	const match = `${issue.title}\n${issue.body ?? ""}`.match(/roadmap item (\d+)/i);
	return match ? Number(match[1]) : null;
}

/** "1. ~~**v2 state machine**~~ — done (...)" lines under "## Roadmap". */
export function parseRoadmap(readme: string): ProjectMilestone[] {
	const section = readme.split(/^## Roadmap\s*$/m)[1]?.split(/^## /m)[0] ?? "";
	const entries = section.split(/^(?=\d+\. )/m).filter((entry) => /^\d+\. /.test(entry));
	return entries.map((entry) => {
		const number = Number(entry.match(/^(\d+)\./)?.[1]);
		const title = entry.match(/\*\*(.+?)\*\*/)?.[1] ?? `Item ${number}`;
		const done = /^\d+\. ~~/.test(entry) || /—\s*done\b/.test(entry);
		const summary = plain(entry.replace(/^\d+\.\s*/, "").replace(/~~\*\*.+?\*\*~~|\*\*.+?\*\*/, "")).replace(/^\(.*?\)\s*/, "").replace(/^[—-]\s*/, "");
		return { number, title, done, summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary };
	});
}

function toItem(issue: GitHubIssue): ProjectItem {
	const labels = issue.labels.map((label) => label.name);
	const merged = Boolean(issue.pull_request?.merged_at);
	const text = plain(issue.body);
	return {
		number: issue.number,
		title: issue.title,
		kind: issue.pull_request ? "pr" : "issue",
		labels,
		url: issue.html_url,
		updatedAt: issue.updated_at,
		createdAt: issue.created_at,
		author: issue.user?.login ?? "ghost",
		authorAvatar: issue.user?.avatar_url ?? "",
		excerpt: text.length > 240 ? `${text.slice(0, 239)}…` : text,
		comments: issue.comments,
		merged,
		state: merged ? "merged" : issue.state,
		status: statusOf(issue, labels),
		closedAt: issue.pull_request?.merged_at ?? issue.closed_at,
		milestone: milestoneOf(issue),
	};
}

/** Every issue and PR, newest first; at most five pages. */
async function allIssues() {
	const pages: GitHubIssue[][] = [];
	for (let page = 1; page <= 5; page++) {
		const batch = await github<GitHubIssue[]>(`/issues?state=all&per_page=100&page=${page}`);
		pages.push(batch);
		if (batch.length < 100) break;
	}
	return pages;
}

async function loadProject(): Promise<ProjectData> {
	const [pages, readme] = await Promise.all([allIssues(), github<{ content: string }>("/contents/README.md?ref=dev")]);
	const text = new TextDecoder().decode(Uint8Array.from(atob(readme.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
	const items = pages.flat()
		.filter((issue) => !PINNED.has(issue.number))
		// Closed PRs that never merged and issues closed as not planned are noise on a board.
		.filter((issue) => issue.state === "open" || (issue.pull_request ? issue.pull_request.merged_at : issue.state_reason !== "not_planned"))
		.map(toItem);
	return { repo: SWARM_REPO, fetchedAt: new Date().toISOString(), items, milestones: parseRoadmap(text) };
}

let cached: { at: number; data: Promise<ProjectData> } | null = null;

export function getProject(): Promise<ProjectData> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
	const data = loadProject();
	cached = { at: Date.now(), data };
	data.catch(() => { cached = null; });
	return data;
}
