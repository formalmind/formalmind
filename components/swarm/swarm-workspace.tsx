"use client";

import { useEffect, useState } from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import type { SwarmState } from "@/lib/swarm";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isLiveRun, SwarmCanvas } from "./swarm-canvas";
import { SwarmChat } from "./swarm-chat";

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

	const queued = state?.work.filter((item) => item.labels.includes("fm:todo")).length ?? 0;
	const inFlight = state?.work.filter((item) => item.kind === "pr").length ?? 0;
	const blocked = state?.work.filter((item) => item.labels.includes("fm:blocked")).length ?? 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5">
				<SidebarTrigger className="-ml-1" />
				<h1 className="text-base font-semibold">Swarm</h1>
				<span className="text-sm text-muted-foreground">
					{state
						? `${queued} queued · ${inFlight} PRs open · ${blocked} blocked · $${state.spentToday.toFixed(2)} spent today`
						: error ?? "Loading the live queue…"}
				</span>
				<span
					className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
					title={run ? `The board shows ${repo} as it is right now.` : "Until a run starts, the cursors replay how one issue moves through the hand-off rules; moves and costs in the replay are illustrative."}
				>
					<span className={`size-1.5 shrink-0 rounded-full ${run && run.status !== "completed" ? "animate-pulse bg-red-500" : "bg-muted-foreground/50"}`} />
					<span className="truncate">{activity}</span>
				</span>
				<div className="ml-auto flex items-center gap-3">
					{syncedAt ? (
						<span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title="The board re-reads GitHub every 10 seconds while this tab is open">
							Synced {Math.max(0, Math.round((now - syncedAt) / 1000))}s ago
						</span>
					) : null}
					<button
						type="button"
						onClick={() => void load()}
						className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
						Refresh
					</button>
					<Sheet>
						<SheetTrigger asChild>
							<button
								type="button"
								className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
							>
								<MessageSquare className="h-3.5 w-3.5" />
								Ask the swarm
							</button>
						</SheetTrigger>
						<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-[420px]">
							<div className="flex h-14 shrink-0 items-center px-4">
								<SheetTitle className="text-sm font-semibold">Ask the swarm</SheetTitle>
								<SheetDescription className="sr-only">Ask what the agents are doing.</SheetDescription>
							</div>
							<SwarmChat repo={repo} />
						</SheetContent>
					</Sheet>
				</div>
			</header>
			<div className="min-h-0 flex-1">
				<SwarmCanvas state={state} fill />
			</div>
		</div>
	);
}
