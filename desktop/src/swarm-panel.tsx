import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bug as BugIcon, ChevronDown, FileCode2, Play, Send, Square } from "lucide-react";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import { apiBase } from "./api";
import { localBoard } from "./local-board";
import type { Scan } from "./local";

type Ev = { run: string; kind: "status" | "say" | "tool" | "result" | "you" | "bug" | "plan" | "done"; role: string; item: string; text: string; spent: number };
type Item = { index: number; mark: string; text: string };
type Bug = { file: string; title: string; body: string };
type Provider = "formal" | "anthropic";
type Session = { run: string; outcome: string; spent: number; events: number };

const BUDGETS = [2, 5, 10, 20];
const colorOf = (role: string) => (ROLE_COLORS as Record<string, string>)[role] ?? "hsl(var(--muted-foreground))";
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };

const Label = ({ children }: { children: React.ReactNode }) => (
	<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</span>
);

/** A card on the canvas: gray container with its title, white card inside. */
function Card({ title, right, className = "", children }: { title: React.ReactNode; right?: React.ReactNode; className?: string; children: React.ReactNode }) {
	return (
		<section className={`flex min-h-0 flex-col rounded-2xl border bg-muted/60 p-1.5 ${className}`}>
			<header className="flex h-8 shrink-0 items-center justify-between gap-2 pl-2 pr-1">{title}{right}</header>
			<div className="shadow-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">{children}</div>
		</section>
	);
}

/**
 * A local folder's swarm: the canvas on the left (the board, the contract files, bugs) and the chat on the right (start
 * and steer the swarm, the plan, and what each agent says as it works).
 */
export function SwarmPanel({ folder, name, scan }: { folder: string; name: string; scan: Scan | null }) {
	const [run, setRun] = useState<string | null>(null);
	const [events, setEvents] = useState<Ev[]>([]);
	const [plan, setPlan] = useState<Item[]>([]);
	const [bugs, setBugs] = useState<Bug[]>([]);
	const [goal, setGoal] = useState("");
	const [budget, setBudget] = useState(5);
	const [say, setSay] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [openBug, setOpenBug] = useState<string | null>(null);
	const [showPlan, setShowPlan] = useState(true);
	const [showTools, setShowTools] = useState(false);
	const [provider, setProvider] = useState<Provider>(() => (store.get("fm:provider") === "anthropic" ? "anthropic" : "formal"));
	const [hasKey, setHasKey] = useState(false);
	const [key, setKey] = useState("");
	const [sessions, setSessions] = useState<Session[]>([]);
	const [viewing, setViewing] = useState<string | null>(null);
	const runRef = useRef<string | null>(null);
	const chat = useRef<HTMLDivElement>(null);

	/** Shows a session's saved events (.formal/runs/<run>.jsonl), so quitting the app loses nothing. */
	const load = (id: string) => {
		setViewing(id);
		void invoke<Ev[]>("swarm_history", { folder, run: id }).then((evs) => setEvents(evs.slice(-600)), () => setEvents([]));
	};
	const listSessions = () => invoke<Session[]>("swarm_sessions", { folder }).then((list) => (setSessions(list), list), () => []);

	const refresh = () => {
		void invoke<Item[]>("swarm_plan", { folder }).then(setPlan, () => {});
		void invoke<Bug[]>("swarm_bugs", { folder }).then(setBugs, () => {});
	};
	const pick = (p: Provider) => {
		setProvider(p);
		store.set("fm:provider", p);
	};

	useEffect(() => {
		refresh();
		void invoke<boolean>("anthropic_key_status").then(setHasKey);
		void invoke<string | null>("swarm_running").then(async (r) => {
			runRef.current = r;
			setRun(r);
			const list = await listSessions();
			// Reopen where you left off: the running session, else the latest one.
			const id = r ?? list[0]?.run;
			if (id) load(id);
		});
		const off = listen<Ev>("swarm", ({ payload }) => {
			if (runRef.current && payload.run !== runRef.current) return;
			setEvents((all) => [...all.slice(-600), payload]);
			if (["plan", "bug", "done", "status"].includes(payload.kind)) refresh();
			if (payload.kind === "done") {
				setRun(null);
				void listSessions();
			}
		});
		return () => void off.then((f) => f());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder]);
	useEffect(() => chat.current?.scrollTo({ top: chat.current.scrollHeight }), [events, showTools]);

	const start = async () => {
		setError(null);
		setEvents([]);
		try {
			const id = await invoke<string>("swarm_start", { request: { folder, goal: goal.trim() || null, budget_usd: budget, api_base: apiBase(), provider } });
			runRef.current = id;
			setRun(id);
			setViewing(id);
			void listSessions();
		} catch (e) {
			setError(String(e));
		}
	};
	const send = async () => {
		const text = say.trim();
		if (!text || !run) return;
		setSay("");
		setEvents((all) => [...all, { run, kind: "you", role: "you", item: "", text, spent: all.at(-1)?.spent ?? 0 }]);
		await invoke("swarm_say", { run, text }).catch((e) => setError(String(e)));
	};

	const spent = events.at(-1)?.spent ?? 0;
	const working = [...events].reverse().find((e) => e.kind === "status" && e.role !== "swarm");
	const done = plan.filter((i) => i.mark === "x").length;
	const finished = !run ? events.find((e) => e.kind === "done") : undefined;
	const shown = events.filter((e) => e.kind !== "status" && (showTools || (e.kind !== "tool" && e.kind !== "result")));

	return (
		<div className="flex h-full min-h-0 flex-1">
			{/* The canvas: a dotted field with cards on it. */}
			<div className="min-w-0 flex-1 overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] p-4 [background-size:16px_16px]">
				<div className="grid min-h-full grid-cols-[minmax(0,1fr)_16rem] grid-rows-[minmax(28rem,1fr)_auto] gap-4">
					<Card
						className="col-span-2 xl:col-span-1"
						title={<Label>{name} · swarm</Label>}
						right={run ? (
							<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
								{working ? `${working.role}${/^\d+$/.test(working.item) ? ` · item ${working.item}` : ""}` : "starting"}
							</span>
						) : null}
					>
						<div className="relative flex min-h-0 flex-1">
							<SwarmCanvas state={localBoard(folder, plan, events, Boolean(run))} fill repo={folder} />
						</div>
					</Card>
					<Card className="col-span-2 xl:col-span-1 xl:row-span-2" title={<Label>Files</Label>} right={scan ? <span className="text-[11px] text-muted-foreground">{scan.solidity.length} sol · {scan.lean.length} lean</span> : null}>
						<ul className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px]">
							{scan === null ? <li className="p-2 text-muted-foreground">Reading the folder…</li> : null}
							{[...(scan?.solidity ?? []), ...(scan?.lean ?? [])].map((f) => (
								<li key={f} className="flex items-center gap-1.5 truncate rounded px-1.5 py-1 hover:bg-muted" title={f}>
									<FileCode2 className={`size-3 shrink-0 ${f.endsWith(".lean") ? "text-violet-500" : "text-sky-500"}`} />
									<span className="truncate">{f}</span>
								</li>
							))}
						</ul>
					</Card>
					{bugs.length ? (
						<Card className="col-span-2 xl:col-span-1 border-red-500/30 bg-red-500/5" title={<span className="flex items-center gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-red-700 dark:text-red-400"><BugIcon className="size-3.5" />Bugs · {bugs.length}</span>}>
							<ul className="divide-y">
								{bugs.map((b) => (
									<li key={b.file}>
										<button type="button" onClick={() => setOpenBug(openBug === b.file ? null : b.file)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm">
											<span className="flex-1 font-medium">{b.title}</span>
											<span className="font-mono text-[11px] text-muted-foreground">{b.file}</span>
											<ChevronDown className={`size-4 text-muted-foreground transition-transform ${openBug === b.file ? "rotate-180" : ""}`} />
										</button>
										{openBug === b.file ? <pre className="whitespace-pre-wrap border-t px-4 py-3 font-sans text-sm leading-6">{b.body}</pre> : null}
									</li>
								))}
							</ul>
						</Card>
					) : null}
				</div>
			</div>

			{/* The chat: start and steer the swarm, the plan, and the agents' messages. */}
			<aside className="flex w-[24rem] shrink-0 flex-col border-l bg-background">
				{sessions.length ? (
					<div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
						<Label>Session</Label>
						<select value={viewing ?? ""} onChange={(e) => load(e.target.value)} disabled={Boolean(run)} className="h-7 min-w-0 flex-1 rounded-lg border bg-background px-1.5 text-xs outline-none">
							{sessions.map((x) => (
								<option key={x.run} value={x.run}>
									{new Date(parseInt(x.run.replace("local-", ""), 16)).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })} · ${x.spent.toFixed(2)}{x.run === run ? " · running" : x.outcome ? ` · ${x.outcome.slice(0, 28)}` : " · stopped"}
								</option>
							))}
						</select>
					</div>
				) : null}
				<button type="button" onClick={() => setShowPlan(!showPlan)} className="flex h-11 shrink-0 items-center justify-between border-b px-4 text-left">
					<Label>Plan {plan.length ? `· ${done}/${plan.length}` : ""}</Label>
					<ChevronDown className={`size-4 text-muted-foreground transition-transform ${showPlan ? "rotate-180" : ""}`} />
				</button>
				{showPlan ? (
					<ul className="max-h-[38%] shrink-0 space-y-0.5 overflow-y-auto border-b p-2 text-[13px]">
						{plan.length === 0 ? <li className="p-2 text-muted-foreground">The planner writes .formal/plan.md on the first run.</li> : null}
						{plan.map((i) => (
							<li key={i.index} className={`flex gap-2 rounded-md px-2 py-1 ${working && working.item === String(i.index) ? "bg-muted" : ""}`}>
								<span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${i.mark === "x" ? "border-emerald-500 bg-emerald-500 text-white" : i.mark === "!" ? "border-amber-500 text-amber-600" : ""}`}>{i.mark === "x" ? "✓" : i.mark === "!" ? "!" : ""}</span>
								<span className={`line-clamp-2 ${i.mark === "x" ? "text-muted-foreground" : ""}`} title={i.text}>{i.text}</span>
							</li>
						))}
					</ul>
				) : null}

				<div ref={chat} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
					{shown.length === 0 && !run ? <p className="text-muted-foreground">Start the swarm and its agents talk here. Message them anytime to steer.</p> : null}
					{shown.map((e, i) =>
						e.kind === "you" ? (
							<div key={i} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-foreground px-3 py-2 text-background">{e.text}</div>
						) : e.kind === "tool" || e.kind === "result" ? (
							<p key={i} className="truncate pl-4 font-mono text-[11px] text-muted-foreground">{e.kind === "tool" ? `› ${e.text}` : e.text.split("\n")[0]}</p>
						) : (
							<div key={i} className="max-w-[92%]">
								<p className="mb-1 flex items-center gap-1.5 text-xs font-medium capitalize" style={{ color: e.kind === "bug" ? "#dc2626" : colorOf(e.role) }}>
									<span className="size-1.5 rounded-full" style={{ background: e.kind === "bug" ? "#dc2626" : colorOf(e.role) }} />
									{e.kind === "bug" ? "bug reported" : e.role}
									{/^\d+$/.test(e.item) ? <span className="font-normal text-muted-foreground">· item {e.item}</span> : null}
								</p>
								<div className={`whitespace-pre-wrap rounded-2xl rounded-tl-md px-3 py-2 ${e.kind === "bug" ? "bg-red-500/10" : e.kind === "plan" || e.kind === "done" ? "bg-muted/60 text-muted-foreground" : "bg-muted"}`}>{e.text}</div>
							</div>
						),
					)}
					{finished ? <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">Finished: {finished.text}</p> : null}
				</div>

				<div className="shrink-0 space-y-2 border-t p-3">
					{error ? <p className="text-xs text-red-600">{error}</p> : null}
					{run ? (
						<>
							<div className="flex items-end gap-2 rounded-2xl border bg-background p-1.5 focus-within:border-foreground/30">
								<textarea
									rows={2}
									value={say}
									onChange={(e) => setSay(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											void send();
										}
									}}
									placeholder="Steer the swarm: a question, a new focus, an idea to check…"
									className="min-h-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none"
								/>
								<button type="button" onClick={() => void send()} disabled={!say.trim()} className="btn-dark size-8 shrink-0 justify-center p-0 disabled:opacity-40" aria-label="Send"><Send className="size-3.5" /></button>
							</div>
							<div className="flex items-center justify-between text-[11px] text-muted-foreground">
								<button type="button" onClick={() => setShowTools(!showTools)} className="hover:text-foreground">{showTools ? "Hide" : "Show"} tool calls</button>
								<span>${spent.toFixed(2)} of ${budget}</span>
								<button type="button" onClick={() => void invoke("swarm_stop", { run })} className="inline-flex items-center gap-1 hover:text-foreground"><Square className="size-3" />Stop</button>
							</div>
						</>
					) : (
						<>
							<textarea
								rows={2}
								value={goal}
								onChange={(e) => setGoal(e.target.value)}
								placeholder="Focus (optional): e.g. liquidations and interest accrual in V4Vault"
								className="w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
							/>
							<div className="flex flex-wrap items-center gap-1.5 text-xs">
								{provider === "anthropic" && !hasKey ? (
									<form
										className="inline-flex h-7 flex-1 items-center overflow-hidden rounded-lg border"
										onSubmit={(e) => {
											e.preventDefault();
											if (key.trim()) void invoke("anthropic_key_set", { key }).then(() => { setKey(""); setHasKey(true); });
										}}
									>
										<input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="Anthropic key (sk-ant-…)" className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none" />
										<button type="submit" disabled={!key.trim()} className="h-full border-l px-2 font-medium disabled:opacity-40">Save</button>
										<button type="button" onClick={() => pick("formal")} className="h-full border-l px-2 text-muted-foreground">×</button>
									</form>
								) : (
									<select value={provider} onChange={(e) => pick(e.target.value as Provider)} className="h-7 rounded-lg border bg-background px-1.5 outline-none">
										<option value="formal">formal.team credits</option>
										<option value="anthropic">My Anthropic key{hasKey ? " (saved)" : ""}</option>
									</select>
								)}
								<select value={budget} onChange={(e) => setBudget(Number(e.target.value))} className="h-7 rounded-lg border bg-background px-1.5 outline-none" title="Stop at">
									{BUDGETS.map((b) => <option key={b} value={b}>stop at ${b}</option>)}
								</select>
								<button type="button" onClick={() => void start()} disabled={provider === "anthropic" && !hasKey} className="btn-dark ml-auto h-8 gap-1.5 px-3 disabled:opacity-50"><Play className="size-3.5" />{plan.some((i) => i.mark === " ") ? "Resume" : "Start"}</button>
							</div>
							{provider === "anthropic" && hasKey ? (
								<button type="button" onClick={() => void invoke("anthropic_key_set", { key: "" }).then(() => setHasKey(false))} className="text-[11px] text-muted-foreground hover:underline">Forget Anthropic key</button>
							) : null}
						</>
					)}
				</div>
			</aside>
		</div>
	);
}
