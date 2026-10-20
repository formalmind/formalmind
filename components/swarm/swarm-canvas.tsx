"use client";

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Hand, MousePointer2, Maximize, Minus, Pause, Play, Plus, X } from "lucide-react";
import { Link } from "react-router";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { TextSwap } from "@/components/motion/text-swap";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SwarmItem, SwarmProject, SwarmRole, SwarmRun, SwarmState } from "@/lib/swarm";
import { ROLE_COLORS } from "@/lib/swarm-roles";

export { ROLE_COLORS };

/**
 * A replay of one trip through the swarm, acted out by one cursor per role on a board of
 * the swarm's labels. The board starts from the live queue; the moves follow the hand-off
 * rules in the proofs repository's `.github/formalmind/README.md`.
 */

const W = 1200;
/** A finished run stays on the board this long before the replay takes over again. */
export const LIVE_WINDOW_MS = 10 * 60_000;

export function isLiveRun(run: SwarmRun | null | undefined): run is SwarmRun {
	return Boolean(run && (run.status !== "completed" || Date.now() - Date.parse(run.updatedAt) < LIVE_WINDOW_MS));
}

function clip(text: string, max = 120) {
	const plain = text.replace(/`/g, "");
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

const ROLES = Object.keys(ROLE_COLORS) as SwarmRole[];

type Lane = "roadmap" | "todo" | "progress" | "review" | "approved" | "dev";
const LANE_WORD: Record<Lane, string> = { roadmap: "roadmap", todo: "todo", progress: "in progress", review: "review", approved: "approved", dev: "done" };

const LANES: { key: Lane; title: string }[] = [
	{ key: "roadmap", title: "Roadmap" },
	{ key: "todo", title: "fm:todo" },
	{ key: "progress", title: "fm:in-progress" },
	{ key: "review", title: "fm:review" },
	{ key: "approved", title: "fm:approved" },
	{ key: "dev", title: "Done" },
];

export const LABEL_STYLES: Record<string, string> = {
	"fm:todo": "bg-slate-500/15 text-slate-600 dark:text-slate-300",
	"fm:in-progress": "bg-blue-500/15 text-blue-600 dark:text-blue-300",
	"fm:review": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	"fm:changes": "bg-red-500/15 text-red-600 dark:text-red-300",
	"fm:approved": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	"fm:blocked": "bg-red-500/15 text-red-600 dark:text-red-300",
	"fm:needs-rebase": "bg-orange-500/15 text-orange-700 dark:text-orange-300",
	"fm:rebuild": "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
	"fm:rebuilding": "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
	"fm:finding": "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
	"fm:intent": "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
	merged: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
	...Object.fromEntries(["planner", "prover", "rebuilder", "reviewer", "merger", "editor", "chief", "assistant"].map((r) => [`fm:ask-${r}`, "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300"])),
	README: "bg-muted text-muted-foreground",
};

const LANE_W = 176;
const LANE_GAP = 16;
const PAD = 24;
const LANE_TOP = 64;
const LANE_BOTTOM = 400;
const CARD_TOP = 100;
const CARD_MIN_H = 78;
const CARD_GAP = 10;
const CARD_W = 160;
const PANEL_H = 136;
/** Each project's lanes repeat this far below the last one's. */
const GROUP_H = LANE_BOTTOM;
/** In fill mode the board fits this much of its height to the screen; taller boards (more projects) pan. */
const FIT_H = 900;

const PANEL_W = 368;
const PANEL_GAP = 24;
const CHIP = { x: PAD, y: 14 };

const laneX = (lane: Lane) => PAD + LANES.findIndex((l) => l.key === lane) * (LANE_W + LANE_GAP);
const panelX = (i: number) => PAD + i * (PANEL_W + PANEL_GAP);
const groupY = (group: number) => group * GROUP_H;

/** What a replay card would look like as a GitHub issue or PR, for the demo's hover cards. */
function demoItem(card: Card): SwarmItem {
	const pr = card.kind === "pr";
	const when = new Date(Date.now() - (card.number % 5 + 1) * 3_600_000).toISOString();
	return {
		repo: "asyncswap/v2-proofs",
		number: card.number,
		title: card.title,
		kind: pr ? "pr" : "issue",
		labels: [card.label],
		url: "https://github.com/asyncswap/v2-proofs",
		updatedAt: when,
		createdAt: when,
		author: "formalmind[bot]",
		authorAvatar: "https://avatars.githubusercontent.com/in/1301446",
		excerpt: pr
			? "Proves the invariant stated in the issue in Lean 4. lake build is clean on this commit, with no sorry and no new axiom. The changelog entry lists the theorems added."
			: "Scope: state the property in Lean 4 and prove it for every entry point that touches this state. Done when lake build is clean and the theorem is listed in the changelog.",
		comments: pr ? 3 : 1,
		merged: card.label === "merged",
	};
}

type Card = {
	id: string;
	/** The project's place on the board, top to bottom. */
	group: number;
	/** The proofs repository of the issue or PR behind it; none for docs and replay-only cards. */
	repo?: string;
	/** What a doc card stands for, in its details. */
	detail?: string;
	/** Where a doc card lives on GitHub. */
	href?: string;
	number: number;
	title: string;
	kind: "issue" | "pr" | "doc";
	lane: Lane;
	order: number;
	label: string;
	branch?: string;
};

/** `thinking`: working right now (a running job), so the cursor shows it. */
/** `until`: a time the bubble counts down to (the dispatcher's next sweep). */
type Cursor = { at?: { x: number; y: number }; follow?: string; say?: string; thinking?: boolean; where?: { text: string; card?: string; href: string }; until?: number };

type Note = { role: SwarmRole; text: string; done: boolean };

type Scene = {
	cards: Card[];
	cursors: Record<SwarmRole, Cursor>;
	spend: number;
	notes: Note[];
	chief: string;
	job: string | null;
	costs: LedgerRow[];
	tick: number;
	/** The one role holding the turn; the others wait. */
	turn: SwarmRole | null;
};

const HOME_X: Record<SwarmRole, number> = {
	dispatcher: 640,
	planner: 120,
	prover: 290,
	rebuilder: 460,
	editor: 590,
	reviewer: 720,
	merger: 860,
	assistant: 980,
	chief: 1110,
};

/**
 * Where things sit for a board of `groups` projects: each project's lanes, one under the other, then the
 * bench where the shared roles wait between turns, then the swarm-wide panels. The dispatcher stays on top.
 */
function geometry(groups: number) {
	const bench = groupY(groups - 1) + LANE_BOTTOM + 20;
	const panelTop = bench + 56;
	const home = Object.fromEntries(ROLES.map((r) => [r, { x: HOME_X[r], y: r === "dispatcher" ? 34 : bench }])) as Record<SwarmRole, { x: number; y: number }>;
	// The assistant waits in the chief's notebook (lower left; the chief works on its right), not on the bench.
	home.assistant = { x: panelX(2) + 32, y: panelTop + 92 };
	return {
		home,
		panelTop,
		height: panelTop + PANEL_H + PAD,
		roadmap: (group: number) => ({ x: laneX("roadmap") + 120, y: groupY(group) + CARD_TOP + 44 }),
		chief: { x: panelX(2) + 300, y: panelTop + 70 },
		ledger: { x: panelX(0) + 300, y: panelTop + 70 },
		notebook: { x: panelX(1) + 300, y: panelTop + 70 },
	};
}

/** The replay and the landing page show one project. */
const ONE = geometry(1);
const HOME = ONE.home;
const ROADMAP_SPOT = ONE.roadmap(0);
const CHIEF_SPOT = ONE.chief;
const JOBS = ["answer", "merge", "review", "revise", "resume", "new issue", "edit", "plan"];

type Step = { hold: number; apply: (scene: Scene) => void };

function card(scene: Scene, id: string) {
	return scene.cards.find((c) => c.id === id)!;
}

function move(scene: Scene, id: string, lane: Lane, patch: Partial<Card> = {}) {
	Object.assign(card(scene, id), { lane, order: scene.tick++, ...patch });
}

function say(scene: Scene, role: SwarmRole, text: string | undefined, where?: { x: number; y: number } | string) {
	const cursor = scene.cursors[role];
	if (text) scene.turn = role;
	if (typeof where === "string") scene.cursors[role] = { follow: where, say: text };
	else scene.cursors[role] = { at: where ?? cursor.at ?? HOME[role], follow: where ? undefined : cursor.follow, say: text };
}

function home(scene: Scene, ...roles: SwarmRole[]) {
	for (const role of roles) scene.cursors[role] = { at: HOME[role] };
}

/** Before the live state has loaded: an empty board, nothing scripted. */
function emptyScene(): Scene {
	return {
		cards: [{ id: "roadmap", group: 0, number: 0, title: "Roadmap and unproven gaps in .formal/plan.md", kind: "doc", lane: "roadmap", order: 0, label: "plan", href: HOME_ROADMAP }],
		cursors: Object.fromEntries(ROLES.map((r) => [r, { at: HOME[r] }])) as Scene["cursors"],
		spend: 0,
		notes: [],
		chief: "Working",
		job: null,
		costs: [],
		tick: 1,
		turn: null,
	};
}

/** A ledger line: one run's cost (coloured by role), or an earlier day's total. */
type LedgerRow = { label: string; usd: number; role?: SwarmRole };

function spend(scene: Scene, role: SwarmRole, usd: number) {
	scene.spend += usd;
	scene.costs = [...scene.costs, { label: role, role, usd }].slice(-3);
}

function note(scene: Scene, role: SwarmRole, text: string) {
	scene.notes = [...scene.notes, { role, text, done: false }].slice(-4);
}

function tick(scene: Scene) {
	const open = scene.notes.find((n) => !n.done);
	if (open) open.done = true;
}

function initialScene(state: SwarmState | null): Scene {
	const todo = (state?.work.filter((item) => item.kind === "issue" && item.labels.includes("fm:todo")) ?? []).sort((a, b) => a.number - b.number);
	// The replay needs two queued issues; real ones first, then placeholders numbered past
	// anything real so they never link to (or hover as) an unrelated issue.
	const known = [...(state?.work ?? []), ...(state?.merged ?? [])].map((item) => item.number);
	let next = Math.max(61, ...known) + 1;
	const queue: Pick<SwarmItem, "number" | "title" | "repo" | "url">[] = todo.slice(0, 2);
	const placeholders = ["spec: the next gap the planner queues", "spec: another roadmap item"];
	while (queue.length < 2) queue.push({ number: next++, title: placeholders[queue.length], repo: "", url: "" });
	const merged = (state?.merged ?? []).slice(0, 2).reverse();
	let order = 0;
	const repoOf = (item: Partial<SwarmItem>) => (item.url && state ? item.repo ?? state.repo : undefined);
	const cards: Card[] = [
		{ id: "roadmap", group: 0, number: 0, title: "Roadmap and unproven gaps in .formal/plan.md", kind: "doc", lane: "roadmap", order: order++, label: "plan", href: HOME_ROADMAP },
		...merged.map((item) => ({ id: `m${item.number}`, group: 0, repo: repoOf(item), number: item.number, title: item.title, kind: "pr" as const, lane: "dev" as Lane, order: order++, label: "merged" })),
		...queue.map((item) => ({ id: `i${item.number}`, group: 0, repo: repoOf(item), number: item.number, title: item.title, kind: "issue" as const, lane: "todo" as Lane, order: order++, label: "fm:todo" })),
	];
	return {
		cards,
		cursors: Object.fromEntries(ROLES.map((role) => [role, { at: HOME[role] }])) as Scene["cursors"],
		spend: state?.spentToday ?? 0,
		notes: [],
		chief: firstLine(state?.chief?.body) ?? "Working",
		job: null,
		costs: [],
		tick: order,
		turn: null,
	};
}

function firstLine(body?: string) {
	if (!body) return null;
	const line = body.split("\n")[0].replace(/\*\*/g, "");
	return line.includes("—") ? line.split("—").slice(1).join("—").trim() : line.trim();
}

function buildScript(start: Scene): Step[] {
	const issues = start.cards.filter((c) => c.kind === "issue");
	const a = issues[0];
	const top = Math.max(...start.cards.map((c) => c.number));
	const pr = top + 1;
	const next = top + 2;
	const id = a.id;
	// One issue's trip, one turn at a time. Each turn ends by naming who goes next; twice the
	// prover stops to /ask the reviewer, once for an answer and once for a quality check the
	// reviewer takes over.
	return [
		{ hold: 1800, apply: (s) => { s.job = "new issue"; say(s, "dispatcher", `Sweep: $${(5 - s.spend).toFixed(2)} of $5 left today. No questions, nothing to merge or review: prover, #${a.number} is yours`); } },
		{ hold: 1400, apply: (s) => { home(s, "dispatcher"); say(s, "prover", `My turn. Picking up #${a.number}`, id); note(s, "prover", `#${a.number}: read, define, prove, build, open PR`); } },
		{ hold: 1500, apply: (s) => { move(s, id, "progress", { label: "fm:in-progress", branch: `fm/issue-${a.number}` }); say(s, "prover", `On branch fm/issue-${a.number}`, id); } },
		{ hold: 2000, apply: (s) => { move(s, id, "progress", { label: "fm:ask-reviewer" }); say(s, "prover", "/ask reviewer Should the statement cover every entry point, or just swap? Holding until you answer", id); spend(s, "prover", 0.35); } },
		{ hold: 1500, apply: (s) => { home(s, "prover"); s.job = "answer"; say(s, "dispatcher", `#${a.number} has a question for the reviewer, and questions go first`); } },
		{ hold: 2000, apply: (s) => { home(s, "dispatcher"); say(s, "reviewer", "Answering prover: every entry point, so it matches Router.sol. Next: prover", id); spend(s, "reviewer", 0.12); } },
		{ hold: 1400, apply: (s) => { move(s, id, "progress", { label: "fm:in-progress" }); home(s, "reviewer"); s.job = "resume"; say(s, "dispatcher", `Question answered. #${a.number} is in progress, so the prover resumes`); } },
		{ hold: 1800, apply: (s) => { home(s, "dispatcher"); say(s, "prover", "Quantified over every entry point. lake build ✓ no sorry, no new axioms", id); tick(s); spend(s, "prover", 0.6); } },
		{ hold: 1800, apply: (s) => { move(s, id, "review", { kind: "pr", number: pr, label: "fm:review" }); say(s, "prover", `Opened PR #${pr}. Next: reviewer — the swap case first`, id); } },
		{ hold: 1400, apply: (s) => { home(s, "prover"); s.job = "review"; say(s, "dispatcher", `PR #${pr} has fm:review: reviewer's turn`); } },
		{ hold: 1900, apply: (s) => { home(s, "dispatcher"); say(s, "reviewer", "Checked the Solidity line by line. One suggestion: dsimp only before omega. Next: prover", id); note(s, "reviewer", `#${pr}: diff, Solidity, scope, changelog`); } },
		{ hold: 1300, apply: (s) => { move(s, id, "progress", { label: "fm:changes" }); tick(s); spend(s, "reviewer", 0.22); home(s, "reviewer"); s.job = "revise"; say(s, "dispatcher", `PR #${pr} has fm:changes: prover revises`); } },
		{ hold: 2000, apply: (s) => { home(s, "dispatcher"); say(s, "prover", "Applied it. /ask reviewer Quality check the swap case before I hand it back?", id); move(s, id, "progress", { label: "fm:ask-reviewer" }); spend(s, "prover", 0.4); } },
		{ hold: 1400, apply: (s) => { home(s, "prover"); s.job = "answer"; say(s, "dispatcher", "A question for the reviewer goes first"); } },
		{ hold: 2000, apply: (s) => { home(s, "dispatcher"); say(s, "reviewer", "Taking over: I'm the quality check, so I'll review it now instead of answering", id); } },
		{ hold: 1800, apply: (s) => { move(s, id, "approved", { label: "fm:approved" }); say(s, "reviewer", "Swap case holds and the suggestion is in. Approved. Next: merger", id); spend(s, "reviewer", 0.2); } },
		{ hold: 1400, apply: (s) => { home(s, "reviewer"); s.job = "merge"; say(s, "dispatcher", `PR #${pr} has fm:approved: merger's turn`); } },
		{ hold: 2000, apply: (s) => { home(s, "dispatcher"); say(s, "merger", "lake build on the exact head ✓. Every theorem the thread claims exists without sorry", id); note(s, "merger", `#${pr}: gate, verify claims, decide, merge`); } },
		{ hold: 1700, apply: (s) => { move(s, id, "dev", { label: "merged" }); say(s, "merger", "Squash-merged into dev. Next: nobody — it's done", id); tick(s); spend(s, "merger", 0.25); } },
		{ hold: 1400, apply: (s) => { home(s, "merger"); s.job = "plan"; say(s, "dispatcher", "Only one fm:todo left: planner's turn"); } },
		{ hold: 1700, apply: (s) => { home(s, "dispatcher"); say(s, "planner", "Reading the roadmap and the gaps the changelog left", ROADMAP_SPOT); note(s, "planner", "queue small, disjoint issues; post digest"); } },
		{ hold: 300, apply: (s) => { s.cards.push({ id: "new", group: 0, number: next, title: "spec: next unproven gap from the changelog", kind: "issue", lane: "roadmap", order: s.tick++, label: "fm:todo" }); } },
		{ hold: 1800, apply: (s) => { move(s, "new", "todo"); say(s, "planner", `Wrote #${next}. Next: prover — #${next} first`, "new"); tick(s); spend(s, "planner", 0.3); } },
		{ hold: 1500, apply: (s) => { home(s, "planner"); s.job = "edit"; say(s, "dispatcher", "The spec moved since the editor last compared: editor's turn"); } },
		{ hold: 2200, apply: (s) => { home(s, "dispatcher"); say(s, "editor", "Cycle 1, compare: the rebuild only takes USDC as currency1, the draft takes either. Filed as fm:finding", ROADMAP_SPOT); note(s, "editor", "draft vs rebuild vs proofs; classify; file"); spend(s, "editor", 0.45); } },
		{ hold: 2000, apply: (s) => { say(s, "editor", "/ask assistant Partial fills: keep their place, or re-queue like the draft? Next: assistant", ROADMAP_SPOT); } },
		{ hold: 2200, apply: (s) => { home(s, "editor"); s.job = "answer"; say(s, "assistant", "Asked you on #69, recommendation first: re-queue, like the draft", CHIEF_SPOT); spend(s, "assistant", 0.1); } },
		{ hold: 2600, apply: (s) => { s.job = null; s.chief = "Working: 1 merged, 2 queued, 1 question for you"; say(s, "chief", "Audited the day on #53. Next: assistant — one question is with the maintainer", CHIEF_SPOT); home(s, "assistant"); } },
		{ hold: 1600, apply: (s) => { home(s, "chief"); s.turn = null; } },
	];
}

const COST_ROLES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", rebuild: "rebuilder", review: "reviewer", merge: "merger", editor: "editor", chief: "chief", assistant: "assistant" };

/** Lane an open item sits in, from its fm: labels. */
/** The role an open question on this item is waiting for, from its fm:ask-<role> label. */
function askedOf(item: SwarmItem): SwarmRole | null {
	const label = item.labels.find((l) => l.startsWith("fm:ask-"));
	return label ? (label.slice("fm:ask-".length) as SwarmRole) : null;
}

/** Lane from the job labels; a pending question shows as the card's label without moving it. */
function laneOf(item: SwarmItem): { lane: Lane; label: string } | null {
	const place = jobLaneOf(item);
	const ask = item.labels.find((l) => l.startsWith("fm:ask-"));
	if (!ask) return place;
	return { lane: place?.lane ?? (item.kind === "pr" ? "review" : "progress"), label: ask };
}

function jobLaneOf(item: SwarmItem): { lane: Lane; label: string } | null {
	const has = (l: string) => item.labels.includes(l);
	if (item.kind === "issue") {
		if (has("fm:in-progress")) return { lane: "progress", label: "fm:in-progress" };
		if (has("fm:rebuilding")) return { lane: "progress", label: "fm:rebuilding" };
		if (has("fm:blocked")) return { lane: "progress", label: "fm:blocked" };
		if (has("fm:todo")) return { lane: "todo", label: "fm:todo" };
		if (has("fm:rebuild")) return { lane: "todo", label: "fm:rebuild" };
		if (has("fm:finding")) return { lane: "todo", label: "fm:finding" };
		if (has("fm:intent")) return { lane: "todo", label: "fm:intent" };
		return null;
	}
	if (has("fm:approved")) return { lane: "approved", label: "fm:approved" };
	if (has("fm:changes")) return { lane: "progress", label: "fm:changes" };
	if (has("fm:needs-rebase")) return { lane: "progress", label: "fm:needs-rebase" };
	if (has("fm:blocked")) return { lane: "review", label: "fm:blocked" };
	return { lane: "review", label: "fm:review" };
}

const PHASE_TEXT: Record<string, string> = {
	queued: "Queued, waiting for a runner",
	dispatching: "Checking the budget and picking one job",
	"setting up": "Checking out the repos",
	building: "lake build (and forge for the rebuild) on the exact head",
	working: "Thinking…",
	"recording cost": "Recording the cost on the ledger",
};

/** An instant's day on the viewer's own clock (YYYY-MM-DD), so "today" means their today, not UTC's. */
const localDay = (iso: string) => {
	const d = new Date(iso);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** 23:40 UTC, the chief's audit, in the viewer's time. */
const CHIEF_TIME = new Date(Date.UTC(2026, 0, 1, 23, 40)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The board as it really is, with the active run's role at the item it is working on. */
/** Today's runs one by one, newest first, then a total for each earlier day: every cost the ledger holds. */
function ledgerRows(state: SwarmState): LedgerRow[] {
	const today = localDay(state.fetchedAt);
	const rows: LedgerRow[] = state.costs
		.filter((c) => localDay(c.createdAt) === today)
		.reverse()
		.map((c) => {
			const role = COST_ROLES[c.role] ?? "dispatcher";
			const where = c.repo && c.repo !== state.repo ? ` ${c.repo.split("/")[1]}` : "";
			const ref = /^#?\d+$/.test(c.ref) ? `${where ? "" : " "}#${c.ref.replace(/^#/, "")}` : "";
			return { role, label: `${role}${where}${ref}`, usd: c.usd };
		});
	const days = new Map<string, { usd: number; runs: number }>();
	for (const c of state.costs) {
		const day = localDay(c.createdAt);
		if (day === today) continue;
		const d = days.get(day) ?? { usd: 0, runs: 0 };
		days.set(day, { usd: d.usd + c.usd, runs: d.runs + 1 });
	}
	for (const [day, d] of [...days].sort(([a], [b]) => b.localeCompare(a))) {
		const date = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
		rows.push({ label: `${date} · ${d.runs} run${d.runs === 1 ? "" : "s"}`, usd: d.usd });
	}
	return rows;
}

/** The board's projects; snapshots from before the swarm had several are its home's one project. */
export function projectsOf(state: SwarmState | null): SwarmProject[] {
	if (state?.projects?.length) return state.projects;
	return [{ repo: "asyncswap/v2", proofsRepo: state?.repo ?? null, inSwarm: true }];
}

const itemRepo = (state: SwarmState, item: SwarmItem) => item.repo ?? state.repo;
const itemKey = (repo: string, number: number) => `${repo}#${number}`;

const HOME_ROADMAP = "https://github.com/asyncswap/v2-proofs/blob/HEAD/.formal/plan.md";

/** A project's first card: its roadmap, or why the swarm has nothing of it yet. */
function roadmapCard(project: SwarmProject, group: number, home: string): Card {
	const base = { id: `roadmap:${group}`, group, number: 0, kind: "doc" as const, lane: "roadmap" as Lane, order: 0 };
	if (!project.proofsRepo) {
		return { ...base, title: "No proofs repository yet", label: "setup", detail: `Finish ${project.repo}'s Setup to give it a proofs repository; then the swarm can be pointed at it.` };
	}
	if (project.error) return { ...base, title: project.error, label: "README", detail: `The swarm's view of ${project.proofsRepo} could not be read from GitHub.`, href: `https://github.com/${project.proofsRepo}` };
	if (!project.inSwarm) {
		return { ...base, title: "Not swept by the swarm yet", label: "setup", detail: `${project.proofsRepo} is not in ${home}'s .github/formalmind/projects.json, so the dispatcher does not pick its work yet.`, href: `https://github.com/${home}/blob/HEAD/.github/formalmind/projects.json` };
	}
	return { ...base, title: "Roadmap and unproven gaps in .formal/plan.md", label: "plan", detail: `The roadmap in ${project.proofsRepo}'s .formal/plan.md.`, href: `https://github.com/${project.proofsRepo}/blob/HEAD/.formal/plan.md` };
}

/** The board as the swarm has it, with nothing scripted: one lane group per project. With no run in flight the cursors rest on the bench. */
const ACTIVE_PHASE: Partial<Record<SwarmRun["phase"], string>> = { queued: "getting ready", "setting up": "setting up", building: "building", working: "thinking", "recording cost": "wrapping up" };

/**
 * Agents with a job running in a project's proofs repository walk to the issue they work on (or the project's
 * roadmap) and say where their head is: "thinking · protocol#5". Who already has something to say keeps it.
 */
function placeActive(state: SwarmState, cards: Card[], cursors: Scene["cursors"], roadmap: (repo: string) => { x: number; y: number }) {
	for (const a of state.active ?? []) {
		if (a.finished || cursors[a.role].say) continue;
		const target = a.ref ? cards.find((c) => c.repo === a.repo && c.number === a.ref && c.kind !== "doc") : undefined;
		const where = {
			text: `${a.repo.split("/")[1]?.replace(/-proofs$/, "") ?? a.repo}${a.ref ? `#${a.ref}` : ""}`,
			card: target?.id,
			href: a.ref ? `https://github.com/${a.repo}/issues/${a.ref}` : `https://github.com/${a.repo}`,
		};
		const say = a.task ?? ACTIVE_PHASE[a.phase] ?? "working";
		cursors[a.role] = target ? { follow: target.id, say, thinking: true, where } : { at: roadmap(a.repo), say, thinking: true, where };
	}
}

/** The swarm sweeps every ten minutes on the clock (its cron); the next one, as a time. */
const nextSweep = (now = Date.now()) => Math.ceil((now + 1000) / 600_000) * 600_000;

/**
 * Between turns nobody stands idle at home: each agent waits by the card that is its next job (the prover by its
 * issue in progress, the reviewer by a PR to review, the merger by an approved one), the assistant by whatever is
 * waiting on you, and the dispatcher counts down to its next sweep.
 */
function placeWaiting(state: SwarmState, cards: Card[], cursors: Scene["cursors"]) {
	const first = (lane: Lane, label?: string) => cards.find((c) => c.lane === lane && c.kind !== "doc" && (!label || c.label === label));
	const blocked = cards.find((c) => c.label === "fm:blocked");
	const waits: [SwarmRole, Card | undefined, string][] = [
		["prover", first("progress", "fm:in-progress") ?? first("todo"), "next on my turn"],
		["reviewer", first("review"), "reviewing on my turn"],
		["merger", first("approved"), "merging on my turn"],
		["assistant", blocked, "waiting on you"],
	];
	for (const [role, card, say] of waits) {
		if (!card || cursors[role].say || cursors[role].follow) continue;
		cursors[role] = { follow: card.id, say };
	}
	if (!cursors.dispatcher.say && !(state.active ?? []).some((a) => !a.finished)) {
		cursors.dispatcher = { ...cursors.dispatcher, say: "next sweep in", until: nextSweep() };
	}
}

function liveScene(state: SwarmState, run: SwarmRun | null): Scene {
	const projects = projectsOf(state);
	const geo = geometry(projects.length);
	const groupOf = (repo: string) => Math.max(0, projects.findIndex((p) => p.proofsRepo === repo));
	const cardId = (item: SwarmItem) => `w:${itemKey(itemRepo(state, item), item.number)}`;
	let order = projects.length;
	const cards: Card[] = projects.map((project, group) => roadmapCard(project, group, state.repo));
	for (const project of projects) {
		const merged = state.merged.filter((item) => itemRepo(state, item) === project.proofsRepo).slice(0, 2).reverse();
		for (const item of merged) {
			const repo = itemRepo(state, item);
			cards.push({ id: `m:${itemKey(repo, item.number)}`, group: groupOf(repo), repo, number: item.number, title: item.title, kind: "pr", lane: "dev", order: order++, label: "merged" });
		}
	}
	for (const item of [...state.work].sort((a, b) => a.number - b.number)) {
		const place = laneOf(item);
		const repo = itemRepo(state, item);
		if (place) cards.push({ id: cardId(item), group: groupOf(repo), repo, number: item.number, title: item.title, kind: item.kind, lane: place.lane, order: order++, label: place.label });
	}

	const cursorsAtHome = Object.fromEntries(ROLES.map((r) => [r, { at: geo.home[r] }])) as Scene["cursors"];
	if (!run) {
		placeActive(state, cards, cursorsAtHome, (repo) => geo.roadmap(groupOf(repo)));
		placeWaiting(state, cards, cursorsAtHome);
		const last = state.runs.find((r) => r.note)?.note;
		return {
			cards,
			cursors: cursorsAtHome,
			spend: state.spentToday,
			notes: (last?.tasks ?? []).map((t) => ({ role: last!.role, text: t.text, done: t.done })),
			chief: firstLine(state.chief?.body) ?? "Working",
			job: null,
			costs: ledgerRows(state),
			tick: order,
			turn: null,
		};
	}

	const note = run.note;
	const role: SwarmRole = note?.role ?? "dispatcher";
	const done = run.status === "completed";
	const current = note?.tasks.find((t) => !t.done && !t.dropped);
	const handoff = done ? note?.next : null;
	const say = clip(done
		? handoff ? `Next: ${handoff.to}${handoff.why ? ` — ${handoff.why}` : ""}` : note ? `Done${note.verified ? `: ${note.verified}` : ""}` : "Finished"
		: current?.text ?? (note && run.phase === "working" ? "Wrapping up" : PHASE_TEXT[run.phase]));

	// The shared roles walk over to the project the run is about; the swarm-wide issues are in the home.
	const noteRepo = note?.repo ?? state.repo;
	const inHome = noteRepo === state.repo;
	const cursors = cursorsAtHome;
	const target = cards.find((c) => c.repo === noteRepo && c.number === note?.ref && c.kind !== "doc");
	const spot = role === "chief" || role === "assistant" || (inHome && (note?.ref === 53 || note?.ref === 69)) ? geo.chief
		: inHome && note?.ref === 38 ? geo.ledger
		: inHome && note?.ref === 55 ? geo.notebook
		: role === "planner" || role === "editor" ? geo.roadmap(groupOf(noteRepo))
		: undefined;
	cursors[role] = target ? { follow: target.id, say } : { at: spot ?? geo.home[role], say };

	// Open questions: the asked role waits at the item until the dispatcher gives it the turn.
	for (const item of state.work) {
		const asked = askedOf(item);
		if (asked && asked !== role && cards.some((c) => c.id === cardId(item))) {
			cursors[asked] = { follow: cardId(item), say: `Asked on #${item.number}. I answer on my turn` };
		}
	}
	// The baton: once a run ends, the role it handed to steps up to the same item.
	const nextRole = handoff && (ROLES as string[]).includes(handoff.to) ? (handoff.to as SwarmRole) : null;
	if (nextRole && nextRole !== role && !cursors[nextRole].say) {
		cursors[nextRole] = target ? { follow: target.id, say: "My turn next" } : { at: geo.home[nextRole], say: "My turn next" };
	}
	placeActive(state, cards, cursors, (repo) => geo.roadmap(groupOf(repo)));
	placeWaiting(state, cards, cursors);
	// The job comes from the item's job labels, not from a question label shown on the card.
	const targetItem = state.work.find((item) => itemRepo(state, item) === noteRepo && item.number === note?.ref);
	const label = targetItem ? jobLaneOf(targetItem)?.label : target?.label;
	const answering = Boolean(note?.title.toLowerCase().startsWith("answer"));
	const job = answering ? "answer"
		: role === "merger" ? "merge"
		: role === "reviewer" ? "review"
		: role === "planner" ? "plan"
		: role === "editor" ? "edit"
		: role === "prover" || role === "rebuilder" ? (label === "fm:changes" || label === "fm:needs-rebase" ? "revise" : label === "fm:in-progress" || label === "fm:rebuilding" ? "resume" : "new issue")
		: null;

	return {
		cards,
		cursors,
		spend: state.spentToday,
		notes: (note?.tasks ?? []).map((t) => ({ role, text: t.text, done: t.done })),
		chief: firstLine(state.chief?.body) ?? "Working",
		job,
		costs: ledgerRows(state),
		tick: order,
		turn: done ? nextRole ?? role : role,
	};
}

/** How long the roles stay in a project that just appeared before going back to what they were doing. */
const ARRIVAL_MS = 9000;

/**
 * A new project's welcome: every role that isn't holding the turn (or waiting on a question) walks into
 * its lanes, the planner to its roadmap, the dispatcher announcing it. The real run, if any, is untouched.
 */
function welcome(scene: Scene, repo: string, group: number): Scene {
	const next = cloneScene(scene);
	const free = ROLES.filter((r) => r !== next.turn && !next.cursors[r].say);
	free.forEach((role, i) => {
		if (role === "dispatcher") next.cursors.dispatcher = { at: geometry(1).home.dispatcher, say: `New project: ${repo}. It joins the sweep` };
		else if (role === "planner") next.cursors.planner = { at: { x: laneX("roadmap") + 120, y: groupY(group) + CARD_TOP + 44 }, say: "Reading its roadmap" };
		else {
			const lane = LANES[1 + (i % (LANES.length - 1))];
			next.cursors[role] = { at: { x: laneX(lane.key) + 40 + (i >= LANES.length ? 70 : 0), y: groupY(group) + CARD_TOP + 150 + (i % 2) * 70 } };
		}
	});
	return next;
}

/** Stacks each project's lanes of cards on their measured heights; a card that would run past its lane's bottom is hidden. */
function layout(cards: Card[], heights: Map<string, number>) {
	const positions = new Map<string, { x: number; y: number; hidden: boolean }>();
	for (const group of new Set(cards.map((c) => c.group))) {
		for (const lane of LANES) {
			const inLane = cards.filter((c) => c.group === group && c.lane === lane.key).sort((a, b) => b.order - a.order);
			let y = groupY(group) + CARD_TOP;
			let full = false;
			for (const c of inLane) {
				const h = heights.get(c.id) ?? CARD_MIN_H;
				full ||= y + h > groupY(group) + LANE_BOTTOM - 8;
				positions.set(c.id, { x: laneX(lane.key) + 8, y, hidden: full });
				y += h + CARD_GAP;
			}
		}
	}
	return positions;
}

function cloneScene(scene: Scene): Scene {
	return {
		...scene,
		cards: scene.cards.map((c) => ({ ...c })),
		cursors: Object.fromEntries(ROLES.map((role) => [role, { ...scene.cursors[role] }])) as Scene["cursors"],
		notes: scene.notes.map((n) => ({ ...n })),
		costs: [...scene.costs],
	};
}

/**
 * `fill` makes the board fill its parent, scaled to fit both ways and centred, below a strip kept clear
 * for the pinned controls; otherwise it scales to the width. `title` and `actions` are pinned top-left and top-right.
 */
export function SwarmCanvas({ state, fill = false, contain = false, title, actions, repo, onTalk, local = false }: {
	state: SwarmState | null;
	/** A swarm running on this computer (the desktop app): no dispatcher schedule to show. */
	local?: boolean;
	/** Fit the board inside its parent's height as well as its width (the landing demo); the replay still plays. */
	contain?: boolean;
	/** The proofs repo, for links before the live state has loaded. */
	repo?: string;
	/** Clicking an agent's name opens a chat with it (the app; the landing demo leaves it out). */
	onTalk?: (role: SwarmRole) => void;
	fill?: boolean;
	title?: ReactNode;
	actions?: ReactNode;
}) {
	const frameRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState({ scale: 1, x: 0, y: 0, w: 0, h: 0 });
	const { scale } = fit;
	// The panels grow with their text; the board grows with the tallest.
	const [panelHs, setPanelHs] = useState([PANEL_H, PANEL_H, PANEL_H]);
	const measurePanel = (i: number) => (h: number) => setPanelHs((prev) => (prev[i] === h ? prev : prev.map((v, j) => (j === i ? h : v))));
	// The live board has a lane group per project; the replay (and the board before any state) has one.
	const projects = projectsOf(state);
	const groups = state && (fill || isLiveRun(state.runs[0])) ? projects.length : 1;
	const geo = useMemo(() => geometry(groups), [groups]);
	const boardH = Math.max(geo.height, geo.panelTop + Math.max(...panelHs) + PAD);
	// In fill mode people can pan and zoom: `view` sits on top of the fitted placement.
	const [view, setRawView] = useState({ k: 1, x: 0, y: 0 });
	// The canvas is unbounded: pan anywhere; the fit button in the zoom pill brings the board back.
	const setView = (next: (v: { k: number; x: number; y: number }) => { k: number; x: number; y: number }) => setRawView(next);
	const setViewRef = useRef(setView);
	setViewRef.current = setView;
	const [panning, setPanning] = useState(false);
	// Dragging only pans on purpose: hold Space, switch on the hand tool (H, V to leave), or use the middle button.
	const [spaceHeld, setSpaceHeld] = useState(false);
	const [hand, setHand] = useState(false);
	const panMode = spaceHeld || hand;
	const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
	const zoomAt = (factor: number, px: number, py: number) =>
		setView((v) => {
			const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
			const ratio = k / v.k;
			// Keep the board point under (px, py) where it is.
			return { k, x: px - fit.x - (px - fit.x - v.x) * ratio, y: py - fit.y - (py - fit.y - v.y) * ratio };
		});
	const zoomAtRef = useRef(zoomAt);
	zoomAtRef.current = zoomAt;
	const [step, setStep] = useState(0);
	const [playing, setPlaying] = useState(true);
	// The card a click opened: a bottom island on phones, a popover anchored to it elsewhere.
	const [modal, setModal] = useState<{ card: Card; anchor?: Anchor } | null>(null);
	const isMobile = useIsMobile();
	const popoverRef = useRef<HTMLDivElement>(null);
	const anchorFor = (el: HTMLElement): Anchor | undefined => {
		const wrap = wrapRef.current;
		if (!wrap) return undefined;
		const box = el.getBoundingClientRect();
		const frame = wrap.getBoundingClientRect();
		const below = frame.bottom - box.bottom > 300;
		return {
			left: Math.min(Math.max(box.left - frame.left, 12), Math.max(frame.width - POPOVER_W * scale * view.k - 12, 12)),
			top: below ? box.bottom - frame.top + 8 : box.top - frame.top - 8,
			below,
		};
	};
	const open = (card: Card, el: HTMLElement) => setModal({ card, anchor: anchorFor(el) });
	const [hover, setHover] = useState<{ item: SwarmItem; left: number; top: number; below: boolean } | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	// The replay only restarts when the queue it starts from changes, not on every poll.
	const replayKey = state ? [...state.work.map((i) => `${i.number}:${i.labels.join(",")}`), ...state.merged.map((i) => i.number)].join("|") : "";
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const start = useMemo(() => initialScene(state), [replayKey]);
	const script = useMemo(() => buildScript(start), [start]);
	const latest = state?.runs[0];
	const run = isLiveRun(latest) ? latest : null;
	// The app shows only what is real; the scripted replay is the landing page's demo.
	const live = fill ? (state ? liveScene(state, run) : emptyScene()) : state && run ? liveScene(state, run) : null;
	const scene = useMemo(() => {
		const s = cloneScene(start);
		for (let i = 0; i < step; i++) script[i].apply(s);
		return s;
	}, [start, script, step]);

	useEffect(() => setStep(0), [script]);

	useEffect(() => {
		if (!playing || live) return;
		const hold = step === 0 ? 1200 : script[step - 1].hold;
		const timer = setTimeout(() => setStep((i) => (i >= script.length ? 0 : i + 1)), hold);
		return () => clearTimeout(timer);
	}, [playing, step, script, live]);

	useEffect(() => {
		// Contained, the frame is sized from the scale, so the space around it is what gets measured.
		const el = contain && !fill ? wrapRef.current : frameRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			const { width, height } = entry.contentRect;
			if (!fill && contain) {
				const next = Math.min(width / W, height / boardH);
				return setFit({ scale: next, x: 0, y: 0, w: W * next, h: boardH * next });
			}
			if (!fill) return setFit({ scale: width / W, x: 0, y: 0, w: width, h: height });
			const next = Math.min(width / W, (height - PINNED) / Math.min(boardH, FIT_H));
			setFit({ scale: next, x: (width - W * next) / 2, y: PINNED + Math.max(0, (height - PINNED - boardH * next) / 2), w: width, h: height });
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [fill, contain, boardH]);

	// The desktop popover closes on a press outside it (another card re-anchors it instead) or on Escape.
	const popoverOpen = !isMobile && modal !== null;
	useEffect(() => {
		if (!popoverOpen) return;
		const down = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			if (popoverRef.current?.contains(t) || t?.closest("[data-component]")) return;
			setModal(null);
		};
		const key = (e: KeyboardEvent) => e.key === "Escape" && setModal(null);
		document.addEventListener("pointerdown", down, true);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("pointerdown", down, true);
			document.removeEventListener("keydown", key);
		};
	}, [popoverOpen]);
	// It is anchored where the card was, so moving the board closes it.
	useEffect(() => {
		if (!isMobile) setModal(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view.k, view.x, view.y]);

	// Trackpad pinch and ctrl/cmd + wheel zoom at the pointer; a plain wheel or two-finger swipe pans.
	useEffect(() => {
		const el = frameRef.current;
		if (!el || !fill) return;
		const onWheel = (e: WheelEvent) => {
			const list = (e.target as HTMLElement).closest<HTMLElement>("[data-scroll]");
			// A list that can still scroll this way takes the wheel; at its end the board pans.
			if (list && !e.ctrlKey && !e.metaKey && e.deltaY !== 0) {
				const atTop = list.scrollTop <= 0;
				const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
				if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return;
			}
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const box = el.getBoundingClientRect();
				zoomAtRef.current(Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top);
			} else {
				setViewRef.current((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fill]);

	useEffect(() => {
		if (!fill) return;
		const typing = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			return Boolean(t?.closest("input, textarea, select, [contenteditable=true], [role=dialog]"));
		};
		const down = (e: KeyboardEvent) => {
			if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.code === "Space") {
				e.preventDefault();
				setSpaceHeld(true);
			} else if (e.key === "h" || e.key === "H") setHand((on) => !on);
			else if (e.key === "v" || e.key === "V" || e.key === "Escape") setHand(false);
		};
		const up = (e: KeyboardEvent) => {
			if (e.code === "Space") setSpaceHeld(false);
		};
		const blur = () => setSpaceHeld(false);
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", blur);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", blur);
		};
	}, [fill]);

	// Press and drag anywhere to pan. The pointer is only captured once it moves,
	// so a plain click still reaches the card under it.
	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!fill || (e.target as HTMLElement).closest("[data-canvas-ui]")) return;
		const middle = e.button === 1;
		if (!middle && !(e.button === 0 && panMode)) return;
		if (middle) e.preventDefault();
		drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
	};
	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d || d.id !== e.pointerId) return;
		// A release can be missed (outside the window, a lost capture); no button held means the drag is over.
		if (e.buttons === 0) return endDrag(e);
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (!d.moved) {
			if (Math.hypot(dx, dy) < 4) return;
			d.moved = true;
			e.currentTarget.setPointerCapture(e.pointerId);
			setPanning(true);
			setHover(null);
		}
		d.x = e.clientX;
		d.y = e.clientY;
		setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
	};
	const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (drag.current?.id !== e.pointerId) return;
		// Leave the flag up through the click that follows the release, so it can be swallowed.
		setTimeout(() => (drag.current = null));
		setPanning(false);
	};
	const zoomCentre = (factor: number) => {
		const box = frameRef.current?.getBoundingClientRect();
		if (box) zoomAt(factor, box.width / 2, box.height / 2);
	};
	const s = scale * view.k;
	const ox = fit.x + view.x;
	const oy = fit.y + view.y;

	// The demo always has the assistant follow you; in the app it's opt-in (it can get in the way), remembered here.
	const [followPref, setFollowPref] = useState(() => {
		try {
			return localStorage.getItem("fm:assistant-follows") === "1";
		} catch {
			return false;
		}
	});
	const follows = fill ? followPref : true;
	const toggleFollow = () => {
		const next = !followPref;
		setFollowPref(next);
		if (!next) releaseAssistant();
		try {
			localStorage.setItem("fm:assistant-follows", next ? "1" : "0");
		} catch {
			// Storage refused: the choice lasts for this visit.
		}
	};
	// The assistant follows your pointer by moving its own element each frame, on a short ease: re-rendering the
	// board per mouse move, with the cursors' long 700ms glide restarting each time, made it flicker.
	const companionFrame = useRef(0);
	const assistantEl = () => frameRef.current?.querySelector<HTMLElement>('[data-cursor="assistant"]') ?? null;
	const followPointer = (e: React.PointerEvent<HTMLDivElement>) => {
		const box = frameRef.current?.getBoundingClientRect();
		if (!follows || !box || companionFrame.current) return;
		const x = (e.clientX - box.left - ox) / s + 22;
		const y = (e.clientY - box.top - oy) / s + 26;
		companionFrame.current = requestAnimationFrame(() => {
			companionFrame.current = 0;
			const el = assistantEl();
			if (!el) return;
			if (el.dataset.home === undefined) el.dataset.home = el.style.transform;
			el.style.transition = "transform 150ms cubic-bezier(0.22, 1, 0.36, 1)";
			el.style.transform = `translate(${x}px, ${y}px)`;
		});
	};
	// Back to its own spot, on the cursors' usual glide.
	const releaseAssistant = () => {
		cancelAnimationFrame(companionFrame.current);
		companionFrame.current = 0;
		const el = assistantEl();
		if (!el || el.dataset.home === undefined) return;
		el.style.transition = "";
		el.style.transform = el.dataset.home;
		delete el.dataset.home;
	};

	// A project that shows up while the board is open (its plan was just saved) gets a welcome: its lanes
	// fade in, the board pans to it, and the roles not working stream over to it for a few seconds.
	const seen = useRef<Set<string> | null>(null);
	const [arrival, setArrival] = useState<{ repo: string; group: number; at: number } | null>(null);
	const projectKey = state && fill ? projects.map((p) => p.repo).join("|") : "";
	useEffect(() => {
		if (!projectKey) return;
		const repos = projectKey.split("|");
		if (!seen.current) {
			seen.current = new Set(repos);
			return;
		}
		const fresh = repos.find((r) => !seen.current!.has(r));
		repos.forEach((r) => seen.current!.add(r));
		if (fresh) setArrival({ repo: fresh, group: repos.indexOf(fresh), at: Date.now() });
	}, [projectKey]);
	useEffect(() => {
		if (!arrival) return;
		const timer = setTimeout(() => setArrival(null), ARRIVAL_MS);
		return () => clearTimeout(timer);
	}, [arrival]);
	// Bring the new group into view when it lands below (or above) what is on screen.
	useEffect(() => {
		if (!arrival) return;
		const top = fit.y + view.y + groupY(arrival.group) * s;
		const bottom = top + (LANE_BOTTOM - LANE_TOP) * s;
		if (top < PINNED || bottom > fit.h) setRawView((v) => ({ ...v, y: v.y + PINNED + 12 - top }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [arrival?.at]);

	const shown = arrival && live ? welcome(live, arrival.repo, arrival.group) : live ?? scene;
	const [carry, setCarry] = useState<{ role: SwarmRole; card: string; say: string }[]>([]);
	const lanesSeen = useRef<Map<string, { lane: Lane; id: string }> | null>(null);
	// The dispatcher's errands: label changes it carries out, one card at a time.
	const errands = useRef<{ card: string; say: string }[]>([]);
	const errandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const nextErrand = () => {
		const errand = errands.current.shift();
		setCarry((c) => [...c.filter((x) => x.role !== "dispatcher"), ...(errand ? [{ role: "dispatcher" as const, ...errand }] : [])]);
		errandTimer.current = errand ? setTimeout(nextErrand, 2600) : null;
	};
	useEffect(() => () => {
		if (errandTimer.current) clearTimeout(errandTimer.current);
	}, []);
	useEffect(() => {
		// Only the live board: the demo moves its own cards with its own cursors.
		if (!state) return;
		const now = new Map(shown.cards.filter((c) => c.repo && c.kind !== "doc").map((c) => [itemKey(c.repo!, c.number), { lane: c.lane, id: c.id }]));
		const before = lanesSeen.current;
		lanesSeen.current = now;
		if (!before) return;
		const own: { role: SwarmRole; card: string; say: string }[] = [];
		for (const [key, { lane, id }] of now) {
			const was = before.get(key);
			if (!was || was.lane === lane) continue;
			const say = `moving #${key.split("#")[1]} → ${LANE_WORD[lane]}`;
			// The agent that worked on this card and tagged the next one carries it (the planner its new issues, the
			// prover its PR to review, the reviewer to approved); a move no agent made is the dispatcher acting on a label.
			const [repo, number] = [key.slice(0, key.lastIndexOf("#")), Number(key.split("#")[1])];
			const home = state.runs.find((r) => r.note && r.note.repo === repo && r.note.ref === number)?.note?.role;
			const worker = state.active?.find((a) => a.repo === repo && a.ref === number)?.role
				?? (lane === "todo" ? state.active?.find((a) => a.repo === repo && a.role === "planner")?.role : undefined)
				?? home;
			if (worker && !own.some((o) => o.role === worker)) own.push({ role: worker, card: id, say });
			else errands.current.push({ card: id, say });
		}
		if (own.length) {
			setCarry((c) => [...c.filter((x) => !own.some((o) => o.role === x.role)), ...own]);
			// Not cleaned up on the next refresh: a carry always ends, even if the board updates meanwhile.
			setTimeout(() => setCarry((c) => c.filter((x) => !own.includes(x))), 3200);
		}
		if (errands.current.length && !errandTimer.current) nextErrand();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shown.cards]);

	// Cards grow to fit their label and title; the board stacks them on what they measure.
	const [heights, setHeights] = useState(() => new Map<string, number>());
	const measure = (id: string, h: number) =>
		setHeights((prev) => (prev.get(id) === h ? prev : new Map(prev).set(id, h)));
	const positions = layout(shown.cards, heights);

	// Real issues and PRs behind the cards, for hover cards and links (replay-only cards have none).
	const items = new Map<string, SwarmItem>([...(state?.work ?? []), ...(state?.merged ?? [])].map((item) => [itemKey(itemRepo(state!, item), item.number), item]));
	const itemFor = (card: Card) =>
		card.kind === "doc" ? undefined
		// The landing demo has no live data: its cards preview as the issues they stand for.
		: !state && !fill ? demoItem(card)
		: !card.repo ? undefined
		: items.get(itemKey(card.repo, card.number));

	const showHover = (card: Card, el: HTMLElement) => {
		const item = itemFor(card);
		const wrap = wrapRef.current;
		if (!item || !wrap) return;
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = setTimeout(() => {
			const box = el.getBoundingClientRect();
			const frame = wrap.getBoundingClientRect();
			const below = box.top - frame.top < 200;
			setHover({
				item,
				left: Math.min(Math.max(box.left - frame.left, 0), Math.max(frame.width - 320, 0)),
				top: below ? box.bottom - frame.top + 6 : box.top - frame.top - 6,
				below,
			});
		}, 200);
	};
	const hideHover = () => {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = setTimeout(() => setHover(null), 120);
	};
	const keepHover = () => {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
	};
	// Several cursors can stand at one card (a role waiting to answer next to the one working).
	// The turn holder takes the usual spot; the others wait at the card's left edge.
	const waiting = new Map<SwarmRole, number>();
	for (const role of ROLES) {
		const follow = shown.cursors[role].follow;
		if (!follow || role === shown.turn) continue;
		const sharing = ROLES.filter((r) => shown.cursors[r].follow === follow && (r === shown.turn || ROLES.indexOf(r) < ROLES.indexOf(role)));
		if (sharing.length) waiting.set(role, sharing.length);
	}
	// Who just moved a card carries it: the agent rides along to the new column with a word, then goes back to work.
	const cursorOf = (role: SwarmRole): Cursor => {
		const c = carry.find((x) => x.role === role);
		return c && shown.cards.some((card) => card.id === c.card) ? { follow: c.card, say: c.say } : shown.cursors[role];
	};
	const cursorPos = (role: SwarmRole) => {
		// The assistant is yours: while your pointer is on the board it keeps you company, a step behind.
		const cursor = cursorOf(role);
		const p = cursor.follow ? positions.get(cursor.follow) : undefined;
		if (!p) return { ...(cursor.at ?? { x: 0, y: 0 }), side: undefined };
		const slot = waiting.get(role);
		return slot ? { x: p.x + 14, y: p.y + 60 + (slot - 1) * 56, side: "left" as const } : { x: p.x + CARD_W - 28, y: p.y + 46, side: undefined };
	};

	const details = (inDialog: boolean) =>
		modal ? <CardDetails card={modal.card} item={itemFor(modal.card)} inDialog={inDialog} /> : null;

	return (
		<div ref={wrapRef} className={`relative w-full ${fill ? "h-full" : contain ? "flex h-full items-center justify-center" : ""}`}>
		{/* Contained, the controls must sit on the board-sized frame, not on the space around it. */}
		<div className={contain && !fill ? "relative" : "contents"}>
			<div
				ref={frameRef}
				className={`relative overflow-hidden bg-card ${contain && !fill ? "" : "w-full"} ${fill ? `h-full touch-none select-none ${panning ? "cursor-grabbing [&_*]:!cursor-grabbing" : panMode ? "cursor-grab [&_*]:!cursor-grab" : ""}` : `rounded-xl border ${contain ? "shrink-0" : ""}`}`}
				style={
					fill
						? { ...DOTS, backgroundSize: `${20 * s}px ${20 * s}px`, backgroundPosition: `${ox}px ${oy}px` }
						: contain
							? { width: W * scale, height: boardH * scale }
							: { height: boardH * scale }
				}
				onPointerDown={onPointerDown}
				onPointerMove={(e) => {
					onPointerMove(e);
					followPointer(e);
				}}
				onPointerLeave={releaseAssistant}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onLostPointerCapture={endDrag}
				onClickCapture={(e) => {
					if (drag.current?.moved) {
						e.preventDefault();
						e.stopPropagation();
					}
				}}
			>
				<div
					className="absolute left-0 top-0 origin-top-left"
					style={{
						width: W,
						height: boardH,
						transform: `translate(${ox}px, ${oy}px) scale(${s})`,
						...(fill ? {} : DOTS),
					}}
				>
					{fill ? null : (
						<>
							<DispatcherChip job={shown.job} />
							<TurnChip turn={shown.turn} />
						</>
					)}

					{Array.from({ length: groups }, (_, group) => (
						<div key={group} className="contents">
							{fill ? <ProjectHeader project={projects[group]} group={group} state={state} /> : null}
							{LANES.map((lane) => (
								<div
									key={lane.key}
									className="absolute rounded-lg border border-dashed bg-muted/40 animate-in fade-in-0 duration-700"
									style={{ left: laneX(lane.key), top: groupY(group) + LANE_TOP, width: LANE_W, height: LANE_BOTTOM - LANE_TOP }}
								>
									<div className="flex items-center justify-between px-3 pt-2.5 font-mono text-[12px] font-medium text-muted-foreground">
										<span>{lane.title}</span>
										<span>{shown.cards.filter((c) => c.group === group && c.lane === lane.key).length}</span>
									</div>
								</div>
							))}
						</div>
					))}

					{shown.cards.map((c) => {
						const p = positions.get(c.id)!;
						const item = itemFor(c);
						return (
							<BoardCard
								key={c.id}
								card={c}
								x={p.x}
								y={p.y}
								hidden={p.hidden}
								href={item?.url}
								onEnter={(el) => showHover(c, el)}
								onLeave={hideHover}
								onOpen={fill ? (el) => open(c, el) : undefined}
								onMeasure={(h) => measure(c.id, h)}
							/>
						);
					})}

					<LedgerPanel spend={shown.spend} costs={shown.costs} repo={state?.repo ?? repo} top={geo.panelTop} onMeasure={measurePanel(0)} />
					<NotebookPanel notes={shown.notes} repo={state?.repo ?? repo} top={geo.panelTop} onMeasure={measurePanel(1)} />
					<ChiefPanel headline={shown.chief} repo={state?.repo ?? repo} top={geo.panelTop} onMeasure={measurePanel(2)} />

					{ROLES.map((role, i) => (
						<SwarmCursor
							key={role}
							role={role}
							{...cursorPos(role)}
							say={cursorOf(role).say}
							thinking={cursorOf(role).thinking}
							where={cursorOf(role).where}
							until={cursorOf(role).until}
							// The issue or PR in the bubble previews like its card on the board.
							onWhereEnter={(el, id) => {
								const c = shown.cards.find((card) => card.id === id);
								if (c) showHover(c, el);
							}}
							onWhereLeave={hideHover}
							turn={shown.turn === role}
							// Arriving at a new project they come in one after another, not as a block.
							delay={arrival ? i * 120 : 0}
							onTalk={onTalk}
						/>
					))}
				</div>
			</div>
			{isMobile ? (
				<BottomIsland open={modal !== null} onClose={() => setModal(null)}>
					{details(true)}
				</BottomIsland>
			) : modal?.anchor ? (
				<div
					ref={popoverRef}
					role="dialog"
					aria-label={modal.card.title}
					data-canvas-ui
					// The island's look in the board's units: compact type and spacing, scaled with the board.
					className="absolute z-40 flex max-h-[min(60vh,420px)] flex-col rounded-2xl border border-black/5 bg-background p-3 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.28)] animate-in fade-in-0 duration-200 dark:border-white/10"
					style={{
						width: POPOVER_W,
						left: modal.anchor.left,
						top: modal.anchor.top,
						// Drawn at the board's own zoom, so its type and spacing match the cards around it.
						transform: `${modal.anchor.below ? "" : "translateY(-100%) "}scale(${scale * view.k})`,
						transformOrigin: modal.anchor.below ? "top left" : "bottom left",
					}}
				>
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => setModal(null)}
							className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:bg-muted"
							aria-label="Close"
						>
							<X className="size-3.5" />
						</button>
					</div>
					<div className="no-scrollbar mt-2.5 min-h-0 overflow-y-auto">{details(false)}</div>
				</div>
			) : null}
			{hover ? (
				<ItemHoverCard {...hover} onEnter={keepHover} onLeave={hideHover} />
			) : null}
			{fill && !local ? (
				<div className="pointer-events-none absolute inset-x-3 top-14 flex">
					<div className="pointer-events-auto flex min-w-0 max-w-full">
						<NowChip job={shown.job} turn={shown.turn} />
					</div>
				</div>
			) : null}
			{title ? <div className="absolute left-3 top-3 flex min-w-0 max-w-[calc(100%-14rem)] items-center gap-2">{title}</div> : null}
			<div className="absolute right-3 top-3 flex items-center gap-2">
			{actions}
			{fill || local ? null : (
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					className="inline-flex size-8 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
					aria-label={playing ? "Pause replay" : "Play replay"}
					title={playing ? "Pause replay" : "Play replay"}
				>
					{playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
				</button>
			)}
			</div>
			{fill ? (
				<div data-canvas-ui className="absolute right-3 top-14 z-10 flex h-8 items-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur">
					<button
						type="button"
						onClick={() => setHand((on) => !on)}
						aria-pressed={hand}
						className={`flex size-8 items-center justify-center rounded-full border-r transition-colors ${hand ? "bg-foreground text-background" : "hover:text-foreground"}`}
						aria-label="Hand tool"
						title={hand ? "Hand tool on: drag to move the canvas (V to leave)" : "Hand tool (H), or hold Space and drag"}
					>
						<Hand className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={toggleFollow}
						aria-pressed={followPref}
						className={`flex size-8 items-center justify-center rounded-full border-r transition-colors ${followPref ? "bg-foreground text-background" : "hover:text-foreground"}`}
						aria-label="Assistant follows your pointer"
						title={followPref ? "The assistant follows your pointer (click to stop)" : "Have the assistant follow your pointer"}
					>
						<MousePointer2 className="size-3.5" />
					</button>
					<button type="button" onClick={() => zoomCentre(1 / 1.25)} className="flex size-8 items-center justify-center rounded-full transition-colors hover:text-foreground" aria-label="Zoom out" title="Zoom out">
						<Minus className="size-3.5" />
					</button>
					<span className="w-10 text-center text-xs tabular-nums">{Math.round(view.k * 100)}%</span>
					<button type="button" onClick={() => zoomCentre(1.25)} className="flex size-8 items-center justify-center rounded-full transition-colors hover:text-foreground" aria-label="Zoom in" title="Zoom in">
						<Plus className="size-3.5" />
					</button>
					<button type="button" onClick={() => setRawView({ k: 1, x: 0, y: 0 })} className="flex size-8 items-center justify-center rounded-full border-l transition-colors hover:text-foreground" aria-label="Fit to screen" title="Fit to screen">
						<Maximize className="size-3.5" />
					</button>
				</div>
			) : null}
		</div>
		</div>
	);
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

/** Height kept clear above the board in fill mode for the pinned controls and the dispatcher row under them. */
const PINNED = 100;

const DOTS = { backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)", backgroundSize: "20px 20px" };

/**
 * Apple-style bottom island: a card floating just above the bottom edge that slides up on the iOS sheet curve,
 * with a round close button top-left.
 * It is not modal: the board stays usable, a click on another card or panel swaps what it shows, and a click
 * on empty canvas or Escape closes it.
 */
function BottomIsland({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()} modal={false}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Content
					aria-describedby={undefined}
					// Keep focus on the board so clicking from card to card feels like browsing, not opening dialogs.
					onOpenAutoFocus={(e) => e.preventDefault()}
					onInteractOutside={(e) => {
						if ((e.target as HTMLElement | null)?.closest("[data-component], [data-canvas-ui]")) e.preventDefault();
					}}
					className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-h-[80vh] max-w-lg flex-col rounded-[2rem] border border-black/5 bg-background p-5 shadow-[0_-8px_40px_-12px_rgba(0,0,0,0.25)] duration-500 [animation-timing-function:cubic-bezier(0.32,0.72,0,1)] focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=closed]:slide-out-to-bottom-[110%] data-[state=open]:slide-in-from-bottom-[110%] dark:border-white/10 sm:bottom-4"
				>
					<div className="flex items-center gap-3">
						<DialogPrimitive.Close className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<X className="size-[18px]" />
							<span className="sr-only">Close</span>
						</DialogPrimitive.Close>
					</div>
					<div className="no-scrollbar mt-4 min-h-0 overflow-y-auto">{children}</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

type Anchor = { left: number; top: number; below: boolean };
const POPOVER_W = 300;


/** Modal body for a clicked card: the real issue or PR when there is one, else what the replay card stands for. */
function CardDetails({ card, item, inDialog }: { card: Card; item?: SwarmItem; inDialog: boolean }) {
	// Inside the phone island the title must be the dialog's; in the desktop popover it is a plain heading.
	const Title = inDialog ? DialogPrimitive.Title : "h3";
	if (!item) {
		return (
			<div>
				<span className={`rounded px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[card.label] ?? LABEL_STYLES.README}`}>{card.label}</span>
				<Title className={`mt-2 font-semibold leading-snug ${inDialog ? "text-lg" : "text-sm"}`}>{card.title}</Title>
				<p className={`mt-1 text-muted-foreground ${inDialog ? "text-sm" : "text-xs leading-5"}`}>
					{card.kind === "doc" ? card.detail ?? "The roadmap in the proofs repo's .formal/plan.md." : "A card in the replay; it stands in for an issue and links nowhere."}
				</p>
				{card.href ? <OpenOnGitHub href={card.href} inDialog={inDialog} /> : null}
			</div>
		);
	}
	return (
		<>
			{inDialog ? <DialogPrimitive.Title className="sr-only">{item.title}</DialogPrimitive.Title> : null}
			<ItemPreview item={item} full />
			<OpenOnGitHub href={item.url} inDialog={inDialog} />
		</>
	);
}

function OpenOnGitHub({ href, inDialog }: { href: string; inDialog: boolean }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={`flex items-center justify-center rounded-full bg-foreground font-semibold text-background transition-opacity hover:opacity-90 ${inDialog ? "mt-5 h-12 w-full text-sm" : "mt-3 h-8 w-fit px-3 text-xs"}`}
		>
			Open on GitHub
		</a>
	);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A project's name over its lanes, linking to its pages, with what the swarm has of it. */
function ProjectHeader({ project, group, state }: { project: SwarmProject; group: number; state: SwarmState | null }) {
	const repo = project.proofsRepo;
	const work = repo ? (state?.work ?? []).filter((item) => itemRepo(state!, item) === repo) : [];
	const today = state ? localDay(state.fetchedAt) : "";
	const spent = repo ? (state?.costs ?? []).filter((c) => (c.repo ?? state!.repo) === repo && localDay(c.createdAt) === today).reduce((sum, c) => sum + c.usd, 0) : 0;
	const summary = !repo
		? "no proofs repository yet"
		: !project.inSwarm
			? `${repo} · not swept by the swarm yet`
			: `${repo} · ${count(work.filter((i) => i.kind === "issue").length, "issue")} · ${count(work.filter((i) => i.kind === "pr").length, "PR")} · $${spent.toFixed(2)} today`;
	return (
		<div data-component className="absolute flex items-baseline gap-2 whitespace-nowrap text-[13px]" style={{ left: PAD, top: groupY(group) + 28 }}>
			<Link to={`/projects/${project.repo}`} className="text-foreground underline-offset-2 hover:underline">
				{project.repo}
			</Link>
			<span className="text-muted-foreground">{summary}</span>
		</div>
	);
}

const MOVE = "transition-transform duration-700 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

/** Every role's cursor stays at full strength; the turn pill says who is working. */
/** `onTalk` makes the name pill a button that opens a chat with this agent. */
export function SwarmCursor({ role, x, y, say, turn, thinking, where, onWhereEnter, onWhereLeave, until, side, delay = 0, onTalk }: {
	role: SwarmRole;
	x: number;
	y: number;
	say?: string;
	turn: boolean;
	thinking?: boolean;
	/** The issue or PR a working agent is on, linked after its words. */
	where?: { text: string; card?: string; href: string };
	onWhereEnter?: (el: HTMLElement, card: string) => void;
	onWhereLeave?: () => void;
	/** Counts down to this time after the words, e.g. "next sweep in 4:12". */
	until?: number;
	side?: "left";
	delay?: number;
	onTalk?: (role: SwarmRole) => void;
}) {
	const color = ROLE_COLORS[role];
	// Near the right edge, or when waiting beside another cursor, the label and bubble open to the left.
	const flip = side === "left" || x > W - 260;
	return (
		<div
			data-cursor={role}
			className={`pointer-events-none absolute left-0 top-0 z-20 ${MOVE}`}
			style={{ transform: `translate(${x}px, ${y}px)`, transitionProperty: "transform", transitionDelay: `${delay}ms` }}
		>
			<div className="relative">
			<svg width="28" height="28" viewBox="0 0 24 24" className="absolute -left-2 -top-[5px] drop-shadow-sm" aria-hidden>
				<polygon points="7 20 7 4 19 16 12 16 7 21" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
			</svg>
			<div className={`absolute top-5 flex flex-col gap-1 ${flip ? "right-1 items-end" : "left-4 items-start"}`}>
				{/* The arrow lets clicks through; the pill and bubble take them, so what you see is what you point at. */}
				{(() => {
					const pill = (
						<>
							{turn ? <span className="size-1.5 animate-pulse rounded-full bg-white" aria-hidden /> : null}
							{role}
							{/* Working right now: a small spinner by the name. */}
							{thinking ? <span className="size-2 animate-spin rounded-full border border-white/25 border-t-white/80 [animation-duration:1.4s] motion-reduce:animate-none" aria-label="working" /> : null}
							{turn ? <span className="font-normal opacity-80">· turn</span> : null}
						</>
					);
					const style = { backgroundColor: color };
					const cls = "pointer-events-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium text-white shadow-sm";
					return onTalk ? (
						<button type="button" data-component onClick={() => onTalk(role)} title={`Talk to the ${role}`} aria-label={`Talk to the ${role}`} className={`${cls} cursor-pointer transition-transform hover:scale-105 active:scale-95`} style={style}>
							{pill}
						</button>
					) : (
						<span className={`${cls} cursor-default`} style={style}>{pill}</span>
					);
				})()}
				{say ? (
					<span key={say} className="pointer-events-auto w-max max-w-[240px] cursor-default rounded-lg border bg-popover px-2.5 py-1.5 text-[13px] leading-snug text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 duration-200">
						{thinking ? <span className="fm-dots mr-1.5 inline-flex gap-[3px] align-middle" aria-hidden><i /><i /><i /></span> : null}
						{say}
						{until ? <> <Countdown to={until} /></> : null}
						{where ? (
							<>
								{" · "}
								<a
									href={where.href}
									target="_blank"
									rel="noreferrer"
									className="font-mono underline-offset-2 hover:underline"
									onMouseEnter={(e) => where.card && onWhereEnter?.(e.currentTarget, where.card)}
									onMouseLeave={() => onWhereLeave?.()}
								>
									{where.text}
								</a>
							</>
						) : null}
					</span>
				) : null}
			</div>
			</div>
		</div>
	);
}

/** With `onOpen` the card is a button that opens its details; otherwise it links out and previews on hover. */
function BoardCard({ card, x, y, hidden, href, onEnter, onLeave, onOpen, onMeasure }: {
	card: Card;
	x: number;
	y: number;
	hidden: boolean;
	href?: string;
	onEnter: (el: HTMLElement) => void;
	onLeave: () => void;
	onOpen?: (el: HTMLElement) => void;
	onMeasure: (height: number) => void;
}) {
	const Tag = onOpen ? "button" : href ? "a" : "div";
	const ref = useRef<HTMLElement>(null);
	const measureRef = useRef(onMeasure);
	measureRef.current = onMeasure;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		// offsetHeight is the card's own size, unaffected by the board's zoom.
		const observer = new ResizeObserver(() => measureRef.current(el.offsetHeight));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return (
		<Tag
			ref={ref as never}
			aria-hidden={hidden || undefined}
			tabIndex={hidden ? -1 : undefined}
			{...(onOpen
				? { type: "button" as const, onClick: (e: React.MouseEvent<HTMLElement>) => onOpen(e.currentTarget) }
				: {
						...(href ? { href, target: "_blank", rel: "noreferrer" } : {}),
						onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onEnter(e.currentTarget),
						onMouseLeave: onLeave,
						onFocus: (e: React.FocusEvent<HTMLElement>) => onEnter(e.currentTarget),
						onBlur: onLeave,
					})}
			data-component
			className={`absolute left-0 top-0 z-10 block rounded-lg border bg-background p-2.5 text-left shadow-sm ${MOVE} ${href || onOpen ? "cursor-pointer hover:border-foreground/30" : "cursor-default"}`}
			style={{
				width: CARD_W,
				minHeight: CARD_MIN_H,
				transform: `translate(${x}px, ${y}px)`,
				opacity: hidden ? 0 : 1,
				pointerEvents: hidden ? "none" : undefined,
				transitionProperty: "transform, opacity, border-color",
			}}
		>
			<div className="flex items-center gap-1.5 text-[12px]">
				{card.kind === "doc" ? null : <span className="font-mono text-muted-foreground">{card.kind === "pr" ? "PR" : "#"}{card.number}</span>}
				<span className={`rounded px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[card.label] ?? LABEL_STYLES.README}`}>{card.label}</span>
			</div>
			<p className="mt-1 text-[13px] leading-snug text-foreground">{card.title}</p>
		</Tag>
	);
}

function timeAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** GitHub-style preview of the issue or PR behind a board card. */
export function ItemHoverCard({ item, repo, left, top, below, onEnter, onLeave }: {
	item: SwarmItem;
	/** For items that don't name their repository. */
	repo?: string;
	left: number;
	top: number;
	below: boolean;
	onEnter: () => void;
	onLeave: () => void;
}) {
	return (
		<div
			role="tooltip"
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
			className="absolute z-30 w-[320px] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
			style={{ left, top, transform: below ? undefined : "translateY(-100%)" }}
		>
			<ItemPreview item={item} repo={repo} />
		</div>
	);
}

/** The issue or PR behind a card: state, title, excerpt, labels, author. `full` shows the whole excerpt. */
export function ItemPreview({ item, repo, full = false }: { item: SwarmItem; repo?: string; full?: boolean }) {
	const state = item.merged ? "merged" : item.state ?? "open";
	const stateColor = state === "open" ? "text-emerald-600 dark:text-emerald-400" : "text-violet-600 dark:text-violet-400";
	return (
		<div>
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span className={`font-medium ${stateColor}`}>{`${state[0].toUpperCase()}${state.slice(1)} ${item.kind === "pr" ? "PR" : "issue"}`}</span>
				<span>· {item.repo ?? repo}</span>
				<span>· {timeAgo(item.createdAt)}</span>
			</p>
			<a href={item.url} target="_blank" rel="noreferrer" className="mt-1.5 block text-sm font-semibold leading-snug hover:underline">
				{item.title} <span className="font-normal text-muted-foreground">#{item.number}</span>
			</a>
			{item.excerpt ? <p className={`mt-2 text-xs leading-5 text-muted-foreground ${full ? "whitespace-pre-line" : "line-clamp-3"}`}>{item.excerpt}</p> : null}
			{item.labels.length ? (
				<div className="mt-3 flex flex-wrap gap-1">
					{item.labels.map((label) => (
						<span key={label} className={`rounded px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[label] ?? LABEL_STYLES.README}`}>{label}</span>
					))}
				</div>
			) : null}
			<div className="mt-3 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
				{item.authorAvatar ? (
					<img src={`${item.authorAvatar}${item.authorAvatar.includes("?") ? "&" : "?"}s=40`} alt="" className="size-4 rounded-full" />
				) : null}
				<span className="font-medium text-foreground">{item.author}</span>
				<span>opened · {item.comments} comment{item.comments === 1 ? "" : "s"}</span>
			</div>
		</div>
	);
}

/** Whose turn it is; one role at a time, the way the workflow runs them. */
function TurnChip({ turn }: { turn: SwarmRole | null }) {
	return (
		<div
			className="absolute flex h-9 shrink-0 items-center gap-2 rounded-full border bg-background px-3 text-[13px] shadow-sm"
			style={{ right: 150, top: CHIP.y }}
		>
			<span className="text-muted-foreground">Turn</span>
			{turn ? (
				<span className="inline-flex items-center gap-1.5 font-medium">
					<span className="size-2 rounded-full" style={{ backgroundColor: ROLE_COLORS[turn] }} />
					{turn}
				</span>
			) : <span className="text-muted-foreground">between turns</span>}
		</div>
	);
}

/**
 * Pinned above the full-page board: the dispatcher's job and whose turn it is, in one line.
 * The full pick order is on hover.
 */
function NowChip({ job, turn }: { job: string | null; turn: SwarmRole | null }) {
	return (
		<div
			className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full border bg-background px-3 py-1.5 text-[12px] shadow-sm"
			title={`Every 10 min the dispatcher picks one job, in this order: ${JOBS.join(" › ")}`}
		>
			<span className="font-medium" style={{ color: ROLE_COLORS.dispatcher }}>dispatcher</span>
			<SmoothWidth>
				<TextSwap value={job}>
					{(j) => (j ? <span className="rounded bg-foreground px-1.5 py-px text-background">{j}</span> : <span className="text-muted-foreground">sweeps every 10 min</span>)}
				</TextSwap>
			</SmoothWidth>
			{/* On the dispatcher's own turn nothing follows its job. */}
			<SmoothWidth>
				<TextSwap value={turn}>
					{(t) =>
						t === "dispatcher" ? null : (
							<span className="inline-flex items-center gap-2">
								<span className="text-muted-foreground/50">›</span>
								{t ? (
									<span className="inline-flex items-center gap-1.5 font-medium">
										<span className="size-2 rounded-full" style={{ backgroundColor: ROLE_COLORS[t] }} />
										{t}
									</span>
								) : (
									<span className="text-muted-foreground">between turns</span>
								)}
							</span>
						)
					}
				</TextSwap>
			</SmoothWidth>
		</div>
	);
}

/** The job list with one pill that slides to the job in hand (transitions.dev tabs sliding). */
function DispatcherChip({ job }: { job: string | null }) {
	const items = useRef(new Map<string, HTMLSpanElement>());
	const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
	useLayoutEffect(() => {
		const el = job ? items.current.get(job) : undefined;
		setPill(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
	}, [job]);
	return (
		<div
			className="absolute flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border bg-background px-3 py-1.5 text-[12px] shadow-sm"
			style={{ left: CHIP.x, top: CHIP.y }}
		>
			<span
				aria-hidden
				className="absolute top-1/2 h-5 rounded bg-foreground motion-reduce:transition-none"
				style={{
					width: pill?.w ?? 0,
					transform: `translate(${pill?.x ?? 0}px, -50%)`,
					left: 0,
					opacity: pill ? 1 : 0,
					transition: "transform var(--tabs-dur) var(--tabs-ease), width var(--tabs-dur) var(--tabs-ease), opacity var(--tabs-dur) var(--tabs-ease)",
				}}
			/>
			<span className="font-medium" style={{ color: ROLE_COLORS.dispatcher }}>dispatcher</span>
			<span className="text-muted-foreground">every 10 min picks one job:</span>
			{JOBS.map((j, i) => (
				<span key={j} className="flex items-center gap-2">
					<span
						ref={(el) => {
							if (el) items.current.set(j, el);
						}}
						className={`relative rounded px-1.5 py-px ${job === j ? "text-background" : "text-muted-foreground"}`}
						style={{ transition: "color var(--tabs-dur) var(--tabs-ease)" }}
					>
						{j}
					</span>
					{i < JOBS.length - 1 ? <span className="text-muted-foreground/50">›</span> : null}
				</span>
			))}
		</div>
	);
}

/** Eases its width to whatever its content measures, so swapped text doesn't make the row snap. */
function SmoothWidth({ children }: { children: ReactNode }) {
	const inner = useRef<HTMLSpanElement>(null);
	const [width, setWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		const el = inner.current;
		if (!el) return;
		const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return (
		<span
			className="inline-flex shrink-0 overflow-hidden motion-reduce:transition-none"
			style={{ width: width ?? undefined, transition: "width var(--tabs-dur) var(--tabs-ease)" }}
		>
			<span ref={inner} className="inline-flex shrink-0 items-center">{children}</span>
		</span>
	);
}

type PanelMode = { repo?: string; top?: number; onMeasure?: (height: number) => void };

/** Read in place (its list scrolls); the title links to the issue the panel mirrors. */
/** With `onMeasure` the panel grows to fit its content (from PANEL_H up) and reports its height. */
function Panel({ index, title, repo, top = ONE.panelTop, onMeasure, children }: PanelMode & { index: number; title: string; children: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const measureRef = useRef(onMeasure);
	measureRef.current = onMeasure;
	const grows = Boolean(onMeasure);
	useEffect(() => {
		const el = ref.current;
		if (!el || !grows) return;
		const observer = new ResizeObserver(() => measureRef.current?.(el.offsetHeight));
		observer.observe(el);
		return () => observer.disconnect();
	}, [grows]);
	return (
		<div
			ref={ref}
			data-component
			className="absolute flex cursor-default flex-col rounded-lg border bg-background p-3"
			style={{ left: panelX(index), top, width: PANEL_W, ...(grows ? { minHeight: PANEL_H } : { height: PANEL_H }) }}
		>
			{repo ? (
				<a
					href={`https://github.com/${repo}/issues/${title.match(/^#(\d+)/)?.[1] ?? ""}`}
					target="_blank"
					rel="noreferrer"
					className="w-fit font-mono text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					{title}
				</a>
			) : (
				<p className="font-mono text-[12px] font-medium text-muted-foreground">{title}</p>
			)}
			<div className="mt-2 flex min-h-0 flex-1 flex-col">{children}</div>
		</div>
	);
}

function LedgerPanel({ spend, costs, ...mode }: PanelMode & { spend: number; costs: LedgerRow[] }) {
	return (
		<Panel index={0} title="#38 Ledger notebook" {...mode}>
			<div className="flex items-baseline justify-between text-[12px]">
				<span className="text-[13px] text-foreground">Spent today</span>
				<span className="font-mono tabular-nums text-foreground">${spend.toFixed(2)} / $5.00</span>
			</div>
			<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
				<div className="h-full rounded-full bg-foreground/70 transition-[width] duration-700" style={{ width: `${Math.min(100, (spend / 5) * 100)}%` }} />
			</div>
			<ul className="mt-2 space-y-0.5 font-mono text-[12px] text-muted-foreground">
				{costs.map((cost, i) => (
					<li key={`${i}-${cost.label}-${cost.usd}`} className="flex justify-between gap-3">
						<span style={cost.role ? { color: ROLE_COLORS[cost.role] } : undefined}>{cost.label}</span>
						<span className="tabular-nums">${cost.usd.toFixed(2)}</span>
					</li>
				))}
			</ul>
		</Panel>
	);
}

function NotebookPanel({ notes, ...mode }: PanelMode & { notes: Note[] }) {
	return (
		<Panel index={1} title="#55 Swarm notebook" {...mode}>
			<ul className="space-y-1 text-[13px]">
				{notes.length === 0 ? <li className="text-muted-foreground">Each run opens a task list here first.</li> : null}
				{notes.map((n, i) => (
					<li key={`${i}-${n.text}`} className="flex items-start gap-2">
						<span className={`mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${n.done ? "border-transparent text-white" : ""}`} style={n.done ? { backgroundColor: ROLE_COLORS[n.role] } : undefined}>
							{n.done ? "✓" : ""}
						</span>
						<span className={`min-w-0 ${n.done ? "text-muted-foreground line-through" : "text-foreground"}`}>
							<span style={{ color: ROLE_COLORS[n.role] }}>{n.role}</span> {n.text}
						</span>
					</li>
				))}
			</ul>
		</Panel>
	);
}

function ChiefPanel({ headline, ...mode }: PanelMode & { headline: string }) {
	return (
		<Panel index={2} title="#53 Chief notebook" {...mode}>
			<p className="text-[13px] text-muted-foreground">Daily at {CHIEF_TIME}, before the budget resets</p>
			<p className="mt-2 text-[14px] font-medium leading-snug text-foreground">{headline}</p>
		</Panel>
	);
}

/** m:ss to a time, ticking by itself so the board doesn't re-render every second. */
function Countdown({ to }: { to: number }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const left = Math.max(0, Math.round((to - now) / 1000));
	return <span className="font-mono tabular-nums">{left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "now"}</span>;
}
