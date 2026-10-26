"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Crosshair, Maximize, Minus, Play, Plus, RefreshCw } from "lucide-react";
import { readEntryPoints, setMainEntryPoint } from "@/lib/entry-points";
import type { Bridge } from "./swarm-panel";

/**
 * Reach: the entry contract's call graph from solc's AST, every function coloured by what is known about its branch
 * sides. Run by the suite, solved by explore (an input reaches it), unsat (no input of the tests that get there does),
 * unknown, or not explored yet. The data is the suite's branch map (any coverage run) and explore's last results; the
 * page runs either in the background.
 */

type Status = "run" | "solved" | "unsat" | "pinned" | "unknown" | "inputs" | "unreached" | "unexplored";
type Side = { line: number; code: string; pc: number; jumped: boolean; count: number; status: Status; test?: string; args?: string; test_failed?: string | null };
type Fn = {
	id: number;
	name: string;
	contract: string | null;
	contract_kind: string | null;
	kind: string;
	visibility: string;
	mutability: string;
	entry: boolean;
	file: string;
	line: number;
	end: number;
	counts: Partial<Record<Status, number>>;
	sides: Side[];
};
type ReachMap = { entry: string; contract: string | null; functions: Fn[]; edges: [number, number][]; coverage: "current" | "stale" | null; explored: number | null; outside: number };
type Task = { id: number; task: string; status: "running" | "done"; seconds: number };

/** Best first: what a side ended as, its colour, and what it means. */
const STATUSES: { id: Status; label: string; color: string; what: string }[] = [
	{ id: "run", label: "Run", color: "#10b981", what: "the suite takes this side" },
	{ id: "solved", label: "Solved", color: "#0ea5e9", what: "explore found an input of a fuzz test that takes it" },
	{ id: "unsat", label: "Unsat", color: "#64748b", what: "no input of the tests that reach it takes it: a dead guard, or a test that can't express the case" },
	{ id: "pinned", label: "Unsat, pinned", color: "#94a3b8", what: "unreachable with the storage this run had: a statement about this path, not a proof" },
	{ id: "unknown", label: "Unknown", color: "#f59e0b", what: "the solver gave up within its time" },
	{ id: "inputs", label: "State decides", color: "#a78bfa", what: "a fuzz test runs it, but its inputs don't decide the branch: it needs other state (a sequence of calls)" },
	{ id: "unreached", label: "Not reached", color: "#f43f5e", what: "no fuzz test runs this code" },
	{ id: "unexplored", label: "Not explored", color: "#fdba74", what: "the suite never takes it, and explore hasn't looked yet" },
];
const COLOR = Object.fromEntries(STATUSES.map((s) => [s.id, s.color])) as Record<Status, string>;
const LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label])) as Record<Status, string>;

const NODE_W = 216;
const NODE_H = 52;
const COL_GAP = 72;
const ROW_GAP = 10;
const PAD = 16;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
/** The Swarm canvas's dot grid. */
const DOTS = { backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)" };

const total = (f: Fn) => f.sides.length;

/** A function's sides as one bar, best status first. */
function SideBar({ counts, n, className = "" }: { counts: Fn["counts"]; n: number; className?: string }) {
	if (!n) return <div className={`h-1.5 rounded-full bg-muted ${className}`} />;
	return (
		<div className={`flex h-1.5 overflow-hidden rounded-full bg-muted ${className}`}>
			{STATUSES.map((s) => (counts[s.id] ? <span key={s.id} style={{ width: `${(100 * counts[s.id]!) / n}%`, backgroundColor: s.color }} /> : null))}
		</div>
	);
}

/** Columns by call depth from the entry points; within a column, by contract and line. */
function layout(fns: Fn[], edges: [number, number][]) {
	const out = new Map<number, number[]>();
	for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b]);
	const depth = new Map<number, number>();
	const queue = fns.filter((f) => f.entry).map((f) => f.id);
	for (const id of queue) depth.set(id, 0);
	while (queue.length) {
		const id = queue.shift()!;
		for (const to of out.get(id) ?? []) {
			if (!depth.has(to)) {
				depth.set(to, depth.get(id)! + 1);
				queue.push(to);
			}
		}
	}
	const cols: Fn[][] = [];
	for (const f of fns) {
		const d = depth.get(f.id) ?? 0;
		(cols[d] ??= []).push(f);
	}
	const pos = new Map<number, { x: number; y: number }>();
	cols.forEach((col, i) => {
		col.sort((a, b) => (a.contract ?? "").localeCompare(b.contract ?? "") || a.file.localeCompare(b.file) || a.line - b.line);
		col.forEach((f, j) => pos.set(f.id, { x: PAD + i * (NODE_W + COL_GAP), y: PAD + j * (NODE_H + ROW_GAP) }));
	});
	const height = PAD * 2 + Math.max(0, ...cols.map((c) => c.length)) * (NODE_H + ROW_GAP);
	const width = PAD * 2 + cols.length * (NODE_W + COL_GAP) - COL_GAP;
	return { pos, width, height };
}

export function ReachView({ folder, scan, invoke, listen, onOpenFile }: { folder: string; scan: { solidity?: string[] } | null; invoke: Bridge["invoke"]; listen: Bridge["listen"]; onOpenFile: (path: string, line?: number) => void }) {
	const sources = (scan?.solidity ?? []).filter((f) => !f.endsWith(".t.sol") && !f.endsWith(".s.sol"));
	const support = (f: string) => /(^|\/)(libraries|interfaces|types|utils)\//.test(f) || /\/I[A-Z]\w*\.sol$/.test(f);
	const [entries, setEntries] = useState(() => readEntryPoints(folder));
	const contracts = sources.filter((f) => !support(f));
	const pick = entries.find((f) => sources.includes(f)) ?? contracts.find((f) => f.startsWith("src/")) ?? contracts[0] ?? null;
	const [entry, setEntry] = useState<string | null>(pick);
	const [data, setData] = useState<ReachMap | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<number | null>(null);
	const [branchesOnly, setBranchesOnly] = useState(true);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!entry && pick) setEntry(pick);
	}, [entry, pick]);

	useEffect(() => {
		if (!entry) return;
		let live = true;
		setLoading(true);
		setError(null);
		invoke<ReachMap>("reach_map", { folder, entry }).then(
			(m) => live && setData(m),
			(e) => live && setError(String(e)),
		).finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [folder, entry, invoke, tick]);

	// A finished coverage or explore run: read the map again.
	useEffect(() => {
		const off = listen<{ folder: string }>("reach:updated", ({ payload }) => {
			if (payload.folder === folder) setTick((t) => t + 1);
		});
		return () => void off.then((f) => f());
	}, [folder, listen]);

	// While something runs in the background, its time ticks.
	const running = tasks.filter((t) => t.status === "running");
	useEffect(() => {
		const read = () => void invoke<Task[]>("reach_tasks", { folder }).then(setTasks, () => {});
		read();
		const t = setInterval(read, running.length ? 1000 : 5000);
		return () => clearInterval(t);
	}, [folder, invoke, running.length]);

	const run = async (tool: "coverage" | "explore", target?: string) => {
		try {
			await invoke<number>("reach_run", { folder, tool, target: target ?? null });
			setTasks(await invoke<Task[]>("reach_tasks", { folder }));
		} catch (e) {
			setError(String(e));
		}
	};

	const shown = useMemo(() => {
		if (!data) return { fns: [] as Fn[], edges: [] as [number, number][] };
		// Branches only: functions with sides, and the ones on a call path to them from an entry point. With no sides
		// yet (no coverage), the whole graph.
		if (!branchesOnly || !data.functions.some(total)) return { fns: data.functions, edges: data.edges };
		const out = new Map<number, number[]>();
		for (const [a, b] of data.edges) out.set(a, [...(out.get(a) ?? []), b]);
		const keep = new Set<number>();
		const leads = (id: number, seen: Set<number>): boolean => {
			if (keep.has(id)) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			const f = data.functions.find((x) => x.id === id);
			let yes = Boolean(f && total(f));
			for (const to of out.get(id) ?? []) if (leads(to, seen)) yes = true;
			if (yes) keep.add(id);
			return yes;
		};
		for (const f of data.functions) if (f.entry) leads(f.id, new Set());
		const fns = data.functions.filter((f) => keep.has(f.id));
		return { fns, edges: data.edges.filter(([a, b]) => keep.has(a) && keep.has(b)) };
	}, [data, branchesOnly]);
	const { pos, width, height } = useMemo(() => layout(shown.fns, shown.edges), [shown]);
	const totals = useMemo(() => {
		const c: Partial<Record<Status, number>> = {};
		for (const f of data?.functions ?? []) for (const s of f.sides) c[s.status] = (c[s.status] ?? 0) + 1;
		return c;
	}, [data]);
	const sideCount = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
	const sel = data?.functions.find((f) => f.id === selected) ?? null;
	const near = useMemo(() => {
		if (selected === null) return null;
		const s = new Set([selected]);
		for (const [a, b] of shown.edges) {
			if (a === selected) s.add(b);
			if (b === selected) s.add(a);
		}
		return s;
	}, [selected, shown.edges]);
	// The canvas: pan by dragging the background or scrolling, zoom with a pinch or ctrl/cmd + wheel, fit with the pill.
	const frame = useRef<HTMLDivElement>(null);
	const [view, setView] = useState({ k: 1, x: 0, y: 0 });
	const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
	const fitView = () => {
		const box = frame.current?.getBoundingClientRect();
		if (!box || !width || !height) return;
		const k = Math.min(1, Math.max(MIN_ZOOM, Math.min(box.width / width, box.height / height)));
		setView({ k, x: Math.max(0, (box.width - width * k) / 2), y: k * height < box.height ? (box.height - height * k) / 2 : 0 });
	};
	const fitRef = useRef(fitView);
	fitRef.current = fitView;
	// A new map (another entry, branches only on or off) starts fitted.
	useEffect(() => fitRef.current(), [width, height, entry]);
	const zoomAt = (factor: number, px: number, py: number) =>
		setView((v) => {
			const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
			const r = k / v.k;
			return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
		});
	const zoomRef = useRef(zoomAt);
	zoomRef.current = zoomAt;
	useEffect(() => {
		const el = frame.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const box = el.getBoundingClientRect();
				zoomRef.current(Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top);
			} else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [data]);
	const zoomCentre = (factor: number) => {
		const box = frame.current?.getBoundingClientRect();
		if (box) zoomAt(factor, box.width / 2, box.height / 2);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card">
			{/* What the map is of, the protocol's sides at a glance, and what to run. */}
			{/* One line at any width: a narrow pane scrolls it sideways, under a fade at either edge. */}
			<div
				className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-b px-3 text-[12px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				style={{ maskImage: "linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)" }}
			>
				<label className="relative inline-flex h-7 max-w-64 shrink-0 items-center gap-1.5 rounded-md border bg-background pl-2 pr-6 text-[12px]">
					<Crosshair className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="truncate whitespace-nowrap">{entry ?? "No Solidity sources"}</span>
					<ChevronDown className="pointer-events-none absolute right-1.5 size-3.5 text-muted-foreground" />
					<select
						aria-label="Entry contract"
						className="absolute inset-0 cursor-pointer opacity-0"
						value={entry ?? ""}
						onChange={(e) => {
							setEntry(e.target.value);
							setEntries(setMainEntryPoint(folder, e.target.value));
							setSelected(null);
						}}
					>
						{contracts.map((f) => (
							<option key={f} value={f}>{f}</option>
						))}
					</select>
				</label>
				<div className="flex flex-1 items-center gap-3">
					{sideCount ? <SideBar counts={totals} n={sideCount} className="w-32 shrink-0" /> : null}
					<span className="flex gap-3 text-muted-foreground">
						{STATUSES.filter((s) => totals[s.id]).map((s) => (
							<span key={s.id} className="inline-flex shrink-0 items-center gap-1" title={s.what}>
								<i className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
								{s.label} <span className="tabular-nums text-foreground">{totals[s.id]}</span>
							</span>
						))}
					</span>
				</div>
				<label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground">
					<input type="checkbox" checked={branchesOnly} onChange={(e) => setBranchesOnly(e.target.checked)} className="accent-foreground" />
					Branches only
				</label>
				{running.length ? (
					<span className="shrink-0 whitespace-nowrap text-muted-foreground" title={running.map((t) => t.task).join(", ")}>
						<span className="fm-text-shimmer">{running[0].task.split(" ")[0]} running</span> · {running[0].seconds}s
					</span>
				) : null}
				<button type="button" disabled={running.length > 0} onClick={() => void run("coverage")} title={data?.coverage === "stale" ? "These sides are from an earlier run: the files changed since. Run the suite again" : data?.coverage ? "Run the suite again" : "No coverage yet: run the suite and map every branch side"} className="inline-flex h-7 shrink-0 items-center whitespace-nowrap gap-1 rounded-md border bg-background px-2 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50">
					<RefreshCw className="size-3" />Coverage{data?.coverage === "stale" ? <i className="size-1.5 rounded-full bg-amber-500" aria-label="stale" /> : null}
				</button>
				<button type="button" disabled={running.length > 0 || !data?.coverage} onClick={() => void run("explore")} title={data?.coverage ? "Solve for every side the suite never takes (minutes on a big suite)" : "Run coverage first"} className="inline-flex h-7 shrink-0 items-center whitespace-nowrap gap-1 rounded-md border bg-background px-2 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50">
					<Play className="size-3" />Explore all
				</button>
			</div>

			<div className="flex min-h-0 flex-1">
				<div
					ref={frame}
					className={`relative min-w-0 flex-1 touch-none overflow-hidden ${drag.current?.moved ? "cursor-grabbing" : "cursor-grab"}`}
					style={{ ...DOTS, backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
					// Drag the background to pan; the pointer is captured only once it moves, so a click still picks.
					onPointerDown={(e) => {
						if (e.button !== 0 || (e.target as HTMLElement).closest("[data-node], [data-canvas-ui]")) return;
						drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
					}}
					onPointerMove={(e) => {
						const d = drag.current;
						if (!d || d.id !== e.pointerId || e.buttons === 0) return;
						const dx = e.clientX - d.x;
						const dy = e.clientY - d.y;
						if (!d.moved) {
							if (Math.hypot(dx, dy) < 4) return;
							d.moved = true;
							e.currentTarget.setPointerCapture(e.pointerId);
						}
						d.x = e.clientX;
						d.y = e.clientY;
						setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
					}}
					onPointerUp={() => setTimeout(() => (drag.current = null))}
					onPointerCancel={() => (drag.current = null)}
					onClick={() => {
						if (!drag.current?.moved) setSelected(null);
					}}
				>
					{error ? <p className="absolute left-4 top-4 text-[13px] text-red-600">{error}</p> : null}
					{loading && !data ? <p className="absolute left-4 top-4 text-[13px] text-muted-foreground">Reading {entry}'s AST…</p> : null}
					{data ? (
						<div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
							<svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
								{shown.edges.map(([a, b]) => {
									const p = pos.get(a);
									const q = pos.get(b);
									if (!p || !q) return null;
									const x1 = p.x + NODE_W;
									const y1 = p.y + NODE_H / 2;
									const x2 = q.x;
									const y2 = q.y + NODE_H / 2;
									const back = x2 <= x1;
									const mid = back ? Math.max(x1, x2 + NODE_W) + 40 : (x1 + x2) / 2;
									const on = near ? near.has(a) && near.has(b) && (a === selected || b === selected) : true;
									return (
										<path
											key={`${a}-${b}`}
											d={back ? `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 + NODE_W},${y2}` : `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
											fill="none"
											stroke="currentColor"
											className={on ? (near ? "text-foreground/60" : "text-muted-foreground/30") : "text-muted-foreground/10"}
											strokeWidth={on && near ? 1.5 : 1}
										/>
									);
								})}
							</svg>
							{shown.fns.map((f) => {
								const p = pos.get(f.id);
								if (!p) return null;
								const n = total(f);
								const dim = near ? !near.has(f.id) : false;
								return (
									<button
										key={f.id}
										type="button"
										data-node
										onClick={(e) => {
											e.stopPropagation();
											setSelected(f.id === selected ? null : f.id);
										}}
										title={`${f.contract}.${f.name} · ${f.file}:${f.line}`}
										className={`absolute flex flex-col justify-center gap-1 rounded-lg border bg-background px-2.5 text-left shadow-sm transition-opacity hover:border-foreground/30 ${f.id === selected ? "border-foreground/60 ring-1 ring-foreground/20" : ""} ${dim ? "opacity-30" : ""}`}
										style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
									>
										<span className="flex min-w-0 items-baseline gap-1.5">
											{f.entry ? <span className="shrink-0 rounded bg-foreground px-1 text-[9px] font-medium uppercase tracking-wider text-background">entry</span> : null}
											<span className="truncate text-[12px] font-medium">{f.name}</span>
											<span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{n ? `${f.counts.run ?? 0}/${n}` : ""}</span>
										</span>
										<span className="flex items-center gap-2">
											<span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{f.contract}</span>
										</span>
										<SideBar counts={f.counts} n={n} />
									</button>
								);
							})}
						</div>
					) : null}
					{data ? (
						<div data-canvas-ui className="absolute bottom-3 right-3 z-10 flex h-8 items-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur">
							<button type="button" onClick={() => zoomCentre(1 / 1.25)} className="flex size-8 items-center justify-center rounded-full transition-colors hover:text-foreground" aria-label="Zoom out" title="Zoom out">
								<Minus className="size-3.5" />
							</button>
							<span className="w-10 text-center text-xs tabular-nums">{Math.round(view.k * 100)}%</span>
							<button type="button" onClick={() => zoomCentre(1.25)} className="flex size-8 items-center justify-center rounded-full transition-colors hover:text-foreground" aria-label="Zoom in" title="Zoom in">
								<Plus className="size-3.5" />
							</button>
							<button type="button" onClick={fitView} className="flex size-8 items-center justify-center rounded-full border-l transition-colors hover:text-foreground" aria-label="Fit to screen" title="Fit to screen">
								<Maximize className="size-3.5" />
							</button>
						</div>
					) : null}
				</div>

				{/* The function picked: each of its branch sides, by line, and what to do about the open ones. */}
				{sel ? (
					<aside className="flex w-80 shrink-0 flex-col border-l bg-background">
						<div className="border-b px-3 py-2.5">
							<p className="truncate text-[13px] font-medium">{sel.contract}.{sel.name}</p>
							<button type="button" onClick={() => onOpenFile(sel.file, sel.line)} className="truncate text-[11px] text-muted-foreground hover:text-foreground hover:underline">
								{sel.file}:{sel.line}–{sel.end}
							</button>
							<SideBar counts={sel.counts} n={total(sel)} className="mt-2" />
							<p className="mt-1.5 text-[11px] text-muted-foreground">
								{total(sel) ? STATUSES.filter((s) => sel.counts[s.id]).map((s) => `${sel.counts[s.id]} ${s.label.toLowerCase()}`).join(" · ") : "No branches: straight-line code."}
							</p>
						</div>
						<ul className="min-h-0 flex-1 divide-y overflow-y-auto text-[12px]">
							{sel.sides.map((s, i) => (
								<li key={i} className="flex flex-col gap-1 px-3 py-2">
									<span className="flex items-center gap-2">
										<i className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: COLOR[s.status] }} />
										<button type="button" onClick={() => onOpenFile(sel.file, s.line)} className="font-mono text-[11px] hover:underline">L{s.line}</button>
										<span className="text-muted-foreground">{s.jumped ? "jump" : "fall-through"}</span>
										<span className="ml-auto text-muted-foreground" title={STATUSES.find((x) => x.id === s.status)?.what}>
											{s.status === "run" ? `${s.count}×` : LABEL[s.status]}
										</span>
									</span>
									{s.code !== sel.contract ? <span className="pl-4 text-[10px] text-muted-foreground">in {s.code}'s bytecode</span> : null}
									{s.status === "solved" && s.test ? (
										<span className="break-all pl-4 font-mono text-[10px] text-muted-foreground">
											{s.test} {s.args}
											{s.test_failed ? <span className="text-red-600"> · the test fails: {s.test_failed}</span> : null}
										</span>
									) : null}
									{s.status === "unexplored" || s.status === "unknown" ? (
										<button type="button" disabled={running.length > 0} onClick={() => void run("explore", `${sel.file}:${s.line}`)} className="ml-4 inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
											<Play className="size-3" />Solve L{s.line}
										</button>
									) : null}
								</li>
							))}
						</ul>
					</aside>
				) : null}
			</div>
		</div>
	);
}
