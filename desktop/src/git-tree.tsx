import { useEffect, useMemo, useState } from "react";
import { ChevronDown, GitBranch } from "lucide-react";
import type { Bridge } from "./swarm-panel";

type Commit = { id: string; parents: string[]; refs: string[]; subject: string; time: number };
type GitGraph = { commits: Commit[]; head: string | null; branch: string | null; dirty: number };

const ROW = 24;
const LANE = 12;

/** Lanes for a newest-first history: each commit's column, and the lines to its parents below it. */
function layout(commits: Commit[]) {
	const row = new Map(commits.map((c, i) => [c.id, i]));
	const lanes: (string | null)[] = [];
	const col: number[] = [];
	for (const c of commits) {
		let at = lanes.indexOf(c.id);
		if (at === -1) {
			at = lanes.indexOf(null);
			if (at === -1) at = lanes.push(null) - 1;
		}
		col.push(at);
		// Branches that merged into this commit end here.
		lanes.forEach((id, i) => {
			if (id === c.id) lanes[i] = null;
		});
		const [first, ...rest] = c.parents;
		lanes[at] = first ?? null;
		for (const p of rest) if (!lanes.includes(p)) {
			const free = lanes.indexOf(null);
			if (free === -1) lanes.push(p);
			else lanes[free] = p;
		}
	}
	const edges = commits.flatMap((c, i) => c.parents.filter((p) => row.has(p)).map((p) => ({ from: [col[i], i], to: [col[row.get(p)!], row.get(p)!] })));
	return { col, edges, width: Math.max(1, ...col.map((x) => x + 1)) };
}

const x = (lane: number) => 8 + lane * LANE;
const y = (r: number) => r * ROW + ROW / 2;

/**
 * The folder's git history on the canvas: every branch's latest commits as a graph, HEAD marked as where the swarm works,
 * and its uncommitted proofs and fixes as a row above it. Read-only (git log and status).
 */
export function GitTree({ folder, invoke, working, flat = false }: { folder: string; invoke: Bridge["invoke"]; working: boolean; /** Laid flat in a card on the canvas (no frame of its own, always open). */ flat?: boolean }) {
	const [graph, setGraph] = useState<GitGraph | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openState, setOpen] = useState(true);
	const open = flat || openState;
	useEffect(() => {
		const load = () => void invoke<GitGraph>("folder_git_graph", { path: folder }).then((g) => (setGraph(g), setError(null)), (e) => setError(String(e)));
		load();
		// The swarm changes files as it proves: look again now and then while the canvas is open.
		const t = setInterval(load, 20_000);
		return () => clearInterval(t);
	}, [folder, invoke]);
	const commits = graph?.commits ?? [];
	// The work in progress sits above HEAD as a commit-to-be.
	const rows = useMemo(() => (graph && graph.dirty && graph.head ? [{ id: "~work", parents: [graph.head], refs: [], subject: "", time: 0 }, ...commits] : commits), [graph, commits]);
	const { col, edges, width } = useMemo(() => layout(rows), [rows]);
	const gutter = 8 + width * LANE;
	return (
		<section className={flat ? "flex min-h-0 flex-1 flex-col" : "pointer-events-auto absolute left-3 top-3 z-10 flex max-h-[min(28rem,calc(100%-1.5rem))] w-[min(24rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border bg-muted/80 p-1 shadow-pop backdrop-blur"}>
			<button type="button" onClick={() => !flat && setOpen(!open)} aria-expanded={open} className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-left">
				<GitBranch className="size-3.5 text-muted-foreground" />
				<span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Git</span>
				<span className="truncate text-[11px] text-muted-foreground">
					{graph ? `${graph.branch ?? "detached"}${graph.dirty ? ` · ${graph.dirty} uncommitted` : ""}` : error ? "not a git repository" : ""}
				</span>
				{flat ? null : <ChevronDown className={`ml-auto size-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />}
			</button>
			{open && rows.length ? (
				<div className={flat ? "min-h-0 flex-1 overflow-y-auto py-1" : "min-h-0 overflow-y-auto rounded-xl border bg-card py-1"}>
					<div className="relative" style={{ height: rows.length * ROW }}>
						<svg className="absolute left-0 top-0" width={gutter} height={rows.length * ROW} aria-hidden>
							{edges.map((e, i) => {
								const [fx, fr] = e.from;
								const [tx, tr] = e.to;
								const d = fx === tx ? `M${x(fx)} ${y(fr)} V${y(tr)}` : `M${x(fx)} ${y(fr)} C${x(fx)} ${y(fr) + ROW * 0.8} ${x(tx)} ${y(fr) + ROW * 0.2} ${x(tx)} ${y(fr) + ROW} V${y(tr)}`;
								return <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={1.5} className={rows[fr].id === "~work" ? "text-emerald-500/70" : "text-border"} strokeDasharray={rows[fr].id === "~work" ? "3 3" : undefined} />;
							})}
							{rows.map((c, i) => {
								const head = c.id === graph?.head;
								return c.id === "~work" ? (
									<circle key={c.id} cx={x(col[i])} cy={y(i)} r={4} className="fill-card stroke-emerald-500" strokeWidth={1.5} strokeDasharray="2 2" />
								) : (
									<circle key={c.id} cx={x(col[i])} cy={y(i)} r={head ? 4 : 3} className={head ? "fill-emerald-500" : "fill-muted-foreground/60"} />
								);
							})}
						</svg>
						{rows.map((c, i) => {
							const head = c.id === graph?.head;
							const refs = c.refs.map((r) => r.replace(/^HEAD -> /, "").replace(/^tag: /, "")).filter((r) => r !== "HEAD");
							return (
								<div key={c.id} className={`absolute inset-x-0 flex items-center gap-1.5 pr-2 text-[12px] ${head || c.id === "~work" ? "bg-emerald-500/5" : ""}`} style={{ top: i * ROW, height: ROW, paddingLeft: gutter + 4 }} title={c.id === "~work" ? "Not committed yet" : `${c.id.slice(0, 7)} · ${new Date(c.time * 1000).toLocaleString()}`}>
									{c.id === "~work" ? (
										<span className="truncate text-emerald-700 dark:text-emerald-400">
											{graph?.dirty} uncommitted {graph?.dirty === 1 ? "change" : "changes"}{working ? " · proving here" : ""}
										</span>
									) : (
										<>
											<span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.id.slice(0, 7)}</span>
											{refs.map((r) => (
												<span key={r} className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{r}</span>
											))}
											<span className="truncate">{c.subject}</span>
											{head && !graph?.dirty && working ? <span className="ml-auto shrink-0 text-[11px] text-emerald-700 dark:text-emerald-400">proving here</span> : null}
										</>
									)}
								</div>
							);
						})}
					</div>
				</div>
			) : null}
		</section>
	);
}
