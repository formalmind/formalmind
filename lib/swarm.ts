/**
 * Live state of the formalmind swarm, read from GitHub. One swarm (one team, one budget) works
 * several projects: its home repository holds the workflow and the swarm-wide issues (ledger,
 * notebook, chief, assistant) and lists the proofs repositories it sweeps in
 * `.github/formalmind/projects.json`; each proofs repository keeps its own fm: issues and PRs.
 * The swarm keeps all of its memory in issues, labels and comments (see
 * `asyncswap/v2-proofs/.github/formalmind/README.md`), so this is everything it knows.
 */

import type { Project } from "@/lib/projects";
import { SWARM_REPO as DEFAULT_REPO } from "@/lib/swarm-repo";

/** The swarm's home: its workflow, its role docs and its swarm-wide issues. */
export const SWARM_REPO = process.env.SWARM_REPO || DEFAULT_REPO;
export const LEDGER_ISSUE = 38;
export const CHIEF_ISSUE = 53;
export const NOTEBOOK_ISSUE = 55;
/** The maintainer's thread with the assistant, the one role that talks to them. */
export const ASSISTANT_ISSUE = 69;
const SWARM_WORKFLOW = "formalmind-swarm.yml";
/** Shared by every request in this server instance, so polling clients don't multiply GitHub calls. */
const CACHE_MS = 10_000;

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

export type GitHubComment = { body: string; created_at: string; updated_at: string; html_url: string };

type GitHubRun = { id: number; status: string; conclusion: string | null; run_started_at: string; updated_at: string; html_url: string };

type GitHubJob = { name: string; status: string; steps?: { name: string; status: string }[] };

/** A GitHub REST call on `repo` (the swarm's home unless given). */
export async function github<T>(path: string, repo = SWARM_REPO): Promise<T> {
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

const NOTE_MARKER = /<!-- fm-note role=(\S+) ref=#?(\S*) run=(\d+)(?: repo=(\S+))? -->/;
/** Ledger and notebook lines name the proofs repository they are about; older lines are all the home's. */
const REPO_FIELD = / repo=([\w.-]+\/[\w.-]+)/;
const ROLE_NAMES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", rebuild: "rebuilder", review: "reviewer", merge: "merger", editor: "editor", chief: "chief", assistant: "assistant" };

const HANDOFF_ROLES: Record<string, SwarmRole> = { ...ROLE_NAMES, planner: "planner", prover: "prover", rebuilder: "rebuilder", reviewer: "reviewer", merger: "merger", dispatcher: "dispatcher" };

/** "reviewer — check the swap case first" → { to: "reviewer", why: "check the swap case first" }. */
export function parseHandoff(line: string | null): SwarmHandoff | null {
	const match = line?.match(/^(@?[\w-]+)\s*(?:[—–:-]\s*)?(.*)$/);
	if (!match) return null;
	const who = match[1].toLowerCase();
	return { to: who.startsWith("@") || who === "nobody" ? match[1] : HANDOFF_ROLES[who] ?? who, why: match[2].trim() };
}

function parseNote(comment: GitHubComment): SwarmNote | null {
	const marker = comment.body.match(NOTE_MARKER);
	const role = marker && ROLE_NAMES[marker[1]];
	if (!marker || !role) return null;
	const lines = comment.body.split("\n");
	const field = (name: string) => lines.find((l) => l.startsWith(`**${name}:**`))?.slice(name.length + 5).trim() || null;
	return {
		repo: marker[4] ?? SWARM_REPO,
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
		next: parseHandoff(field("Next")),
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
	if (step.includes("lake") || step.includes("build") || step.includes("forge")) return "building";
	if (step.includes("cost")) return "recording cost";
	return "setting up";
}

/** A job's name is "<role> #<n>" (or the role alone) in the template's workflow; the dispatcher and hand-off jobs aren't agents. */
const JOB_ROLES: Record<string, { role: SwarmRole; task: string | null }> = {
	plan: { role: "planner", task: null },
	prove: { role: "prover", task: null },
	poc: { role: "prover", task: "writing a POC" },
	review: { role: "reviewer", task: null },
	merge: { role: "merger", task: null },
	chief: { role: "chief", task: null },
};

/** Who is working now in each proofs repository, read from its running swarm jobs. */
async function activeAgents(repos: string[]): Promise<SwarmActive[]> {
	const perRepo = await Promise.all(repos.map(async (repo) => {
		try {
			const { workflow_runs } = await github<{ workflow_runs: (GitHubRun & { id: number })[] }>(`/actions/workflows/${SWARM_WORKFLOW}/runs?status=in_progress&per_page=5`, repo);
			const jobs = await Promise.all(workflow_runs.map((run) => github<{ jobs: (GitHubJob & { started_at?: string })[] }>(`/actions/runs/${run.id}/jobs`, repo).then((r) => r.jobs)));
			return jobs.flat().flatMap((job): SwarmActive[] => {
				if (job.status !== "in_progress" && job.status !== "queued") return [];
				const match = job.name.match(/^(\w+)(?:\s+#(\d+))?$/);
				const known = match ? JOB_ROLES[match[1]] : undefined;
				if (!known) return [];
				const step = job.steps?.find((s) => s.status === "in_progress")?.name ?? "";
				const phase: SwarmRunPhase = job.status === "queued" ? "queued"
					: step.includes("claude-code-action") ? "working"
					: step.includes("lake") || step.includes("build") || step.includes("Gate") || step.includes("forge") ? "building"
					: step.includes("cost") ? "recording cost"
					: "setting up";
				return [{ repo, role: known.role, ref: match?.[2] ? Number(match[2]) : null, task: known.task, phase, startedAt: job.started_at ?? new Date().toISOString() }];
			});
		} catch {
			// A repository we can't read (no workflow yet, no access) has nobody to show.
			return [];
		}
	}));
	return perRepo.flat();
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

// `ref` can be empty: the planner works from the README, not an issue.
const COST_MARKER = /<!-- fm-cost role=(\S+) ref=(\S*) usd=([\d.]+)(?: run=(\d+))?/;
const CYCLE_MARKER = /<!-- fm-cycle n=(\d+) phase=(\w+) -->/;

export function parseCost(comment: GitHubComment): SwarmCost[] {
	const match = comment.body.match(COST_MARKER);
	if (!match) return [];
	const repo = comment.body.split("-->")[0].match(REPO_FIELD)?.[1] ?? SWARM_REPO;
	return [{ repo, role: match[1], ref: match[2], usd: Number(match[3]), runId: match[4] ? Number(match[4]) : null, createdAt: comment.created_at }];
}

/** What is known of the ledger so far: the costs on its full pages of 100 comments, which no longer change. */
type LedgerCache = { fullPages: number; costs: SwarmCost[] };
// v2: cost lines carry the repository they were spent on.
const LEDGER_KEY = `swarm:ledger:${SWARM_REPO}:v2`;
let ledgerCache: LedgerCache | null = null;

async function readLedgerCache(): Promise<LedgerCache> {
	if (ledgerCache) return ledgerCache;
	try {
		const { getJSON } = await import("@/lib/kv");
		ledgerCache = (await getJSON<LedgerCache>(LEDGER_KEY)) ?? { fullPages: 0, costs: [] };
	} catch {
		// No KV (Storybook, scripts): keep what this instance learns in memory.
		ledgerCache = { fullPages: 0, costs: [] };
	}
	return ledgerCache;
}

async function writeLedgerCache(next: LedgerCache) {
	ledgerCache = next;
	try {
		const { putJSON } = await import("@/lib/kv");
		await putJSON(LEDGER_KEY, next);
	} catch {}
}

/** Cost lines from the Project Durable Object (no GitHub read per poll); straight from the ledger where there is none. */
async function spendCosts(): Promise<SwarmCost[]> {
	try {
		const { projectObject } = await import("@/lib/spend");
		const project = projectObject();
		if (project) return (await project.costs()).costs;
	} catch (err) {
		console.error("[swarm] spend object unavailable, reading the ledger", err);
	}
	return allCosts();
}

/**
 * Every cost line the swarm has written to the ledger issue, oldest first. Full pages come from the cache;
 * only the pages after them (normally just the last, still filling up) are fetched.
 */
async function allCosts(): Promise<SwarmCost[]> {
	const cache = await readLedgerCache();
	const meta = await github<{ comments: number }>(`/issues/${LEDGER_ISSUE}`);
	const pages = Math.max(1, Math.ceil(meta.comments / 100));
	const fresh = await Promise.all(
		Array.from({ length: Math.max(0, pages - cache.fullPages) }, (_, i) =>
			github<GitHubComment[]>(`/issues/${LEDGER_ISSUE}/comments?per_page=100&page=${cache.fullPages + i + 1}`),
		),
	);
	const full = fresh.filter((page) => page.length === 100);
	if (full.length) {
		await writeLedgerCache({ fullPages: cache.fullPages + full.length, costs: [...cache.costs, ...full.flat().flatMap(parseCost)] });
	}
	const partial = fresh.filter((page) => page.length < 100).flat();
	return [...(ledgerCache ?? cache).costs, ...partial.flatMap(parseCost)];
}

/** One proofs repository the swarm sweeps, from the home's `.github/formalmind/projects.json`. */
type SwarmConfigProject = { repo: string; protocol: string };

/** The proofs repositories the swarm sweeps. Before the home lists any, it is the only one. */
async function swarmProjects(): Promise<SwarmConfigProject[]> {
	try {
		const file = await github<{ content: string }>("/contents/.github/formalmind/projects.json");
		const parsed = JSON.parse(atob(file.content.replace(/\s/g, ""))) as { projects?: SwarmConfigProject[] };
		if (parsed.projects?.length) return parsed.projects;
	} catch {}
	return [{ repo: SWARM_REPO, protocol: "asyncswap/v2" }];
}

/** The swarm's projects in its own order, then the account's others (which it does not sweep yet). */
function boardProjects(config: SwarmConfigProject[], account: Project[]): SwarmProject[] {
	const board: SwarmProject[] = config.map((c) => ({ repo: c.protocol, proofsRepo: c.repo, inSwarm: true }));
	for (const p of account) {
		if (board.some((b) => b.repo === p.repo || (p.proofsRepo && b.proofsRepo === p.proofsRepo))) continue;
		board.push({ repo: p.repo, proofsRepo: p.proofsRepo, inSwarm: false });
	}
	return board;
}

/** One project's open fm: work and its latest merges; an unreadable repository yields an error, not a failed board. */
async function projectWork(project: SwarmProject): Promise<{ project: SwarmProject; work: SwarmItem[]; merged: SwarmItem[] }> {
	const repo = project.proofsRepo;
	if (!repo) return { project, work: [], merged: [] };
	try {
		const [open, closed] = await Promise.all([
			github<GitHubIssue[]>("/issues?state=open&per_page=100", repo),
			github<GitHubIssue[]>("/issues?state=closed&per_page=20&sort=updated", repo),
		]);
		return {
			project,
			work: open.filter((issue) => issue.labels.some((label) => label.name.startsWith("fm:"))).map((issue) => toItem(repo, issue)),
			merged: closed.filter((issue) => issue.pull_request?.merged_at).slice(0, 5).map((issue) => toItem(repo, issue)),
		};
	} catch (error) {
		console.error(`[swarm] reading ${repo} failed:`, error);
		return { project: { ...project, error: `Could not read ${repo}.` }, work: [], merged: [] };
	}
}

const cached = new Map<string, { at: number; state: Promise<SwarmState> }>();

/** The swarm across its projects and the account's (`projects`, from /api/projects). */
export function getSwarmState(projects: Project[] = []): Promise<SwarmState> {
	const key = projects.map((p) => `${p.repo}:${p.proofsRepo ?? ""}`).sort().join(",");
	const hit = cached.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
	const state = loadSwarmState(projects);
	cached.set(key, { at: Date.now(), state });
	state.catch(() => cached.delete(key));
	return state;
}

async function loadSwarmState(account: Project[]): Promise<SwarmState> {
	const [config, ledger, rawNotebook, chief, assistant, costs] = await Promise.all([
		swarmProjects(),
		latestComments(LEDGER_ISSUE, 30),
		latestRawComments(NOTEBOOK_ISSUE, 12),
		latestComments(CHIEF_ISSUE, 1),
		latestComments(ASSISTANT_ISSUE, 1),
		spendCosts(),
	]);
	const boards = await Promise.all(boardProjects(config, account).map(projectWork));
	const notebook = rawNotebook.slice(-6).map(toComment);

	const cycle = ledger.flatMap((comment) => {
		const match = comment.body.match(CYCLE_MARKER);
		return match ? [{ n: Number(match[1]), phase: match[2], createdAt: comment.createdAt }] : [];
	}).at(-1) ?? null;
	const [runs, active] = await Promise.all([
		recentRuns(rawNotebook.flatMap((comment) => parseNote(comment) ?? []), costs),
		// The home's own runs are told by its notebook; the other proofs repositories by their running jobs.
		activeAgents(boards.flatMap((b) => (b.project.proofsRepo && b.project.proofsRepo !== SWARM_REPO ? [b.project.proofsRepo] : []))),
	]);
	const today = new Date().toISOString().slice(0, 10);

	return {
		repo: SWARM_REPO,
		fetchedAt: new Date().toISOString(),
		projects: boards.map((b) => b.project),
		work: boards.flatMap((b) => b.work),
		merged: boards.flatMap((b) => b.merged),
		costs,
		spentToday: costs.filter((cost) => cost.createdAt.startsWith(today)).reduce((sum, cost) => sum + cost.usd, 0),
		chief: chief[0] ?? null,
		assistant: assistant[0] ?? null,
		cycle,
		notebook,
		ledger: ledger.filter((comment) => !COST_MARKER.test(comment.body)).slice(-5),
		runs,
		active,
	};
}
