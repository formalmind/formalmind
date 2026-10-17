"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { SwarmItem, SwarmRole, SwarmRun, SwarmState } from "@/lib/swarm";

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

export const ROLE_COLORS: Record<SwarmRole, string> = {
	dispatcher: "#64748b",
	planner: "#8b5cf6",
	prover: "#3b82f6",
	reviewer: "#f59e0b",
	merger: "#10b981",
	chief: "#f43f5e",
};

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

const LABEL_STYLES: Record<string, string> = {
	"fm:todo": "bg-slate-500/15 text-slate-600 dark:text-slate-300",
	"fm:in-progress": "bg-blue-500/15 text-blue-600 dark:text-blue-300",
	"fm:review": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	"fm:changes": "bg-red-500/15 text-red-600 dark:text-red-300",
	"fm:approved": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	"fm:blocked": "bg-red-500/15 text-red-600 dark:text-red-300",
	"fm:needs-rebase": "bg-orange-500/15 text-orange-700 dark:text-orange-300",
	merged: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
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
const JOBS = ["merge", "review", "revise", "resume", "new issue", "plan"];

type Step = { hold: number; apply: (scene: Scene) => void };

function card(scene: Scene, id: string) {
	return scene.cards.find((c) => c.id === id)!;
}

function move(scene: Scene, id: string, lane: Lane, patch: Partial<Card> = {}) {
	Object.assign(card(scene, id), { lane, order: scene.tick++, ...patch });
}

function say(scene: Scene, role: SwarmRole, text: string | undefined, where?: { x: number; y: number } | string) {
	const cursor = scene.cursors[role];
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
	const queue: Pick<SwarmItem, "number" | "title">[] = todo.length >= 2 ? todo.slice(0, 2) : [
		{ number: 60, title: "spec: wallet balances stay non-negative" },
		{ number: 61, title: "spec: pool reserves stay non-negative" },
	];
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
	return [
		{ hold: 1800, apply: (s) => { s.job = "new issue"; say(s, "dispatcher", `Sweep: $${(5 - s.spend).toFixed(2)} of $5 left today. Nothing to merge or review, so prove #${a.number}`); } },
		{ hold: 1400, apply: (s) => { home(s, "dispatcher"); say(s, "prover", `Picking up #${a.number}`, id); note(s, "prover", `#${a.number}: read, define, prove, build, open PR`); } },
		{ hold: 1500, apply: (s) => { move(s, id, "progress", { label: "fm:in-progress", branch: `fm/issue-${a.number}` }); say(s, "prover", `On branch fm/issue-${a.number}`, id); } },
		{ hold: 1800, apply: (s) => { say(s, "prover", "lake build ✓  no sorry, no new axioms", id); tick(s); spend(s, "prover", 0.95); } },
		{ hold: 1700, apply: (s) => { move(s, id, "review", { kind: "pr", number: pr, label: "fm:review" }); say(s, "prover", `Opened PR #${pr} with a changelog entry. @fm-reviewer`, id); } },
		{ hold: 1500, apply: (s) => { home(s, "prover"); s.job = "review"; say(s, "dispatcher", `PR #${pr} has fm:review, so review it`); } },
		{ hold: 1900, apply: (s) => { home(s, "dispatcher"); say(s, "reviewer", "Checked the Solidity line by line. Suggestion: dsimp only before omega", id); note(s, "reviewer", `#${pr}: diff, Solidity, scope, changelog`); } },
		{ hold: 1600, apply: (s) => { move(s, id, "progress", { label: "fm:changes" }); say(s, "reviewer", "Changes requested. @fm-prover", id); tick(s); spend(s, "reviewer", 0.22); } },
		{ hold: 1400, apply: (s) => { home(s, "reviewer"); s.job = "revise"; say(s, "dispatcher", `PR #${pr} has fm:changes, so the prover revises`); } },
		{ hold: 1700, apply: (s) => { home(s, "dispatcher"); say(s, "prover", "Applied the suggestion. Build still clean", id); spend(s, "prover", 0.6); } },
		{ hold: 1400, apply: (s) => { move(s, id, "review", { label: "fm:review" }); say(s, "prover", "Back to you. @fm-reviewer", id); } },
		{ hold: 1600, apply: (s) => { home(s, "prover"); say(s, "reviewer", "Suggestion is in the diff. Approved. @fm-merger", id); } },
		{ hold: 1500, apply: (s) => { move(s, id, "approved", { label: "fm:approved" }); say(s, "reviewer", undefined, id); spend(s, "reviewer", 0.18); } },
		{ hold: 1400, apply: (s) => { home(s, "reviewer"); s.job = "merge"; say(s, "dispatcher", `PR #${pr} has fm:approved, so merge comes first`); } },
		{ hold: 2000, apply: (s) => { home(s, "dispatcher"); say(s, "merger", "lake build on the exact head ✓. Every theorem the thread claims exists without sorry", id); note(s, "merger", `#${pr}: gate, verify claims, decide, merge`); } },
		{ hold: 1700, apply: (s) => { move(s, id, "dev", { label: "merged" }); say(s, "merger", "Squash-merged into dev", id); tick(s); spend(s, "merger", 0.25); } },
		{ hold: 1400, apply: (s) => { home(s, "merger"); s.job = "plan"; say(s, "dispatcher", "Only one fm:todo left, so plan"); } },
		{ hold: 1700, apply: (s) => { home(s, "dispatcher"); say(s, "planner", "Reading the roadmap and the gaps the changelog left", ROADMAP_SPOT); note(s, "planner", "queue small, disjoint issues; post digest"); } },
		{ hold: 300, apply: (s) => { s.cards.push({ id: "new", number: next, title: "spec: next unproven gap from the changelog", kind: "issue", lane: "roadmap", order: s.tick++, label: "fm:todo" }); } },
		{ hold: 1800, apply: (s) => { move(s, "new", "todo"); say(s, "planner", `Wrote #${next} and posted a digest on the ledger`, "new"); tick(s); spend(s, "planner", 0.3); } },
		{ hold: 2600, apply: (s) => { home(s, "planner"); s.job = null; s.chief = "Working: 1 merged, 2 queued, nothing waiting on you"; say(s, "chief", "Posted the daily update on #53. @mmsaki", CHIEF_SPOT); } },
		{ hold: 1600, apply: (s) => { home(s, "chief"); } },
	];
}

const COST_ROLES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", review: "reviewer", merge: "merger", chief: "chief" };

/** Lane an open item sits in, from its fm: labels. */
function laneOf(item: SwarmItem): { lane: Lane; label: string } | null {
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
	const current = note?.tasks.find((t) => !t.done && !t.dropped);
	const say = clip(run.status === "completed"
		? note ? `Done${note.verified ? `: ${note.verified}` : ""}` : "Finished"
		: current?.text ?? (note && run.phase === "working" ? "Wrapping up" : PHASE_TEXT[run.phase]));

	const cursors = Object.fromEntries(ROLES.map((r) => [r, { at: HOME[r] }])) as Scene["cursors"];
	const target = cards.find((c) => c.number === note?.ref && c.kind !== "doc");
	const spot = role === "chief" || note?.ref === 53 ? CHIEF_SPOT
		: note?.ref === 38 ? LEDGER_SPOT
		: note?.ref === 55 ? NOTEBOOK_SPOT
		: role === "planner" ? ROADMAP_SPOT
		: undefined;
	cursors[role] = target ? { follow: target.id, say } : { at: spot ?? HOME[role], say };

	const label = target?.label;
	const job = role === "merger" ? "merge"
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

export function SwarmCanvas({ state, highlight }: { state: SwarmState | null; highlight?: SwarmRole | null }) {
	const frameRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);
	const [step, setStep] = useState(0);
	const [playing, setPlaying] = useState(true);

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
		const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / W));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const shown = live ?? scene;
	const positions = layout(shown.cards);
	const cursorPos = (cursor: Cursor) => {
		const p = cursor.follow ? positions.get(cursor.follow) : undefined;
		return p ? { x: p.x + CARD_W - 28, y: p.y + 46 } : cursor.at ?? { x: 0, y: 0 };
	};

	return (
		<div className="relative w-full">
			<div ref={frameRef} className="relative w-full overflow-hidden rounded-xl border bg-card" style={{ height: H * scale }}>
				<div
					className="absolute left-0 top-0 origin-top-left"
					style={{
						width: W,
						height: H,
						transform: `scale(${scale})`,
						backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
						backgroundSize: "20px 20px",
					}}
				>
					<DispatcherChip job={shown.job} />

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
						return <BoardCard key={c.id} card={c} x={p.x} y={p.y} hidden={p.hidden} />;
					})}

					<LedgerPanel spend={shown.spend} costs={shown.costs} />
					<NotebookPanel notes={shown.notes} />
					<ChiefPanel headline={shown.chief} />

					{ROLES.map((role) => (
						<SwarmCursor
							key={role}
							role={role}
							{...cursorPos(shown.cursors[role])}
							say={shown.cursors[role].say}
							dim={Boolean(highlight && highlight !== role)}
						/>
					))}
				</div>
			</div>
			{live && run ? (
				<a
					href={run.url}
					target="_blank"
					rel="noreferrer"
					className="absolute right-3 top-3 inline-flex h-8 items-center gap-2 rounded-full border bg-background/90 px-3 text-xs font-medium shadow-sm backdrop-blur"
				>
					<span className={`size-2 rounded-full ${run.status === "completed" ? "bg-muted-foreground" : "animate-pulse bg-red-500"}`} />
					{run.status === "completed" ? "Just finished" : "Live"}
				</a>
			) : (
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					className="absolute right-3 top-3 inline-flex h-8 items-center gap-1.5 rounded-full border bg-background/90 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
					aria-label={playing ? "Pause replay" : "Play replay"}
				>
					{playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
					Replay
				</button>
			)}
		</div>
	);
}

const MOVE = "transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

function SwarmCursor({ role, x, y, say, dim }: { role: SwarmRole; x: number; y: number; say?: string; dim: boolean }) {
	const color = ROLE_COLORS[role];
	// Near the right edge the label and bubble open to the left so they stay on the board.
	const flip = x > W - 260;
	return (
		<div
			className={`pointer-events-none absolute left-0 top-0 z-20 ${MOVE}`}
			style={{ transform: `translate(${x}px, ${y}px)`, opacity: dim ? 0.35 : 1, transitionProperty: "transform, opacity" }}
		>
			<svg width="28" height="28" viewBox="0 0 24 24" className="absolute -left-2 -top-[5px] drop-shadow-sm" aria-hidden>
				<polygon points="7 20 7 4 19 16 12 16 7 21" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
			</svg>
			<div className={`absolute top-5 flex flex-col gap-1 ${flip ? "right-1 items-end" : "left-4 items-start"}`}>
				<span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium text-white shadow-sm" style={{ backgroundColor: color }}>
					{role}
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

function BoardCard({ card, x, y, hidden }: { card: Card; x: number; y: number; hidden: boolean }) {
	return (
		<div
			className={`absolute left-0 top-0 z-10 rounded-lg border bg-background p-2.5 shadow-sm ${MOVE}`}
			style={{ width: CARD_W, height: 78, transform: `translate(${x}px, ${y}px)`, opacity: hidden ? 0 : 1, transitionProperty: "transform, opacity" }}
		>
			<div className="flex items-center gap-1.5 text-[12px]">
				{card.kind === "doc" ? null : <span className="font-mono text-muted-foreground">{card.kind === "pr" ? "PR" : "#"}{card.number}</span>}
				<span className={`rounded px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[card.label] ?? LABEL_STYLES.README}`}>{card.label}</span>
			</div>
			<p className="mt-1 line-clamp-2 text-[13px] leading-snug text-foreground">{card.title}</p>
		</div>
	);
}

function DispatcherChip({ job }: { job: string | null }) {
	return (
		<div className="absolute flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-[12px] shadow-sm" style={{ left: CHIP.x, top: CHIP.y }}>
			<span className="font-medium" style={{ color: ROLE_COLORS.dispatcher }}>dispatcher</span>
			<span className="text-muted-foreground">every 30 min picks one job:</span>
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
