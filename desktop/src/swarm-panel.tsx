import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Square, Play, Send, Bug as BugIcon } from "lucide-react";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { apiBase } from "./api";
import { localBoard } from "./local-board";

type Ev = { run: string; kind: "status" | "say" | "tool" | "result" | "you" | "bug" | "plan" | "done"; role: string; item: string; text: string; spent: number };
type Item = { index: number; mark: string; text: string };
type Bug = { file: string; title: string; body: string };

const BUDGETS = [2, 5, 10, 20];
const colorOf = (role: string) => (ROLE_COLORS as Record<string, string>)[role] ?? "hsl(var(--muted-foreground))";

/** The local swarm on this folder: start it, watch the plan and the agents, read bugs, and talk to it. */
export function SwarmPanel({ folder }: { folder: string }) {
	const [run, setRun] = useState<string | null>(null);
	const [events, setEvents] = useState<Ev[]>([]);
	const [plan, setPlan] = useState<Item[]>([]);
	const [bugs, setBugs] = useState<Bug[]>([]);
	const [goal, setGoal] = useState("");
	const [budget, setBudget] = useState(5);
	const [say, setSay] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const [provider, setProvider] = useState<"formal" | "anthropic">(() => {
		try {
			return localStorage.getItem("fm:provider") === "anthropic" ? "anthropic" : "formal";
		} catch {
			return "formal";
		}
	});
	const [hasKey, setHasKey] = useState(false);
	const [key, setKey] = useState("");
	useEffect(() => void invoke<boolean>("anthropic_key_status").then(setHasKey), []);
	const pick = (p: "formal" | "anthropic") => {
		setProvider(p);
		try {
			localStorage.setItem("fm:provider", p);
		} catch {
			/* kept for this view only */
		}
	};
	const runRef = useRef<string | null>(null);
	const log = useRef<HTMLDivElement>(null);

	const refresh = () => {
		void invoke<Item[]>("swarm_plan", { folder }).then(setPlan, () => {});
		void invoke<Bug[]>("swarm_bugs", { folder }).then(setBugs, () => {});
	};

	useEffect(() => {
		refresh();
		void invoke<string | null>("swarm_running").then((r) => {
			runRef.current = r;
			setRun(r);
		});
		const off = listen<Ev>("swarm", ({ payload }) => {
			if (runRef.current && payload.run !== runRef.current) return;
			setEvents((all) => [...all.slice(-400), payload]);
			if (["plan", "bug", "done", "status"].includes(payload.kind)) refresh();
			if (payload.kind === "done") setRun(null);
		});
		return () => void off.then((f) => f());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder]);
	useEffect(() => log.current?.scrollTo({ top: log.current.scrollHeight }), [events]);

	const start = async () => {
		setError(null);
		setEvents([]);
		try {
			const id = await invoke<string>("swarm_start", { request: { folder, goal: goal.trim() || null, budget_usd: budget, api_base: apiBase(), provider } });
			runRef.current = id;
			setRun(id);
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

	const last = events.at(-1);
	const working = [...events].reverse().find((e) => e.kind === "status");
	const done = plan.filter((i) => i.mark === "x").length;
	const finished = events.find((e) => e.kind === "done");

	return (
		<div className="space-y-4">
			<section className="rounded-2xl border bg-muted/60 p-1.5">
				<header className="flex h-9 items-center justify-between pl-2.5 pr-1">
					<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Swarm on this computer</p>
					{run ? (
						<span className="flex items-center gap-2 text-xs text-muted-foreground">
							<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
							{working?.role ?? "starting"} {working?.item && working.item !== "plan" ? `· item ${working.item}` : ""} · ${(last?.spent ?? 0).toFixed(2)} of ${budget}
						</span>
					) : null}
				</header>
				<div className="shadow-card space-y-3 rounded-xl border bg-card p-4">
					{run ? (
						<div className="flex gap-2">
							<input
								value={say}
								onChange={(e) => setSay(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && void send()}
								placeholder="Message the swarm: a question, a new focus, an idea to check…"
								className="min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
							/>
							<button type="button" onClick={() => void send()} disabled={!say.trim()} className="btn-soft h-9 gap-1.5 px-3 text-sm"><Send className="size-3.5" />Send</button>
							<button type="button" onClick={() => void invoke("swarm_stop", { run })} className="btn-soft h-9 gap-1.5 px-3 text-sm"><Square className="size-3.5" />Stop</button>
						</div>
					) : (
						<>
							<input
								value={goal}
								onChange={(e) => setGoal(e.target.value)}
								placeholder="Focus (optional): e.g. liquidations and interest accrual in V4Vault"
								className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
							/>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-muted-foreground">Claude via</span>
								{/* One control: the provider dropdown, which becomes the key field when your own key is picked and missing. */}
								{provider === "anthropic" && !hasKey ? (
									<form
										className="inline-flex h-8 items-center overflow-hidden rounded-lg border bg-background text-xs"
										onSubmit={(e) => {
											e.preventDefault();
											if (!key.trim()) return;
											void invoke("anthropic_key_set", { key }).then(() => {
												setKey("");
												setHasKey(true);
											});
										}}
									>
										<input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your Anthropic key (sk-ant-…)" className="h-full w-60 bg-transparent px-2.5 outline-none" />
										<button type="submit" disabled={!key.trim()} className="h-full border-l px-2.5 font-medium disabled:opacity-40">Save</button>
										<button type="button" onClick={() => pick("formal")} title="Back to formal.team credits" className="h-full border-l px-2 text-muted-foreground hover:text-foreground">×</button>
									</form>
								) : (
									<select
										value={provider}
										onChange={(e) => pick(e.target.value as "formal" | "anthropic")}
										className="h-8 rounded-lg border bg-background px-2 text-xs outline-none"
									>
										<option value="formal">formal.team credits</option>
										<option value="anthropic">My Anthropic key{hasKey ? " (saved)" : ""}</option>
									</select>
								)}
								{provider === "anthropic" && hasKey ? (
									<button type="button" onClick={() => void invoke("anthropic_key_set", { key: "" }).then(() => setHasKey(false))} className="text-xs text-muted-foreground hover:underline">Forget key</button>
								) : null}
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-muted-foreground">Stop at</span>
								<div className="inline-flex rounded-lg bg-muted p-0.5 text-xs">
									{BUDGETS.map((b) => (
										<button key={b} type="button" onClick={() => setBudget(b)} className={`rounded-md px-2.5 py-1 ${b === budget ? "shadow-card bg-background font-medium" : "text-muted-foreground"}`}>${b}</button>
									))}
								</div>
								<button type="button" onClick={() => void start()} disabled={provider === "anthropic" && !hasKey} className="btn-dark ml-auto disabled:opacity-50 h-9 gap-1.5 px-4 text-sm"><Play className="size-3.5" />{plan.length ? "Resume the swarm" : "Start the swarm"}</button>
							</div>
							<p className="text-xs text-muted-foreground">
								Planner, prover and reviewer work through the plan one item at a time until it's proven or someone finds a bug. Files, Lean and Foundry run here; only model calls go out: through formal.team (shown in Billing) or straight to Anthropic with your key.
							</p>
						</>
					)}
					{error ? <p className="text-sm text-red-600">{error}</p> : null}
					{finished && !run ? <p className="rounded-lg bg-muted px-3 py-2 text-sm">Finished: {finished.text}</p> : null}
				</div>
			</section>

			{bugs.length ? (
				<section className="rounded-2xl border border-red-500/30 bg-red-500/5 p-1.5">
					<header className="flex h-9 items-center gap-2 pl-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-red-700 dark:text-red-400"><BugIcon className="size-3.5" />Bugs found · {bugs.length}</header>
					<ul className="space-y-1.5">
						{bugs.map((b) => (
							<li key={b.file} className="shadow-card rounded-xl border bg-card">
								<button type="button" onClick={() => setOpen(open === b.file ? null : b.file)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm">
									<span className="flex-1 font-medium">{b.title}</span>
									<span className="font-mono text-[11px] text-muted-foreground">{b.file}</span>
									<ChevronDown className={`size-4 text-muted-foreground transition-transform ${open === b.file ? "rotate-180" : ""}`} />
								</button>
								{open === b.file ? <pre className="whitespace-pre-wrap border-t px-4 py-3 font-sans text-sm leading-6">{b.body}</pre> : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			<section className="rounded-2xl border bg-muted/60 p-1.5">
				<header className="flex h-9 items-center pl-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Board</header>
				<div className="shadow-card relative flex h-[520px] overflow-hidden rounded-xl border bg-card">
					<SwarmCanvas state={localBoard(folder, plan, events, Boolean(run))} fill repo={folder} />
				</div>
			</section>

			<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
				<section className="rounded-2xl border bg-muted/60 p-1.5">
					<header className="flex h-9 items-center pl-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Activity</header>
					<div ref={log} className="shadow-card h-96 space-y-2 overflow-y-auto rounded-xl border bg-card p-4 text-sm">
						{events.length === 0 ? <p className="text-muted-foreground">Nothing yet. Start the swarm to watch the agents work.</p> : null}
						{events.filter((e) => e.kind !== "result" && e.kind !== "status").map((e, i) => (
							<div key={i} className={e.kind === "tool" ? "pl-4 font-mono text-xs text-muted-foreground" : e.kind === "you" ? "ml-auto w-fit max-w-[85%] rounded-xl bg-muted px-3 py-2" : ""}>
								{e.kind === "say" || e.kind === "bug" || e.kind === "plan" || e.kind === "done" ? (
									<p className="mb-0.5 flex items-center gap-1.5 text-xs font-medium capitalize" style={{ color: e.kind === "bug" ? "#dc2626" : colorOf(e.role) }}>
										<span className="size-1.5 rounded-full" style={{ background: e.kind === "bug" ? "#dc2626" : colorOf(e.role) }} />
										{e.kind === "bug" ? "bug reported" : e.role}{e.item && e.item !== "you" ? ` · ${e.item === "plan" ? "plan" : `item ${e.item}`}` : ""}
									</p>
								) : null}
								<p className="whitespace-pre-wrap">{e.kind === "tool" ? `› ${e.text}` : e.text}</p>
							</div>
						))}
					</div>
				</section>
				<section className="rounded-2xl border bg-muted/60 p-1.5">
					<header className="flex h-9 items-center justify-between pl-2.5 pr-2 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						Plan <span>{plan.length ? `${done}/${plan.length}` : ""}</span>
					</header>
					<ul className="shadow-card h-96 space-y-1 overflow-y-auto rounded-xl border bg-card p-3 text-sm">
						{plan.length === 0 ? <li className="text-muted-foreground">The planner writes .formal/plan.md on the first run.</li> : null}
						{plan.map((i) => (
							<li key={i.index} className="flex gap-2 rounded-md px-1 py-1">
								<span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${i.mark === "x" ? "border-emerald-500 bg-emerald-500 text-white" : i.mark === "!" ? "border-amber-500 text-amber-600" : ""}`}>{i.mark === "x" ? "✓" : i.mark === "!" ? "!" : ""}</span>
								<span className={i.mark === "x" ? "text-muted-foreground" : ""}>{i.text}</span>
							</li>
						))}
					</ul>
				</section>
			</div>
		</div>
	);
}
