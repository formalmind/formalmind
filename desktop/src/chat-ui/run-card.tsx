import { useState } from "react";
import { ChevronRight, Pause } from "lucide-react";
import { ToolStack } from "./tool-stack";
import type { Ev, Row } from "../swarm-panel";
import { ROLE_COLORS, roleName } from "@/lib/swarm-roles";

/** A note you sent the working agent: when (to place it after the step it reached) and whether it interrupted. */
export type Steer = { id: string; text: string; at: number; now?: boolean };
/** Steering the working agent: what you sent it, and sending more (`now` interrupts it; `queued`, with a note it has). */
export type Steering = { notes: Steer[]; send: (text: string, now: boolean, queued?: string) => void };

type Call = { call: Ev; result?: Ev };
type Status = "running" | "done" | "failed" | "stopped";

const colorOf = (role: string) => (ROLE_COLORS as Record<string, string>)[role];

/** What a step did, in words. */
const VERBS: Record<string, string> = {
	run: "Ran a command",
	read_file: "Read a file",
	write_file: "Wrote a file",
	search: "Searched the code",
	find: "Found files",
	functions: "Listed the functions",
	function: "Looked up a function",
	record_finding: "Recorded a finding",
	record_property: "Recorded a property",
	record_report: "Recorded a report",
	report_bug: "Reported a bug",
	verdict: "Gave a verdict",
};
const toolOf = (c: Call) => c.call.text.split(" ")[0];
const verbOf = (tool: string) => VERBS[tool] ?? `Used ${tool.replace(/_/g, " ")}`;

/** A step that failed: a command's non-zero exit or a tool's error. */
const failed = (r?: Ev) => Boolean(r && /^(exit [1-9]|error:)/m.test(r.text));

/** 12s, 1m 05s, 2h 05m, 3d 4h. */
const took = (ms: number) => {
	const t = Math.max(0, Math.round(ms / 1000));
	const m = Math.floor(t / 60);
	const h = Math.floor(m / 60);
	if (t < 60) return `${t}s`;
	if (m < 60) return `${m}m ${String(t % 60).padStart(2, "0")}s`;
	return h < 24 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const span = (calls: Call[], running: boolean) => {
	const from = calls[0]?.call.at;
	const to = running ? Date.now() : calls.at(-1)?.result?.at;
	return from && to ? took(to - from) : null;
};

const LABEL: Record<Status, string> = { running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };
const TONE: Record<Status, string> = {
	running: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
	done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	failed: "bg-red-500/10 text-red-700 dark:text-red-400",
	stopped: "bg-muted text-muted-foreground",
};
function Badge({ status, label }: { status: Status; label?: string }) {
	return <span className={`shrink-0 rounded-full px-2 leading-5 ${TONE[status]}`}>{label ?? LABEL[status]}</span>;
}

function PauseButton({ onPause }: { onPause: () => void }) {
	return (
		<button type="button" onClick={onPause} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border bg-background px-2 text-foreground hover:bg-muted">
			<Pause className="size-3" /> Pause
		</button>
	);
}

/** One step as a plain line ("Ran a command"), opening to what it ran and what came back; a failed one in red. */
function StepLine({ c, live, children }: { c: Call; live: boolean; children?: React.ReactNode }) {
	const bad = failed(c.result);
	const lost = !c.result && !live;
	const [open, setOpen] = useState(live);
	const time = c.call.at && c.result?.at ? took(c.result.at - c.call.at) : null;
	return (
		<li>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group flex w-full items-center gap-1.5 py-0.5 text-left text-muted-foreground hover:text-foreground">
				<ChevronRight className={`size-3.5 shrink-0 ${open ? "rotate-90" : ""}`} />
				<span className="min-w-0 truncate">{verbOf(toolOf(c))}</span>
				{bad || lost ? <span className="shrink-0 text-red-700 dark:text-red-400">Failed</span> : live ? <span className="shrink-0 text-violet-700 dark:text-violet-400">Running</span> : null}
				{time ? <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">{time}</span> : null}
			</button>
			{open ? (
				<div className="mb-1 ml-5 space-y-1">
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] leading-[18px] text-foreground">{c.call.text}</pre>
					{c.result ? (
						<pre className={`max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md px-2 py-1.5 font-mono text-[12px] leading-[18px] ${bad ? "bg-red-500/5 text-red-700 dark:text-red-400" : "bg-muted/60 text-muted-foreground"}`}>{c.result.text}</pre>
					) : lost ? (
						<p className="text-red-700 dark:text-red-400">No result: the session stopped before it finished.</p>
					) : null}
				</div>
			) : null}
			{children}
		</li>
	);
}

/** The steps as one group ("Used 6 tools · 2 failed · 1m 05s") that opens to a line per step. */
function StepGroup({ calls, running }: { calls: Call[]; running: boolean }) {
	const [open, setOpen] = useState(true);
	const broke = calls.filter((c) => failed(c.result)).length;
	const time = span(calls, running);
	const tools = [...new Set(calls.map(toolOf))];
	const label = running ? "Working…" : `Used ${calls.length} ${calls.length === 1 ? "tool" : "tools"}`;
	return (
		<div>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 py-0.5 text-left text-muted-foreground hover:text-foreground">
				<ToolStack tools={tools} />
				<span className="min-w-0 truncate">
					{label}
					{broke ? <span className="text-red-700 dark:text-red-400"> · {broke} failed</span> : null}
					{time ? ` · ${time}` : ""}
				</span>
				<ChevronRight className={`size-3.5 shrink-0 ${open ? "rotate-90" : ""}`} />
			</button>
			{open ? (
				<ul className="mt-0.5">
					{calls.map((c, i) => (
						<StepLine key={i} c={c} live={running && i === calls.length - 1 && !c.result} />
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The working agent's steps with a field to steer it. A note waits in the queue until the agent's next step starts
 * after it (the swarm reads your messages between steps), then shows under that step. ↵ queues, ⌘↵ interrupts now.
 */
function SteerCard({ calls, title, role, steering, onPause }: { calls: Call[]; title: string; role: string; steering: Steering; onPause?: () => void }) {
	const [text, setText] = useState("");
	const after = (n: Steer) => calls.findIndex((c) => (c.call.at ?? 0) > n.at);
	const queue = steering.notes.filter((n) => after(n) < 0);
	const time = span(calls, true);
	const send = (now: boolean) => {
		const t = text.trim();
		if (!t) return;
		setText("");
		steering.send(t, now);
	};
	return (
		<div className="overflow-hidden rounded-xl border bg-card">
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<span className="shrink-0" style={{ color: colorOf(role) }}>
					{roleName(role)}
				</span>
				<span className="min-w-0 truncate text-foreground">{title}</span>
				{time ? <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span> : null}
				<span className="ml-auto" />
				<Badge status="running" />
				{onPause ? <PauseButton onPause={onPause} /> : null}
			</div>
			<ul className="px-3 py-2">
				{calls.map((c, i) => (
					<StepLine key={i} c={c} live={i === calls.length - 1 && !c.result}>
						{steering.notes
							.filter((n) => after(n) === i)
							.map((n) => (
								<p key={n.id} className="ml-5 border-l-2 py-0.5 pl-2 text-foreground">
									{n.text}
									<span className="text-muted-foreground"> · {n.now ? "Interrupted" : "Read at this step"}</span>
								</p>
							))}
					</StepLine>
				))}
			</ul>
			{queue.length ? (
				<ul className="space-y-1 border-t px-3 py-2">
					{queue.map((n) => (
						<li key={n.id} className="flex items-center gap-2">
							<span className="shrink-0 text-muted-foreground">Next step</span>
							<span className="min-w-0 flex-1 truncate text-foreground">{n.text}</span>
							<button type="button" onClick={() => steering.send(n.text, true, n.id)} title="Interrupt the agent with this note now" className="shrink-0 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
								Now
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex items-center gap-2 border-t px-3 py-1.5">
				<input
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
						e.preventDefault();
						send(e.metaKey || e.ctrlKey);
					}}
					placeholder={`Steer the ${roleName(role)}…`}
					aria-label={`Steer the ${roleName(role)}`}
					className="h-7 min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
				/>
				<button type="button" disabled={!text.trim()} onClick={() => send(false)} title="For its next step (↵)" className="h-6 shrink-0 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
					Queue
				</button>
				<button type="button" disabled={!text.trim()} onClick={() => send(true)} title="Interrupt now (⌘↵)" className="h-6 shrink-0 rounded-md border bg-background px-2 text-foreground hover:bg-muted disabled:opacity-50">
					Interrupt
				</button>
			</div>
		</div>
	);
}

type Agent = { id: string; task: string; meta: string; status: Status; error?: string; tools: string[] };

/** One row of the Agents tree: its name in its role colour, what it is on, steps and time, its status. */
function AgentRow({ a, picked, onPick, name, color }: { a: Agent; picked: boolean; onPick: () => void; name: string; color?: string }) {
	return (
		<button type="button" onClick={onPick} aria-pressed={picked} className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${picked ? "bg-muted" : "hover:bg-muted/60"}`}>
			<span className="shrink-0" style={{ color }}>
				{name}
			</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">{a.task}</span>
			<span className="hidden shrink-0 [@container(min-width:420px)]:inline-flex">
				<ToolStack tools={a.tools} />
			</span>
			{a.meta ? <span className="shrink-0 tabular-nums text-muted-foreground/70">{a.meta}</span> : null}
			<Badge status={a.status} />
		</button>
	);
}

/**
 * Steps from several agents (the swarm runs them side by side) as the Agents tree: the swarm on top, a row per agent
 * under it. Picking a row shows that agent's steps under the tree (the swarm's row, every agent's). A failed agent
 * opens a window with its error, Retry and Dismiss.
 */
function TeamCard({ calls, notes, roles, running, title, onPause, onRetry, steering }: { calls: Call[]; notes: Ev[]; roles: string[]; running: boolean; title?: string; onPause?: () => void; onRetry?: (role: string, item?: string) => void; steering?: Steering }) {
	const latest = calls.at(-1)?.call.role ?? roles[0];
	const [picked, setPicked] = useState(latest);
	const [dismissed, setDismissed] = useState<string[]>([]);
	const agents: Agent[] = roles.map((role) => {
		const mine = calls.filter((c) => c.call.role === role);
		const live = running && role === latest;
		const broke = mine.filter((c) => failed(c.result)).at(-1);
		const status: Status = live ? "running" : mine.some((c) => !c.result) ? "stopped" : broke && !dismissed.includes(role) ? "failed" : "done";
		const steps = `${mine.length} ${mine.length === 1 ? "step" : "steps"}`;
		const time = span(mine, live);
		const item = mine[0]?.call.item;
		return {
			id: role,
			task: notes.filter((n) => n.role === role).at(-1)?.text ?? (item ? `item ${item}` : ""),
			meta: time ? `${steps} · ${time}` : steps,
			status,
			error: broke?.result?.text.split("\n").slice(0, 3).join("\n"),
			tools: [...new Set(mine.map(toolOf))],
		};
	});
	const rootStatus: Status = running ? "running" : agents.some((a) => a.status === "failed") ? "failed" : agents.some((a) => a.status === "stopped") ? "stopped" : "done";
	const root: Agent = { id: "swarm", task: title ?? `${roles.length} agents`, meta: span(calls, running) ?? "", status: rootStatus, tools: [] };
	const shown = picked === "swarm" ? calls : calls.filter((c) => c.call.role === picked);
	return (
		<div className="space-y-2">
			<section className="rounded-xl border bg-card p-1.5" style={{ containerType: "inline-size" }}>
				<div className="flex items-center gap-2 px-2 pb-1 pt-0.5">
					<span className="text-muted-foreground">Agents</span>
					{running && onPause && !steering ? (
						<span className="ml-auto">
							<PauseButton onPause={onPause} />
						</span>
					) : null}
				</div>
				<AgentRow a={root} name="swarm" picked={picked === "swarm"} onPick={() => setPicked("swarm")} />
				<ul className="ml-3 border-l pl-1.5">
					{agents.map((a) => (
						<li key={a.id}>
							<AgentRow a={a} name={roleName(a.id)} color={colorOf(a.id)} picked={picked === a.id} onPick={() => setPicked(a.id)} />
							{a.status === "failed" && a.error ? (
								<div className="mx-2 mb-1 mt-0.5 rounded-md border border-red-500/30 bg-red-500/5 p-2">
									<pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-red-700 dark:text-red-400">{a.error}</pre>
									<div className="mt-1.5 flex justify-end gap-1.5">
										<button type="button" onClick={() => setDismissed((d) => [...d, a.id])} className="h-6 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground">
											Dismiss
										</button>
										{onRetry ? (
											<button type="button" onClick={() => onRetry(a.id, calls.find((c) => c.call.role === a.id)?.call.item)} className="h-6 rounded-md border bg-background px-2 text-foreground hover:bg-muted">
												Retry
											</button>
										) : null}
									</div>
								</div>
							) : null}
						</li>
					))}
				</ul>
			</section>
			{shown.length && running && steering && picked === latest ? (
				<SteerCard calls={shown} title={agents.find((a) => a.id === picked)?.task || title || "Working"} role={picked} steering={steering} onPause={onPause} />
			) : shown.length ? (
				<div className="space-y-1">
					<span style={{ color: colorOf(picked) }}>{picked === "swarm" ? "Every agent" : roleName(picked)}</span>
					<StepGroup calls={shown} running={running && picked === latest} />
				</div>
			) : null}
		</div>
	);
}

/**
 * One agent run: what it works on, its status, its latest note, then its steps as one group. Several agents' steps go
 * to the Agents tree; the agent at work, with `steering`, to the steering card.
 */
export function RunCard({ steps, running, title, onPause, onRetry, steering }: { steps: Row[]; running: boolean; title?: string; onPause?: () => void; onRetry?: (role: string, item?: string) => void; steering?: Steering }) {
	const calls = steps.filter((r): r is Call => "call" in r);
	const notes = steps.filter((r): r is { note: Ev } => "note" in r).map((r) => r.note);
	const roles = [...new Set(calls.map((c) => c.call.role))];
	let body: React.ReactNode;
	if (roles.length > 1) body = <TeamCard calls={calls} notes={notes} roles={roles} running={running} title={title} onPause={onPause} onRetry={onRetry} steering={steering} />;
	else if (running && steering && calls.length)
		body = <SteerCard calls={calls} title={title ?? (calls[0].call.item ? `item ${calls[0].call.item}` : "Working")} role={calls[0].call.role} steering={steering} onPause={onPause} />;
	else {
		const item = (calls[0]?.call ?? notes[0])?.item ?? "";
		const broke = calls.filter((c) => failed(c.result)).length;
		const status: Status = running ? "running" : calls.some((c) => !c.result) ? "stopped" : broke ? "failed" : "done";
		const note = notes.at(-1)?.text;
		body = (
			<div className="space-y-1.5">
				<div className="flex items-center gap-2">
					{title || item ? <span className="min-w-0 truncate text-foreground">{title ?? `item ${item}`}</span> : null}
					<Badge status={status} label={status === "failed" ? `${broke} failed` : undefined} />
					{running && onPause ? (
						<span className="ml-auto">
							<PauseButton onPause={onPause} />
						</span>
					) : null}
				</div>
				{note ? <p className="line-clamp-2 text-muted-foreground">{note}</p> : null}
				{calls.length ? <StepGroup calls={calls} running={running} /> : null}
			</div>
		);
	}
	return <div className="text-[13px] font-normal leading-5">{body}</div>;
}
