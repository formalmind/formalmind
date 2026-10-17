"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Pause, Play, Plus } from "lucide-react";
import type { SwarmItem, SwarmRole, SwarmRun, SwarmState } from "@/lib/swarm";
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
const H = 580;

const ROLES = Object.keys(ROLE_COLORS) as SwarmRole[];

type Lane = "roadmap" | "todo" | "progress" | "review" | "approved" | "dev";

const LANES: { key: Lane; title: string }[] = [
	{ key: "roadmap", title: "Roadmap" },
	{ key: "todo", title: "fm:todo" },
	{ key: "progress", title: "fm:in-progress" },
	{ key: "review", title: "fm:review" },
	{ key: "approved", title: "fm:approved" },
	{ key: "dev", title: "Merged to dev" },
];

export const LABEL_STYLES: Record<string, string> = {
	"fm:todo": "bg-slate-500/15 text-slate-600 dark:text-slate-300",
	"fm:in-progress": "bg-blue-500/15 text-blue-600 dark:text-blue-300",
	"fm:review": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	"fm:changes": "bg-red-500/15 text-red-600 dark:text-red-300",
	"fm:approved": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	"fm:blocked": "bg-red-500/15 text-red-600 dark:text-red-300",
	"fm:needs-rebase": "bg-orange-500/15 text-orange-700 dark:text-orange-300",
	merged: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
	...Object.fromEntries(["planner", "prover", "reviewer", "merger", "chief"].map((r) => [`fm:ask-${r}`, "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300"])),
	README: "bg-muted text-muted-foreground",
};

const LANE_W = 176;
const LANE_GAP = 16;
const PAD = 24;
const LANE_TOP = 64;
const LANE_BOTTOM = 400;
const CARD_TOP = 100;
const CARD_STEP = 88;
const CARD_W = 160;
const PANEL_TOP = 420;
const PANEL_W = 368;
const PANEL_GAP = 24;
const CHIP = { x: PAD, y: 14 };

const laneX = (lane: Lane) => PAD + LANES.findIndex((l) => l.key === lane) * (LANE_W + LANE_GAP);
const panelX = (i: number) => PAD + i * (PANEL_W + PANEL_GAP);

type Card = {
	id: string;
	number: number;
	title: string;
	kind: "issue" | "pr" | "doc";
	lane: Lane;
	order: number;
	label: string;
	branch?: string;
};

type Cursor = { at?: { x: number; y: number }; follow?: string; say?: string };

type Note = { role: SwarmRole; text: string; done: boolean };

type Scene = {
	cards: Card[];
	cursors: Record<SwarmRole, Cursor>;
	spend: number;
	notes: Note[];
	chief: string;
	job: string | null;
	costs: { role: SwarmRole; usd: number }[];
	tick: number;
	/** The one role holding the turn; the others wait (dimmed) unless they have something to say. */
	turn: SwarmRole | null;
};

const HOME: Record<SwarmRole, { x: number; y: number }> = {
	dispatcher: { x: 640, y: 34 },
	planner: { x: 120, y: 360 },
	prover: { x: 330, y: 360 },
	reviewer: { x: 700, y: 360 },
	merger: { x: 900, y: 360 },
	chief: { x: 1080, y: 360 },
};

const ROADMAP_SPOT = { x: laneX("roadmap") + 120, y: CARD_TOP + 44 };
const CHIEF_SPOT = { x: panelX(2) + 300, y: PANEL_TOP + 70 };
const LEDGER_SPOT = { x: panelX(0) + 300, y: PANEL_TOP + 70 };
const NOTEBOOK_SPOT = { x: panelX(1) + 300, y: PANEL_TOP + 70 };
const JOBS = ["answer", "merge", "review", "revise", "resume", "new issue", "plan"];

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

function spend(scene: Scene, role: SwarmRole, usd: number) {
	scene.spend += usd;
	scene.costs = [...scene.costs, { role, usd }].slice(-3);
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
	const queue: Pick<SwarmItem, "number" | "title">[] = todo.slice(0, 2);
	const placeholders = ["spec: the next gap the planner queues", "spec: another roadmap item"];
	while (queue.length < 2) queue.push({ number: next++, title: placeholders[queue.length] });
	const merged = (state?.merged ?? []).slice(0, 2).reverse();
	let order = 0;
	const cards: Card[] = [
		{ id: "roadmap", number: 0, title: "Roadmap and unproven gaps in FORMAL_MIND.md", kind: "doc", lane: "roadmap", order: order++, label: "README" },
		...merged.map((item) => ({ id: `m${item.number}`, number: item.number, title: item.title, kind: "pr" as const, lane: "dev" as Lane, order: order++, label: "merged" })),
		...queue.map((item) => ({ id: `i${item.number}`, number: item.number, title: item.title, kind: "issue" as const, lane: "todo" as Lane, order: order++, label: "fm:todo" })),
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
		{ hold: 300, apply: (s) => { s.cards.push({ id: "new", number: next, title: "spec: next unproven gap from the changelog", kind: "issue", lane: "roadmap", order: s.tick++, label: "fm:todo" }); } },
		{ hold: 1800, apply: (s) => { move(s, "new", "todo"); say(s, "planner", `Wrote #${next}. Next: prover — #${next} first`, "new"); tick(s); spend(s, "planner", 0.3); } },
		{ hold: 2600, apply: (s) => { home(s, "planner"); s.job = null; s.chief = "Working: 1 merged, 2 queued, nothing waiting on you"; say(s, "chief", "Posted the daily update on #53. Next: @mmsaki — nothing needs you", CHIEF_SPOT); } },
		{ hold: 1600, apply: (s) => { home(s, "chief"); s.turn = null; } },
	];
}

const COST_ROLES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", review: "reviewer", merge: "merger", chief: "chief" };

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
		if (has("fm:blocked")) return { lane: "progress", label: "fm:blocked" };
		if (has("fm:todo")) return { lane: "todo", label: "fm:todo" };
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
	building: "lake build on the exact head",
	working: "Thinking…",
	"recording cost": "Recording the cost on the ledger",
};

/** The board as it really is, with the active run's role at the item it is working on. */
function liveScene(state: SwarmState, run: SwarmRun): Scene {
	let order = 0;
	const cards: Card[] = [
		{ id: "roadmap", number: 0, title: "Roadmap and unproven gaps in FORMAL_MIND.md", kind: "doc", lane: "roadmap", order: order++, label: "README" },
		...state.merged.slice(0, 2).reverse().map((item) => ({ id: `m${item.number}`, number: item.number, title: item.title, kind: "pr" as const, lane: "dev" as Lane, order: order++, label: "merged" })),
	];
	for (const item of [...state.work].sort((a, b) => a.number - b.number)) {
		const place = laneOf(item);
		if (place) cards.push({ id: `w${item.number}`, number: item.number, title: item.title, kind: item.kind, lane: place.lane, order: order++, label: place.label });
	}

	const note = run.note;
	const role: SwarmRole = note?.role ?? "dispatcher";
	const done = run.status === "completed";
	const current = note?.tasks.find((t) => !t.done && !t.dropped);
	const handoff = done ? note?.next : null;
	const say = clip(done
		? handoff ? `Next: ${handoff.to}${handoff.why ? ` — ${handoff.why}` : ""}` : note ? `Done${note.verified ? `: ${note.verified}` : ""}` : "Finished"
		: current?.text ?? (note && run.phase === "working" ? "Wrapping up" : PHASE_TEXT[run.phase]));

	const cursors = Object.fromEntries(ROLES.map((r) => [r, { at: HOME[r] }])) as Scene["cursors"];
	const target = cards.find((c) => c.number === note?.ref && c.kind !== "doc");
	const spot = role === "chief" || note?.ref === 53 ? CHIEF_SPOT
		: note?.ref === 38 ? LEDGER_SPOT
		: note?.ref === 55 ? NOTEBOOK_SPOT
		: role === "planner" ? ROADMAP_SPOT
		: undefined;
	cursors[role] = target ? { follow: target.id, say } : { at: spot ?? HOME[role], say };

	// Open questions: the asked role waits at the item until the dispatcher gives it the turn.
	for (const item of state.work) {
		const asked = askedOf(item);
		if (asked && asked !== role && cards.some((c) => c.id === `w${item.number}`)) {
			cursors[asked] = { follow: `w${item.number}`, say: `Asked on #${item.number}. I answer on my turn` };
		}
	}
	// The baton: once a run ends, the role it handed to steps up to the same item.
	const nextRole = handoff && (ROLES as string[]).includes(handoff.to) ? (handoff.to as SwarmRole) : null;
	if (nextRole && nextRole !== role && !cursors[nextRole].say) {
		cursors[nextRole] = target ? { follow: target.id, say: "My turn next" } : { at: HOME[nextRole], say: "My turn next" };
	}
	// The job comes from the item's job labels, not from a question label shown on the card.
	const targetItem = state.work.find((item) => item.number === note?.ref);
	const label = targetItem ? jobLaneOf(targetItem)?.label : target?.label;
	const answering = Boolean(note?.title.toLowerCase().startsWith("answer"));
	const job = answering ? "answer"
		: role === "merger" ? "merge"
		: role === "reviewer" ? "review"
		: role === "planner" ? "plan"
		: role === "prover" ? (label === "fm:changes" || label === "fm:needs-rebase" ? "revise" : label === "fm:in-progress" ? "resume" : "new issue")
		: null;

	return {
		cards,
		cursors,
		spend: state.spentToday,
		notes: (note?.tasks ?? []).slice(-4).map((t) => ({ role, text: t.text, done: t.done })),
		chief: firstLine(state.chief?.body) ?? "Working",
		job,
		costs: state.costs.slice(-3).map((c) => ({ role: COST_ROLES[c.role] ?? "dispatcher", usd: c.usd })),
		tick: order,
		turn: done ? nextRole ?? role : role,
	};
}

function layout(cards: Card[]) {
	const positions = new Map<string, { x: number; y: number; hidden: boolean }>();
	for (const lane of LANES) {
		const inLane = cards.filter((c) => c.lane === lane.key).sort((a, b) => b.order - a.order);
		inLane.forEach((c, i) => positions.set(c.id, { x: laneX(lane.key) + 8, y: CARD_TOP + i * CARD_STEP, hidden: i > 3 }));
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
export function SwarmCanvas({ state, highlight, fill = false, title, actions }: {
	state: SwarmState | null;
	highlight?: SwarmRole | null;
	fill?: boolean;
	title?: ReactNode;
	actions?: ReactNode;
}) {
	const frameRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState({ scale: 1, x: 0, y: 0 });
	const { scale } = fit;
	// In fill mode people can pan and zoom: `view` sits on top of the fitted placement.
	const [view, setView] = useState({ k: 1, x: 0, y: 0 });
	const [panning, setPanning] = useState(false);
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
	const live = state && run ? liveScene(state, run) : null;
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
		const el = frameRef.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => {
			const { width, height } = entry.contentRect;
			if (!fill) return setFit({ scale: width / W, x: 0, y: 0 });
			const next = Math.min(width / W, (height - PINNED) / H);
			setFit({ scale: next, x: (width - W * next) / 2, y: PINNED + Math.max(0, (height - PINNED - H * next) / 2) });
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [fill]);

	// Trackpad pinch and ctrl/cmd + wheel zoom at the pointer; a plain wheel or two-finger swipe pans.
	useEffect(() => {
		const el = frameRef.current;
		if (!el || !fill) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const box = el.getBoundingClientRect();
				zoomAtRef.current(Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top);
			} else {
				setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [fill]);

	// Press and drag anywhere to pan. The pointer is only captured once it moves,
	// so a plain click still reaches the card under it.
	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!fill || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
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

	const shown = live ?? scene;
	const positions = layout(shown.cards);

	// Real issues and PRs behind the cards, for hover cards and links (replay-only cards have none).
	const items = new Map<number, SwarmItem>([...(state?.work ?? []), ...(state?.merged ?? [])].map((item) => [item.number, item]));
	const itemFor = (card: Card) => (card.kind === "doc" || card.id === "new" ? undefined : items.get(card.number));

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
	const cursorPos = (role: SwarmRole) => {
		const cursor = shown.cursors[role];
		const p = cursor.follow ? positions.get(cursor.follow) : undefined;
		if (!p) return { ...(cursor.at ?? { x: 0, y: 0 }), side: undefined };
		const slot = waiting.get(role);
		return slot ? { x: p.x + 14, y: p.y + 60 + (slot - 1) * 56, side: "left" as const } : { x: p.x + CARD_W - 28, y: p.y + 46, side: undefined };
	};

	return (
		<div ref={wrapRef} className={`relative w-full ${fill ? "h-full" : ""}`}>
			<div
				ref={frameRef}
				className={`relative w-full overflow-hidden bg-card ${fill ? `h-full touch-none select-none ${panning ? "cursor-grabbing" : "cursor-grab"}` : "rounded-xl border"}`}
				style={fill ? { ...DOTS, backgroundSize: `${20 * s}px ${20 * s}px`, backgroundPosition: `${ox}px ${oy}px` } : { height: H * scale }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
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
						height: H,
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

					{LANES.map((lane) => (
						<div
							key={lane.key}
							className="absolute rounded-lg border border-dashed bg-muted/40"
							style={{ left: laneX(lane.key), top: LANE_TOP, width: LANE_W, height: LANE_BOTTOM - LANE_TOP }}
						>
							<div className="flex items-center justify-between px-3 pt-2.5 font-mono text-[12px] font-medium text-muted-foreground">
								<span>{lane.title}</span>
								<span>{shown.cards.filter((c) => c.lane === lane.key).length}</span>
							</div>
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
							/>
						);
					})}

					<LedgerPanel spend={shown.spend} costs={shown.costs} />
					<NotebookPanel notes={shown.notes} />
					<ChiefPanel headline={shown.chief} />

					{ROLES.map((role) => (
						<SwarmCursor
							key={role}
							role={role}
							{...cursorPos(role)}
							say={shown.cursors[role].say}
							turn={shown.turn === role}
							dim={highlight ? highlight !== role : Boolean(shown.turn && shown.turn !== role && !shown.cursors[role].say)}
						/>
					))}
				</div>
			</div>
			{hover ? (
				<ItemHoverCard {...hover} repo={state?.repo ?? ""} onEnter={keepHover} onLeave={hideHover} />
			) : null}
			{fill ? (
				<div className="pointer-events-none absolute inset-x-3 top-14 flex items-center justify-between gap-2 overflow-hidden">
					<DispatcherChip job={shown.job} pinned />
					<TurnChip turn={shown.turn} pinned />
				</div>
			) : null}
			{title ? <div className="absolute left-3 top-3 flex min-w-0 max-w-[calc(100%-14rem)] items-center">{title}</div> : null}
			<div className="absolute right-3 top-3 flex items-center gap-2">
			{actions}
			{live && run ? (
				<a
					href={run.url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex h-8 items-center gap-2 rounded-full border bg-background/90 px-3 text-xs font-medium shadow-sm backdrop-blur"
				>
					<span className={`size-2 rounded-full ${run.status === "completed" ? "bg-muted-foreground" : "animate-pulse bg-red-500"}`} />
					{run.status === "completed" ? "Just finished" : "Live"}
				</a>
			) : (
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
				<div className="absolute bottom-3 right-3 flex h-8 items-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur">
					<button type="button" onClick={() => zoomCentre(1 / 1.25)} className="flex size-8 items-center justify-center rounded-full transition-colors hover:text-foreground" aria-label="Zoom out" title="Zoom out">
						<Minus className="size-3.5" />
					</button>
					<span className="w-10 text-center text-xs tabular-nums">{Math.round(view.k * 100)}%</span>
					<button type="button" onClick={() => zoomCentre(1.25)} className="flex size-8 items-center justify-center rounded-full transition-colors hover:text-foreground" aria-label="Zoom in" title="Zoom in">
						<Plus className="size-3.5" />
					</button>
					<button type="button" onClick={() => setView({ k: 1, x: 0, y: 0 })} className="flex size-8 items-center justify-center rounded-full border-l transition-colors hover:text-foreground" aria-label="Fit to screen" title="Fit to screen">
						<Maximize className="size-3.5" />
					</button>
				</div>
			) : null}
		</div>
	);
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

/** Height kept clear above the board in fill mode for the pinned controls and the dispatcher row under them. */
const PINNED = 100;

const DOTS = { backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)", backgroundSize: "20px 20px" };

const MOVE = "transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

export function SwarmCursor({ role, x, y, say, dim, turn, side }: { role: SwarmRole; x: number; y: number; say?: string; dim: boolean; turn: boolean; side?: "left" }) {
	const color = ROLE_COLORS[role];
	// Near the right edge, or when waiting beside another cursor, the label and bubble open to the left.
	const flip = side === "left" || x > W - 260;
	return (
		<div
			className={`pointer-events-none absolute left-0 top-0 z-20 ${MOVE}`}
			style={{ transform: `translate(${x}px, ${y}px)`, opacity: dim ? 0.35 : 1, transitionProperty: "transform, opacity" }}
		>
			<svg width="28" height="28" viewBox="0 0 24 24" className="absolute -left-2 -top-[5px] drop-shadow-sm" aria-hidden>
				<polygon points="7 20 7 4 19 16 12 16 7 21" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
			</svg>
			<div className={`absolute top-5 flex flex-col gap-1 ${flip ? "right-1 items-end" : "left-4 items-start"}`}>
				<span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium text-white shadow-sm" style={{ backgroundColor: color }}>
					{turn ? <span className="size-1.5 animate-pulse rounded-full bg-white" aria-hidden /> : null}
					{role}
					{turn ? <span className="font-normal opacity-80">· turn</span> : null}
				</span>
				{say ? (
					<span key={say} className="w-max max-w-[240px] rounded-lg border bg-popover px-2.5 py-1.5 text-[13px] leading-snug text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 duration-200">
						{say}
					</span>
				) : null}
			</div>
		</div>
	);
}

function BoardCard({ card, x, y, hidden, href, onEnter, onLeave }: {
	card: Card;
	x: number;
	y: number;
	hidden: boolean;
	href?: string;
	onEnter: (el: HTMLElement) => void;
	onLeave: () => void;
}) {
	const Tag = href ? "a" : "div";
	return (
		<Tag
			{...(href ? { href, target: "_blank", rel: "noreferrer" } : {})}
			onMouseEnter={(e: React.MouseEvent<HTMLElement>) => onEnter(e.currentTarget)}
			onMouseLeave={onLeave}
			onFocus={(e: React.FocusEvent<HTMLElement>) => onEnter(e.currentTarget)}
			onBlur={onLeave}
			className={`absolute left-0 top-0 z-10 block rounded-lg border bg-background p-2.5 shadow-sm ${MOVE} ${href ? "cursor-pointer hover:border-foreground/30" : ""}`}
			style={{ width: CARD_W, height: 78, transform: `translate(${x}px, ${y}px)`, opacity: hidden ? 0 : 1, transitionProperty: "transform, opacity, border-color" }}
		>
			<div className="flex items-center gap-1.5 text-[12px]">
				{card.kind === "doc" ? null : <span className="font-mono text-muted-foreground">{card.kind === "pr" ? "PR" : "#"}{card.number}</span>}
				<span className={`rounded px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[card.label] ?? LABEL_STYLES.README}`}>{card.label}</span>
			</div>
			<p className="mt-1 line-clamp-2 text-[13px] leading-snug text-foreground">{card.title}</p>
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
	repo: string;
	left: number;
	top: number;
	below: boolean;
	onEnter: () => void;
	onLeave: () => void;
}) {
	const state = item.merged ? "merged" : item.state ?? "open";
	const stateColor = state === "open" ? "text-emerald-600 dark:text-emerald-400" : "text-violet-600 dark:text-violet-400";
	return (
		<div
			role="tooltip"
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
			className="absolute z-30 w-[320px] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
			style={{ left, top, transform: below ? undefined : "translateY(-100%)" }}
		>
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span className={`font-medium ${stateColor}`}>{`${state[0].toUpperCase()}${state.slice(1)} ${item.kind === "pr" ? "PR" : "issue"}`}</span>
				<span>· {repo}</span>
				<span>· {timeAgo(item.createdAt)}</span>
			</p>
			<a href={item.url} target="_blank" rel="noreferrer" className="mt-1.5 block text-sm font-semibold leading-snug hover:underline">
				{item.title} <span className="font-normal text-muted-foreground">#{item.number}</span>
			</a>
			{item.excerpt ? <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.excerpt}</p> : null}
			{item.labels.length ? (
				<div className="mt-3 flex flex-wrap gap-1">
					{item.labels.map((label) => (
						<span key={label} className={`rounded px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[label] ?? LABEL_STYLES.README}`}>{label}</span>
					))}
				</div>
			) : null}
			<div className="mt-3 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
				{item.authorAvatar ? (
					// eslint-disable-next-line @next/next/no-img-element -- tiny GitHub avatar, not worth the image optimizer
					<img src={`${item.authorAvatar}${item.authorAvatar.includes("?") ? "&" : "?"}s=40`} alt="" className="size-4 rounded-full" />
				) : null}
				<span className="font-medium text-foreground">{item.author}</span>
				<span>opened · {item.comments} comment{item.comments === 1 ? "" : "s"}</span>
			</div>
		</div>
	);
}

/** Whose turn it is; one role at a time, the way the workflow runs them. */
/** `pinned` drops the board position so the chip can sit in the fixed row above a pannable board. */
function TurnChip({ turn, pinned = false }: { turn: SwarmRole | null; pinned?: boolean }) {
	return (
		<div
			className={`${pinned ? "" : "absolute"} flex h-9 shrink-0 items-center gap-2 rounded-full border bg-background px-3 text-[13px] shadow-sm`}
			style={pinned ? undefined : { right: 150, top: CHIP.y }}
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

function DispatcherChip({ job, pinned = false }: { job: string | null; pinned?: boolean }) {
	return (
		<div
			className={`${pinned ? "min-w-0 overflow-hidden" : "absolute shrink-0"} flex items-center gap-2 whitespace-nowrap rounded-full border bg-background px-3 py-1.5 text-[12px] shadow-sm`}
			style={pinned ? undefined : { left: CHIP.x, top: CHIP.y }}
		>
			<span className="font-medium" style={{ color: ROLE_COLORS.dispatcher }}>dispatcher</span>
			<span className={`text-muted-foreground ${pinned ? "hidden xl:inline" : ""}`}>every 30 min picks one job:</span>
			{JOBS.map((j, i) => (
				<span key={j} className="flex items-center gap-2">
					<span className={`rounded px-1.5 py-px transition-colors ${job === j ? "bg-foreground text-background" : "text-muted-foreground"}`}>{j}</span>
					{i < JOBS.length - 1 ? <span className="text-muted-foreground/50">›</span> : null}
				</span>
			))}
		</div>
	);
}

function Panel({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
	return (
		<div className="absolute rounded-lg border bg-background p-3" style={{ left: panelX(index), top: PANEL_TOP, width: PANEL_W, height: 136 }}>
			<p className="font-mono text-[12px] font-medium text-muted-foreground">{title}</p>
			<div className="mt-2">{children}</div>
		</div>
	);
}

function LedgerPanel({ spend, costs }: { spend: number; costs: { role: SwarmRole; usd: number }[] }) {
	return (
		<Panel index={0} title="#38 ledger">
			<div className="flex items-baseline justify-between text-[12px]">
				<span className="text-[13px] text-foreground">Spent today</span>
				<span className="font-mono tabular-nums text-foreground">${spend.toFixed(2)} / $5.00</span>
			</div>
			<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
				<div className="h-full rounded-full bg-foreground/70 transition-[width] duration-700" style={{ width: `${Math.min(100, (spend / 5) * 100)}%` }} />
			</div>
			<ul className="mt-2 space-y-0.5 font-mono text-[12px] text-muted-foreground">
				{costs.map((cost, i) => (
					<li key={`${i}-${cost.role}-${cost.usd}`} className="flex justify-between">
						<span style={{ color: ROLE_COLORS[cost.role] }}>{cost.role}</span>
						<span className="tabular-nums">${cost.usd.toFixed(2)}</span>
					</li>
				))}
			</ul>
		</Panel>
	);
}

function NotebookPanel({ notes }: { notes: Note[] }) {
	return (
		<Panel index={1} title="#55 notebook">
			<ul className="space-y-1 text-[13px]">
				{notes.length === 0 ? <li className="text-muted-foreground">Each run opens a task list here first.</li> : null}
				{notes.map((n, i) => (
					<li key={`${i}-${n.text}`} className="flex items-start gap-2">
						<span className={`mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${n.done ? "border-transparent text-white" : ""}`} style={n.done ? { backgroundColor: ROLE_COLORS[n.role] } : undefined}>
							{n.done ? "✓" : ""}
						</span>
						<span className={`truncate ${n.done ? "text-muted-foreground line-through" : "text-foreground"}`}>
							<span style={{ color: ROLE_COLORS[n.role] }}>{n.role}</span> {n.text}
						</span>
					</li>
				))}
			</ul>
		</Panel>
	);
}

function ChiefPanel({ headline }: { headline: string }) {
	return (
		<Panel index={2} title="#53 chief updates">
			<p className="text-[13px] text-muted-foreground">Daily at 23:40 UTC, before the budget resets</p>
			<p className="mt-2 text-[14px] font-medium leading-snug text-foreground">{headline}</p>
		</Panel>
	);
}
