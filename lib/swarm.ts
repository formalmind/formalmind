/**
 * Live state of the formalmind swarm, read from the proofs repository on GitHub.
 * The swarm keeps all of its memory in issues, labels and comments (see
 * `asyncswap/v2-proofs/.github/formalmind/README.md`), so this is everything it knows.
 */

export const SWARM_REPO = process.env.SWARM_REPO || "asyncswap/v2-proofs";
const LEDGER_ISSUE = 38;
const CHIEF_ISSUE = 53;
const NOTEBOOK_ISSUE = 55;

export type SwarmRole = "dispatcher" | "planner" | "prover" | "reviewer" | "merger" | "chief";

export interface SwarmItem {
	number: number;
	title: string;
	kind: "issue" | "pr";
	labels: string[];
	url: string;
	updatedAt: string;
}

export interface SwarmComment {
	body: string;
	createdAt: string;
	url: string;
}

export interface SwarmCost {
	role: string;
	ref: string;
	usd: number;
	createdAt: string;
}

export interface SwarmState {
	repo: string;
	fetchedAt: string;
	/** Open issues and PRs carrying an `fm:` label. */
	work: SwarmItem[];
	/** PRs merged most recently. */
	merged: SwarmItem[];
	costs: SwarmCost[];
	spentToday: number;
	chief: SwarmComment | null;
	notebook: SwarmComment[];
	ledger: SwarmComment[];
}

type GitHubIssue = {
	number: number;
	title: string;
	html_url: string;
	updated_at: string;
	labels: { name: string }[];
	pull_request?: { merged_at: string | null };
};

type GitHubComment = { body: string; created_at: string; html_url: string };

async function github<T>(path: string): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${SWARM_REPO}${path}`, { headers, next: { revalidate: 60 } });
	if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${res.statusText}`);
	return res.json() as Promise<T>;
}

function toItem(issue: GitHubIssue): SwarmItem {
	return {
		number: issue.number,
		title: issue.title,
		kind: issue.pull_request ? "pr" : "issue",
		labels: issue.labels.map((label) => label.name),
		url: issue.html_url,
		updatedAt: issue.updated_at,
	};
}

function toComment(comment: GitHubComment): SwarmComment {
	return { body: comment.body, createdAt: comment.created_at, url: comment.html_url };
}

/** Last page of an issue's comments, newest last. */
async function latestComments(issue: number, count: number): Promise<SwarmComment[]> {
	const meta = await github<{ comments: number }>(`/issues/${issue}`);
	const page = Math.max(1, Math.ceil(meta.comments / 100));
	const comments = await github<GitHubComment[]>(`/issues/${issue}/comments?per_page=100&page=${page}`);
	return comments.slice(-count).map(toComment);
}

const COST_MARKER = /<!-- fm-cost role=(\S+) ref=(\S+) usd=([\d.]+)/;

export async function getSwarmState(): Promise<SwarmState> {
	const [open, closed, ledger, notebook, chief] = await Promise.all([
		github<GitHubIssue[]>("/issues?state=open&per_page=100"),
		github<GitHubIssue[]>("/issues?state=closed&per_page=20&sort=updated"),
		latestComments(LEDGER_ISSUE, 30),
		latestComments(NOTEBOOK_ISSUE, 6),
		latestComments(CHIEF_ISSUE, 1),
	]);

	const costs = ledger.flatMap((comment) => {
		const match = comment.body.match(COST_MARKER);
		return match ? [{ role: match[1], ref: match[2], usd: Number(match[3]), createdAt: comment.createdAt }] : [];
	});
	const today = new Date().toISOString().slice(0, 10);

	return {
		repo: SWARM_REPO,
		fetchedAt: new Date().toISOString(),
		work: open.filter((issue) => issue.labels.some((label) => label.name.startsWith("fm:"))).map(toItem),
		merged: closed.filter((issue) => issue.pull_request?.merged_at).slice(0, 5).map(toItem),
		costs,
		spentToday: costs.filter((cost) => cost.createdAt.startsWith(today)).reduce((sum, cost) => sum + cost.usd, 0),
		chief: chief[0] ?? null,
		notebook,
		ledger: ledger.filter((comment) => !COST_MARKER.test(comment.body)).slice(-5),
	};
}
