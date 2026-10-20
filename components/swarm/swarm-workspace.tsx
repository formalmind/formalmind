"use client";

import { useEffect, useState } from "react";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { SwarmRole } from "@/lib/swarm";
import { AgentChat } from "./agent-chat";
import { SwarmChat } from "./swarm-chat";
import { RefreshCw, X } from "lucide-react";
import type { SwarmState } from "@/lib/swarm";
import { ChatComposer } from "@/components/chat-composer";
import type { OpenAIModel } from "@/lib/models";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { isLiveRun, SwarmCanvas } from "./swarm-canvas";
import { TextSwap } from "@/components/motion/text-swap";
import { NotificationCenter } from "@/components/notification-center";
import { notify } from "@/lib/notifications";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

const POLL_MS = 10_000;

function minutesAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The board narrowed to one project: its card in `projects`, and the items, merges and agents in its proofs repo. */
function onlyProject(state: SwarmState, repo: string): SwarmState {
	const project = state.projects.find((p) => p.repo === repo);
	const proofs = project?.proofsRepo?.toLowerCase();
	const mine = (r: string) => Boolean(proofs) && r.toLowerCase() === proofs;
	return {
		...state,
		projects: project ? [project] : [],
		work: state.work.filter((i) => mine(i.repo)),
		merged: state.merged.filter((i) => mine(i.repo)),
		active: state.active.filter((a) => mine(a.repo)),
	};
}

/** The swarm's board; with `only` (a project's repository), just that project's agents and work. */
export function SwarmWorkspace({ repo, only }: { repo: string; only?: string }) {
	// The chat open beside the canvas: an agent (a click on its name) or the whole swarm ("Ask the swarm").
	const [talkTo, setTalkTo] = useState<SwarmRole | "swarm" | null>(null);
	// What was typed into the canvas's composer, handed to the swarm chat in the panel.
	const [draft, setDraft] = useState("");
	const [ask, setAsk] = useState<{ id: number; text: string } | null>(null);
	const [model, setModel] = useState<OpenAIModel>("gpt-6-luna");
	const [state, setState] = useState<SwarmState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [syncedAt, setSyncedAt] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!talkTo) return;
		const close = (e: KeyboardEvent) => e.key === "Escape" && setTalkTo(null);
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [talkTo]);

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
			const message = err instanceof Error ? err.message : "Could not load the swarm state.";
			// One notice per distinct failure, not one per poll.
			setError((previous) => {
				if (previous !== message) notify.error("Could not refresh the swarm", { id: "swarm-state", description: message });
				return message;
			});
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
	// While any agent is working, the logo's bar breathes (CSS reads this flag on the root).
	const working = Boolean((run && run.status !== "completed") || state?.active?.some((a) => !a.finished));
	useEffect(() => {
		const root = document.documentElement;
		if (working) root.dataset.swarmWorking = "";
		else delete root.dataset.swarmWorking;
		return () => {
			delete root.dataset.swarmWorking;
		};
	}, [working]);
	const activity = run
		? `${run.status === "completed" ? "Just finished" : "Live"}: ${run.note ? `${run.note.role}${run.note.ref ? ` on #${run.note.ref}` : ""}` : "dispatcher"} · ${run.status === "completed" ? "done" : run.phase} · started ${minutesAgo(run.startedAt)}`
		: "Idle. The dispatcher sweeps every 10 minutes";

	const queued = state?.work.filter((item) => item.labels.includes("fm:todo") || item.labels.includes("fm:rebuild")).length ?? 0;
	const inFlight = state?.work.filter((item) => item.kind === "pr").length ?? 0;
	const blocked = state?.work.filter((item) => item.labels.includes("fm:blocked")).length ?? 0;

	const swept = state?.projects?.filter((p) => p.inSwarm).length ?? 1;

	const pill = "inline-flex h-8 items-center rounded-full border bg-background/90 shadow-sm backdrop-blur";
	const status = state ? `$${state.spentToday.toFixed(2)} today` : error ? "" : "Loading…";
	// The rest of the queue, shown when the spend is hovered.
	const details: [string, string | number][] = state
		? [
				...(swept > 1 ? [["Projects", swept] as [string, number]] : []),
				...(state.cycle ? [["Cycle", `${state.cycle.n}: ${state.cycle.phase}`] as [string, string]] : []),
				["Queued", queued],
				["PRs open", inFlight],
				["Blocked", blocked],
				["Spent today", `$${state.spentToday.toFixed(2)}`],
			]
		: [];
	const synced = syncedAt ? `Synced ${Math.max(0, Math.round((now - syncedAt) / 1000))}s ago. ` : "";

	return (
		<div className="relative flex min-h-0 flex-1">
			<div className="relative flex min-w-0 flex-1 flex-col">
			<SwarmCanvas
				state={state && only ? onlyProject(state, only) : state}
				repo={repo}
				fill
				onTalk={setTalkTo}
				title={
					<>
						<SidebarTrigger className={`${pill} size-8 shrink-0 justify-center`} />
						<HoverCard openDelay={150} closeDelay={100}>
							<HoverCardTrigger asChild>
								<span className={`${pill} min-w-0 cursor-default gap-2 px-3 text-sm text-muted-foreground`}>
									<span className={`size-1.5 shrink-0 rounded-full ${run && run.status !== "completed" ? "animate-pulse bg-red-500" : "bg-muted-foreground/50"}`} />
									<span className="font-semibold text-foreground">Swarm</span>
									<span className="min-w-0 truncate tabular-nums">
										<TextSwap value={status} />
									</span>
								</span>
							</HoverCardTrigger>
							{state ? (
								<HoverCardContent align="start" className="w-60 p-3 text-sm">
									<dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
										{details.map(([label, value]) => (
											<div key={label} className="contents">
												<dt className="text-muted-foreground">{label}</dt>
												<dd className="text-right tabular-nums">{value}</dd>
											</div>
										))}
									</dl>
									<p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
										{run ? `The board shows ${repo} as it is right now.` : "Until a run starts, the cursors replay how one issue moves through the hand-off rules; moves and costs are illustrative."}
									</p>
								</HoverCardContent>
							) : null}
						</HoverCard>
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
						<NotificationCenter />
					</>
				}
			/>
			{/* One composer at a time: while the side panel holds a chat (the swarm's or an agent's), it has its own. */}
			{talkTo === null ? (
				<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
					<div className="pointer-events-auto w-full max-w-2xl">
						<ChatComposer
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onSubmit={() => {
								setAsk({ id: Date.now(), text: draft.trim() });
								setDraft("");
								setTalkTo("swarm");
							}}
							onStop={() => {}}
							isLoading={false}
							model={model}
							onModelChange={setModel}
							placeholder="Ask about the agents…"
							context={
								<span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm font-medium text-secondary-foreground">
									{repo} swarm
								</span>
							}
						/>
					</div>
				</div>
			) : null}
			</div>
			{/* The agent's chat sits beside the canvas, which narrows to make room; on phones it covers the canvas. */}
			{talkTo ? (
				<aside
					aria-label={talkTo === "swarm" ? "Ask the swarm" : `Talk to the ${talkTo}`}
					className="absolute inset-2 z-30 flex flex-col overflow-hidden rounded-2xl border bg-background animate-in fade-in-0 slide-in-from-right-4 duration-200 motion-reduce:animate-none md:static md:inset-auto md:my-3 md:mr-3 md:w-[400px] md:shrink-0"
				>
					<div className="flex h-12 shrink-0 items-center gap-2 px-4">
						{talkTo === "swarm" ? null : <span className="size-2.5 rounded-full" style={{ backgroundColor: ROLE_COLORS[talkTo] }} />}
						<h2 className={`flex-1 text-sm font-semibold ${talkTo === "swarm" ? "" : "capitalize"}`}>{talkTo === "swarm" ? "Ask the swarm" : talkTo}</h2>
						<button type="button" onClick={() => setTalkTo(null)} aria-label="Close" className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
							<X className="size-4" />
						</button>
					</div>
					{talkTo === "swarm" ? <SwarmChat repo={repo} ask={ask} /> : <AgentChat key={talkTo} role={talkTo} repo={repo} />}
				</aside>
			) : null}
		</div>
	);
}
