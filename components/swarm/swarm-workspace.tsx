"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SwarmRole, SwarmState } from "@/lib/swarm";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isLiveRun, ROLE_COLORS, SwarmCanvas } from "./swarm-canvas";
import { SwarmChat } from "./swarm-chat";

const POLL_MS = 10_000;

function minutesAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

const ROLE_JOBS: Record<SwarmRole, string> = {
	dispatcher: "picks one job per sweep",
	planner: "scopes issues",
	prover: "writes the Lean",
	reviewer: "first pair of eyes",
	merger: "verifies and merges",
	chief: "daily report",
};

export function SwarmWorkspace({ repo }: { repo: string }) {
	const [state, setState] = useState<SwarmState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [highlight, setHighlight] = useState<SwarmRole | null>(null);

	const load = async (quiet = false) => {
		if (!quiet) setLoading(true);
		try {
			const res = await fetch("/api/swarm/state");
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? res.statusText);
			setState(body);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load the swarm state.");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		// Poll while the tab is visible so the board follows the swarm as it works.
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void load(true);
		}, POLL_MS);
		return () => clearInterval(timer);
	}, []);

	const latest = state?.runs[0];
	const run = isLiveRun(latest) ? latest : null;
	const activity = run
		? `${run.status === "completed" ? "Just finished" : "Live"}: ${run.note ? `${run.note.role}${run.note.ref ? ` on #${run.note.ref}` : ""}` : "dispatcher"} · ${run.status === "completed" ? "done" : run.phase} · started ${minutesAgo(run.startedAt)}`
		: "Idle. The dispatcher sweeps every 30 minutes";

	const queued = state?.work.filter((item) => item.labels.includes("fm:todo")).length ?? 0;
	const inFlight = state?.work.filter((item) => item.kind === "pr").length ?? 0;
	const blocked = state?.work.filter((item) => item.labels.includes("fm:blocked")).length ?? 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
			<section className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<SidebarTrigger className="-ml-1" />
					<h1 className="text-base font-semibold">Swarm</h1>
					<span className="text-sm text-muted-foreground">
						{state
							? `${queued} queued · ${inFlight} PRs open · ${blocked} blocked · $${state.spentToday.toFixed(2)} spent today`
							: error ?? "Loading the live queue…"}
					</span>
					<button
						type="button"
						onClick={() => void load()}
						className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
						Refresh
					</button>
				</div>

				<div className="mt-4">
					<SwarmCanvas state={state} highlight={highlight} />
				</div>
				<p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
					<span className={`size-1.5 shrink-0 rounded-full ${run && run.status !== "completed" ? "animate-pulse bg-red-500" : "bg-muted-foreground/50"}`} />
					{run
						? <span>{activity}. The board shows {repo} as it is right now; it refreshes every 10 seconds.</span>
						: <span>{activity}. Until a run starts, the cursors replay how one issue moves through the hand-off rules; moves and costs in the replay are illustrative.</span>}
				</p>

				{state?.runs.length ? (
					<div className="mt-5">
						<h2 className="text-xs font-medium text-muted-foreground">Recent runs</h2>
						<ol className="mt-2 divide-y rounded-lg border">
							{state.runs.map((r) => {
								const role = r.note?.role ?? "dispatcher";
								return (
									<li key={r.id}>
										<a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/50">
											<span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: ROLE_COLORS[role] }} />
											<span className="w-20 shrink-0 font-medium">{role}</span>
											<span className="min-w-0 flex-1 truncate text-muted-foreground">
												{r.note ? `${r.note.ref ? `#${r.note.ref} · ` : ""}${r.note.title}` : r.status === "completed" ? "nothing to do this sweep" : "picking a job"}
											</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{r.status === "completed" ? r.conclusion : r.phase}
												{r.usd != null ? ` · $${r.usd.toFixed(2)}` : ""} · {minutesAgo(r.startedAt)}
											</span>
										</a>
									</li>
								);
							})}
						</ol>
					</div>
				) : null}

				<ul className="mt-4 flex flex-wrap gap-2">
					{(Object.keys(ROLE_COLORS) as SwarmRole[]).map((role) => (
						<li key={role}>
							<button
								type="button"
								onMouseEnter={() => setHighlight(role)}
								onMouseLeave={() => setHighlight(null)}
								onFocus={() => setHighlight(role)}
								onBlur={() => setHighlight(null)}
								className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs"
							>
								<span className="size-2 rounded-full" style={{ backgroundColor: ROLE_COLORS[role] }} />
								<span className="font-medium">{role}</span>
								<span className="text-muted-foreground">{ROLE_JOBS[role]}</span>
							</button>
						</li>
					))}
				</ul>
			</section>

			<aside className="flex h-[70vh] min-h-0 flex-col border-t lg:h-auto lg:w-[380px] lg:border-l lg:border-t-0">
				<div className="flex h-14 shrink-0 items-center px-4">
					<h2 className="text-sm font-semibold">Ask the swarm</h2>
				</div>
				<SwarmChat repo={repo} />
			</aside>
		</div>
	);
}
