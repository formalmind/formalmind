"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SwarmState } from "@/lib/swarm";
import { Link } from "react-router";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isLiveRun, SwarmCanvas } from "./swarm-canvas";
import { TextSwap } from "@/components/motion/text-swap";

const POLL_MS = 10_000;

function minutesAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function SwarmWorkspace({ repo }: { repo: string }) {
	const [state, setState] = useState<SwarmState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [syncedAt, setSyncedAt] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	const load = async (quiet = false) => {
		if (!quiet) setLoading(true);
		try {
			const res = await fetch("/api/swarm/state");
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? res.statusText);
			setState(body);
			setError(null);
			setSyncedAt(Date.now());
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

	const queued = state?.work.filter((item) => item.labels.includes("fm:todo") || item.labels.includes("fm:rebuild")).length ?? 0;
	const inFlight = state?.work.filter((item) => item.kind === "pr").length ?? 0;
	const blocked = state?.work.filter((item) => item.labels.includes("fm:blocked")).length ?? 0;

	const swept = state?.projects?.filter((p) => p.inSwarm).length ?? 1;

	const pill = "inline-flex h-8 items-center rounded-full border bg-background/90 shadow-sm backdrop-blur";
	const status = state
		? `${swept > 1 ? `${swept} projects · ` : ""}${state.cycle ? `Cycle ${state.cycle.n}: ${state.cycle.phase} · ` : ""}${queued} queued · ${inFlight} PRs open · ${blocked} blocked · $${state.spentToday.toFixed(2)} spent today`
		: error ?? "Loading the live queue…";
	const synced = syncedAt ? `Synced ${Math.max(0, Math.round((now - syncedAt) / 1000))}s ago. ` : "";

	return (
		<div className="min-h-0 flex-1">
			<SwarmCanvas
				state={state}
				repo={repo}
				fill
				title={
					<>
						<SidebarTrigger className={`${pill} size-8 shrink-0 justify-center`} />
						<span
							className={`${pill} min-w-0 gap-2 px-3 text-sm text-muted-foreground`}
							title={run ? `${status}. The board shows ${repo} as it is right now.` : `${status}. Until a run starts, the cursors replay how one issue moves through the hand-off rules; moves and costs in the replay are illustrative.`}
						>
							<span className={`size-1.5 shrink-0 rounded-full ${run && run.status !== "completed" ? "animate-pulse bg-red-500" : "bg-muted-foreground/50"}`} />
							<span className="font-semibold text-foreground">Swarm</span>
							<span className="hidden min-w-0 truncate sm:inline">
								<TextSwap value={status} />
							</span>
						</span>
					</>
				}
				actions={
					<>
						<button
							type="button"
							onClick={() => void load()}
							className={`${pill} size-8 justify-center text-muted-foreground transition-colors hover:text-foreground`}
							aria-label="Refresh"
							title={`${synced}${activity}. The board re-reads GitHub every 10 seconds while this tab is open.`}
						>
							<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
						</button>
						{/* The swarm's chat is a page of its own, not a side panel. */}
						<Link
							to="/swarm/chat"
							className="inline-flex h-8 items-center rounded-full bg-foreground px-3 text-sm font-medium text-background shadow-sm transition-opacity hover:opacity-90"
						>
							Ask the swarm
						</Link>
					</>
				}
			/>
		</div>
	);
}
