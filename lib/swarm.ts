/**
 * Live state of the formalmind swarm, read from the proofs repository on GitHub.
 * The swarm keeps all of its memory in issues, labels and comments (see
 * `asyncswap/v2-proofs/.github/formalmind/README.md`), so this is everything it knows.
 */

export const SWARM_REPO = process.env.SWARM_REPO || "asyncswap/v2-proofs";
const LEDGER_ISSUE = 38;
const CHIEF_ISSUE = 53;
const NOTEBOOK_ISSUE = 55;
const SWARM_WORKFLOW = "formalmind-swarm.yml";
/** Shared by every request in this server instance, so polling clients don't multiply GitHub calls. */
const CACHE_MS = 10_000;

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
	runId: number | null;
	createdAt: string;
}

/** One run's notebook entry: a task list the role ticks off as it works. */
export interface SwarmNote {
	role: SwarmRole;
	ref: number | null;
	runId: number;
	title: string;
	tasks: { text: string; done: boolean; dropped: boolean }[];
	verified: string | null;
	left: string | null;
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
	/** The latest swarm workflow runs, newest first. */
	runs: SwarmRun[];
}

type GitHubIssue = {
	number: number;
	title: string;
	html_url: string;
	updated_at: string;
	labels: { name: string }[];
	pull_request?: { merged_at: string | null };
};

type GitHubComment = { body: string; created_at: string; updated_at: string; html_url: string };

type GitHubRun = { id: number; status: string; conclusion: string | null; run_started_at: string; updated_at: string; html_url: string };

type GitHubJob = { name: string; status: string; steps?: { name: string; status: string }[] };

async function github<T>(path: string): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${SWARM_REPO}${path}`, { headers, cache: "no-store" });
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
async function latestRawComments(issue: number, count: number): Promise<GitHubComment[]> {
	const meta = await github<{ comments: number }>(`/issues/${issue}`);
	const page = Math.max(1, Math.ceil(meta.comments / 100));
	const comments = await github<GitHubComment[]>(`/issues/${issue}/comments?per_page=100&page=${page}`);
	return comments.slice(-count);
}

async function latestComments(issue: number, count: number): Promise<SwarmComment[]> {
	return (await latestRawComments(issue, count)).map(toComment);
}

const NOTE_MARKER = /<!-- fm-note role=(\S+) ref=#?(\S+) run=(\d+) -->/;
const ROLE_NAMES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", review: "reviewer", merge: "merger", chief: "chief" };

function parseNote(comment: GitHubComment): SwarmNote | null {
	const marker = comment.body.match(NOTE_MARKER);
	const role = marker && ROLE_NAMES[marker[1]];
	if (!marker || !role) return null;
	const lines = comment.body.split("\n");
	const field = (name: string) => lines.find((l) => l.startsWith(`**${name}:**`))?.slice(name.length + 5).trim() || null;
	return {
		role,
		ref: Number(marker[2]) || null,
		runId: Number(marker[3]),
		title: (lines.find((l) => l.startsWith("**")) ?? "").replace(/^\*\*\w+\*\*\s*(#\d+\s*)?[—-]?\s*/, ""),
		tasks: lines.flatMap((l) => {
			const task = l.match(/^\s*- \[( |x)\] (.*)$/);
			if (!task) return [];
			const dropped = task[2].includes("~~");
			return [{ text: task[2].replace(/~~/g, "").replace(/\s*dropped:.*$/, "").trim(), done: task[1] === "x", dropped }];
		}),
		verified: field("Verified"),
		left: field("Left"),
		createdAt: comment.created_at,
		updatedAt: comment.updated_at,
		url: comment.html_url,
	};
}

function phaseOf(run: GitHubRun, jobs: GitHubJob[]): SwarmRunPhase {
	if (run.status === "completed") return "done";
	if (run.status !== "in_progress") return "queued";
	const job = jobs.find((j) => j.status === "in_progress");
	if (!job || job.name === "dispatch") return "dispatching";
	const step = job.steps?.find((s) => s.status === "in_progress")?.name ?? "";
	if (step.includes("claude-code-action")) return "working";
	if (step.includes("lake") || step.includes("build")) return "building";
	if (step.includes("cost")) return "recording cost";
	return "setting up";
}

async function recentRuns(notes: SwarmNote[], costs: SwarmCost[]): Promise<SwarmRun[]> {
	const { workflow_runs } = await github<{ workflow_runs: GitHubRun[] }>(`/actions/workflows/${SWARM_WORKFLOW}/runs?per_page=6`);
	return Promise.all(workflow_runs.map(async (run) => {
		const jobs = run.status === "in_progress" ? (await github<{ jobs: GitHubJob[] }>(`/actions/runs/${run.id}/jobs`)).jobs : [];
		return {
			id: run.id,
			status: run.status,
			conclusion: run.conclusion,
			phase: phaseOf(run, jobs),
			startedAt: run.run_started_at,
			updatedAt: run.updated_at,
			url: run.html_url,
			note: notes.find((note) => note.runId === run.id) ?? null,
			usd: costs.find((cost) => cost.runId === run.id)?.usd ?? null,
		};
	}));
}

const COST_MARKER = /<!-- fm-cost role=(\S+) ref=(\S+) usd=([\d.]+)(?: run=(\d+))?/;

let cached: { at: number; state: Promise<SwarmState> } | null = null;

export function getSwarmState(): Promise<SwarmState> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
	const state = loadSwarmState();
	cached = { at: Date.now(), state };
	state.catch(() => { cached = null; });
	return state;
}

async function loadSwarmState(): Promise<SwarmState> {
	const [open, closed, ledger, rawNotebook, chief] = await Promise.all([
		github<GitHubIssue[]>("/issues?state=open&per_page=100"),
		github<GitHubIssue[]>("/issues?state=closed&per_page=20&sort=updated"),
		latestComments(LEDGER_ISSUE, 30),
		latestRawComments(NOTEBOOK_ISSUE, 12),
		latestComments(CHIEF_ISSUE, 1),
	]);
	const notebook = rawNotebook.slice(-6).map(toComment);

	const costs = ledger.flatMap((comment) => {
		const match = comment.body.match(COST_MARKER);
		return match ? [{ role: match[1], ref: match[2], usd: Number(match[3]), runId: match[4] ? Number(match[4]) : null, createdAt: comment.createdAt }] : [];
	});
	const runs = await recentRuns(rawNotebook.flatMap((comment) => parseNote(comment) ?? []), costs);
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
		runs,
	};
}
