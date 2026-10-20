import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, FileCode2, Play, Square } from "lucide-react";
import { ChatComposer } from "@/components/chat-composer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChatMarkdown } from "@/components/chat-markdown";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import { localBoard } from "./local-board";
import type { Scan } from "./local";

/** What the panel needs from its host: the desktop app's Tauri commands and events, or the web demo's stand-ins. */
export type Bridge = {
	invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
	listen: <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;
	apiBase: () => string;
};

type Ev = { run: string; kind: "status" | "say" | "tool" | "result" | "you" | "bug" | "plan" | "done"; role: string; item: string; text: string; spent: number };
type Item = { index: number; mark: string; text: string };
type Bug = { file: string; title: string; body: string };
type Provider = "formal" | "anthropic";
type Proof = { item: string; files: string[]; summary: string; at: string };

/** Copies text (or what `get` resolves to), showing a tick for a moment. */
function CopyButton({ text, get, label = "Copy" }: { text?: string; get?: () => Promise<string>; label?: string }) {
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			title={label}
			onClick={(e) => {
				e.stopPropagation();
				void (get ? get() : Promise.resolve(text ?? "")).then((t) => navigator.clipboard.writeText(t)).then(() => {
					setDone(true);
					setTimeout(() => setDone(false), 1200);
				});
			}}
			className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
		>
			{done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
		</button>
	);
}

type Session = { run: string; title: string; outcome: string; spent: number; events: number };

const BUDGETS = [2, 5, 10, 20, 50, 100];
/** Claude models the local swarm can run on; the choice applies when the swarm starts. */
const MODELS = [
	{ value: "claude-opus-5-5", label: "Claude Opus 5.5" },
	{ value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
	{ value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
const colorOf = (role: string) => (ROLE_COLORS as Record<string, string>)[role] ?? "hsl(var(--muted-foreground))";
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };


/** A card floating over the canvas; its header toggles it, and opening one closes the others. */
function Floating({ id, open, onOpen, title, meta, tone, action, children }: { id: string; open: string | null; onOpen: (id: string | null) => void; title: string; meta?: string; tone?: "red"; action?: React.ReactNode; children: React.ReactNode }) {
	const isOpen = open === id;
	return (
		<section className={`pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-2xl border p-1 shadow-pop backdrop-blur ${tone === "red" ? "border-red-500/30 bg-red-50/90 dark:bg-red-950/60" : "bg-muted/80"} ${isOpen ? "flex-1" : "shrink-0"}`}>
			<button type="button" onClick={() => onOpen(isOpen ? null : id)} aria-expanded={isOpen} className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-left">
				<span className={`font-mono text-[11px] font-medium uppercase tracking-wider ${tone === "red" ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}`}>{title}</span>
				{meta ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{meta}</span> : null}
				<span className="ml-auto" />
				{isOpen && action ? action : null}
				<ChevronDown className={`size-3.5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
			</button>
			<div className={`grid min-h-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${isOpen ? "flex-1 grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
				<div className={`min-h-0 overflow-y-auto rounded-xl bg-card ${isOpen ? "border shadow-card" : ""}`}>{children}</div>
			</div>
		</section>
	);
}


/**
 * A local folder's swarm: the canvas on the left (the board, the contract files, bugs) and the chat on the right (start
 * and steer the swarm, the plan, and what each agent says as it works).
 */
export function SwarmPanel({ folder, name, scan, bridge, session, actions }: { folder: string; name: string; scan: Scan | null; bridge: Bridge; session?: string | null; actions?: React.ReactNode }) {
	const { invoke, listen, apiBase } = bridge;
	const [run, setRun] = useState<string | null>(null);
	const [events, setEvents] = useState<Ev[]>([]);
	const [plan, setPlan] = useState<Item[]>([]);
	const [bugs, setBugs] = useState<Bug[]>([]);
	const [goal, setGoal] = useState("");
	const [budget, setBudget] = useState(5);
	const [say, setSay] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [openBug, setOpenBug] = useState<string | null>(null);
	// One floating card open at a time, like an accordion; a bug report opens the bugs card.
	const [panel, setPanel] = useState<string | null>("plan");
	const [chatOpen, setChatOpen] = useState(true);
	const [model, setModel] = useState(() => store.get("fm:model") ?? MODELS[0].value);
	
	// Set in Settings (desktop/src/settings.tsx).
	const [provider] = useState<Provider>(() => (store.get("fm:provider") === "anthropic" ? "anthropic" : "formal"));
	const [hasKey, setHasKey] = useState(false);
	const [sessions, setSessions] = useState<Session[]>([]);
	const [proofs, setProofs] = useState<Record<string, Proof>>({});
	const [openItem, setOpenItem] = useState<number | null>(null);
	const [file, setFile] = useState<{ path: string; text: string } | null>(null);
	/** A report with the PoC tests and proofs it cites inlined (newer reports already carry them). */
	const withPoc = async (body: string) => {
		const cited = [...new Set(body.match(/[\w./-]+\.(?:t\.sol|lean)/g) ?? [])].filter((p) => !body.includes(`Proof of concept: \`${p}\``)).slice(0, 3);
		const parts = await Promise.all(
			cited.map((p) =>
				invoke<string>("folder_read", { folder, path: p }).then(
					(code) => `\n## Proof of concept: \`${p}\`\n\n\`\`\`${p.endsWith(".lean") ? "lean" : "solidity"}\n${code.trimEnd()}\n\`\`\`\n`,
					() => "",
				),
			),
		);
		return body + parts.join("");
	};
	const view = (path: string) => {
		void invoke<string>("folder_read", { folder, path }).then(
			(text) => {
				setFile({ path, text });
				setPanel("file");
			},
			(e) => setError(String(e)),
		);
	};
	const [viewing, setViewing] = useState<string | null>(null);
	const runRef = useRef<string | null>(null);
	const chat = useRef<HTMLDivElement>(null);

	/** Shows a session's saved events (.formal/runs/<run>.jsonl), so quitting the app loses nothing. */
	const load = (id: string) => {
		setViewing(id);
		void invoke<Ev[]>("swarm_history", { folder, run: id }).then((evs) => setEvents(evs.slice(-600)), () => setEvents([]));
	};
	const listSessions = () =>
		invoke<Session[]>("swarm_sessions", { folder }).then(
			(list) => {
				setSessions(list);
				window.dispatchEvent(new Event("fm:sessions"));
				return list;
			},
			() => [] as Session[],
		);

	const refresh = () => {
		void invoke<Item[]>("swarm_plan", { folder }).then(setPlan, () => {});
		void invoke<Bug[]>("swarm_bugs", { folder }).then(setBugs, () => {});
		void invoke<Record<string, Proof>>("swarm_proofs", { folder }).then(setProofs, () => {});
	};

	useEffect(() => {
		refresh();
		void invoke<boolean>("anthropic_key_status").then(setHasKey);
		void invoke<string | null>("swarm_running").then(async (r) => {
			runRef.current = r;
			setRun(r);
			const list = await listSessions();
			// Reopen where you left off: the running session, else the latest one.
			const id = r ?? (session === "new" ? undefined : session) ?? list[0]?.run;
			if (id) load(id);
		});
		const off = listen<Ev>("swarm", ({ payload }) => {
			if (runRef.current && payload.run !== runRef.current) return;
			setEvents((all) => [...all.slice(-600), payload]);
			if (["plan", "bug", "done", "status"].includes(payload.kind)) refresh();
			if (payload.kind === "bug") setPanel("bugs");
			if (payload.kind === "done") {
				setRun(null);
				void listSessions();
			}
		});
		return () => void off.then((f) => f());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder]);
	// A session picked in the sidebar; "new" is an empty one that gets its own queue when started.
	useEffect(() => {
		if (session === "new" && !run) {
			setViewing(null);
			setEvents([]);
			return;
		}
		if (session && session !== viewing && !run) load(session);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session]);
	useEffect(() => {
		// Braces matter: scrollTo returns a Promise in newer browsers, and an effect must return nothing or a cleanup.
		chat.current?.scrollTo({ top: chat.current.scrollHeight });
	}, [events]);

	const start = async () => {
		setError(null);
		setEvents([]);
		try {
			const id = await invoke<string>("swarm_start", { request: { folder, goal: goal.trim() || null, budget_usd: budget, api_base: apiBase(), provider, model, session: session === "new" && !viewing ? `s-${Date.now().toString(16)}` : viewing ?? "swarm" } });
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
	const sessionTitle = (id: string | null) => {
		const i = sessions.findIndex((x) => x.run === id);
		if (i < 0) return run ? goal.trim() || "New session" : "New session";
		return sessions[i].title || (sessions[i].run === "swarm" ? "Main session" : `Session ${sessions.length - i}`);
	};
	const title = sessionTitle(viewing);
	const working = [...events].reverse().find((e) => e.kind === "status" && e.role !== "swarm");
	const done = plan.filter((i) => i.mark === "x").length;
	const finished = !run ? events.find((e) => e.kind === "done") : undefined;
	const shown = events.filter((e) => e.kind !== "status" && e.kind !== "result");

	return (
		<div className="relative flex h-full min-h-0 flex-1">
			{/* The canvas, as on the Swarm page, with the plan, files and bugs floating over it as one accordion. */}
			<div className="absolute inset-0 flex flex-col overflow-hidden">
				<SwarmCanvas
					state={localBoard(folder, plan, events, Boolean(run))}
					fill
					local
					repo={folder}
					actions={actions}
					title={<span className="inline-flex h-8 min-w-0 items-center rounded-full border bg-background/90 px-3 text-sm shadow-sm backdrop-blur"><span className="truncate">{name}</span></span>}
				/>
				<div className="pointer-events-none absolute left-3 top-14 z-10 flex max-h-[calc(100%-4.5rem)] w-[min(18rem,calc(100%-1.5rem))] flex-col gap-2">
					<Floating id="plan" open={panel} onOpen={setPanel} title="Plan" meta={plan.length ? `${done}/${plan.length}` : ""}>
						<ul className="space-y-0.5 p-2 text-[13px]">
							{plan.length === 0 ? <li className="p-2 text-muted-foreground">The planner writes .formal/plan.md on the first run.</li> : null}
							{plan.map((i) => {
								const proof = proofs[String(i.index)];
								const expanded = openItem === i.index;
								return (
									<li key={i.index} className={`rounded-md ${working && working.item === String(i.index) ? "bg-muted" : ""}`}>
										<button type="button" disabled={!proof} onClick={() => setOpenItem(expanded ? null : i.index)} className="flex w-full gap-2 px-2 py-1 text-left enabled:hover:bg-muted/60 rounded-md">
											<span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${i.mark === "x" ? "border-emerald-500 bg-emerald-500 text-white" : i.mark === "!" ? "border-amber-500 text-amber-600" : ""}`}>{i.mark === "x" ? "✓" : i.mark === "!" ? "!" : ""}</span>
											<span className={`flex-1 ${i.mark === "x" ? "text-muted-foreground" : ""}`}>{i.text}</span>
											{proof ? <ChevronDown className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} /> : null}
										</button>
										{expanded && proof ? (
											<div className="mb-1 ml-8 mr-2 space-y-1.5 rounded-lg border bg-muted/40 p-2 text-xs">
												<p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Proved by</p>
												{proof.files.length ? (
													proof.files.map((f) => (
														<button key={f} type="button" onClick={() => view(f)} className="flex w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-muted" title={`Open ${f}`}>
															<FileCode2 className={`size-3 shrink-0 ${f.endsWith(".lean") ? "text-violet-500" : "text-sky-500"}`} />
															<span className="truncate">{f}</span>
														</button>
													))
												) : (
													<p className="text-muted-foreground">No files recorded for this item.</p>
												)}
												{proof.summary ? <p className="whitespace-pre-wrap leading-5 text-muted-foreground">{proof.summary}</p> : null}
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
					</Floating>
					<Floating id="files" open={panel} onOpen={setPanel} title="Files" meta={scan ? `${scan.solidity.length} sol · ${scan.lean.length} lean` : ""}>
						<ul className="p-2 font-mono text-[11px]">
							{scan === null ? <li className="p-2 text-muted-foreground">Reading the folder…</li> : null}
							{[...(scan?.solidity ?? []), ...(scan?.lean ?? [])].map((f) => (
								<li key={f}>
									<button type="button" onClick={() => view(f)} className="flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-muted" title={`Open ${f}`}>
										<FileCode2 className={`size-3 shrink-0 ${f.endsWith(".lean") ? "text-violet-500" : "text-sky-500"}`} />
										<span className="truncate">{f}</span>
									</button>
								</li>
							))}
						</ul>
					</Floating>
					{bugs.length ? (
						<Floating id="bugs" open={panel} onOpen={setPanel} title="Bugs" meta={String(bugs.length)} tone="red">
							<ul className="divide-y">
								{bugs.map((b) => (
									<li key={b.file}>
										<button type="button" onClick={() => setOpenBug(openBug === b.file ? null : b.file)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]">
											<span className="flex-1 font-medium">{b.title}</span>
											<CopyButton get={() => withPoc(b.body)} label="Copy the report as Markdown, PoC included" />
											<ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${openBug === b.file ? "rotate-180" : ""}`} />
										</button>
										{openBug === b.file ? <div className="prose prose-sm max-w-none border-t px-3 py-2 text-[13px] dark:prose-invert"><ChatMarkdown>{b.body.replace(/^# .*\n/, "")}</ChatMarkdown></div> : null}
									</li>
								))}
							</ul>
						</Floating>
					) : null}
					{file ? (
						<Floating id="file" open={panel} onOpen={setPanel} title={file.path.split("/").pop() ?? "File"} meta={file.path} action={<CopyButton text={file.text} label="Copy the file" />}>
							<pre className="whitespace-pre overflow-x-auto p-3 font-mono text-[11px] leading-5">{file.text}</pre>
						</Floating>
					) : null}
				</div>
			</div>

			{/* The chat: start and steer the swarm, the plan, and the agents' messages. */}
			{/* The chat floats over the canvas on the right: a gray title bar with the run's controls, the white chat inside.
			    The strip above it stays free for the Live pill and the bell. */}
			<aside className={`pointer-events-auto absolute right-3 top-[6.5rem] z-20 flex w-[min(24rem,calc(100%-1.5rem))] flex-col rounded-2xl border bg-muted/80 p-1.5 shadow-pop backdrop-blur ${chatOpen ? "bottom-3" : ""}`}>
				<div className="flex h-8 shrink-0 items-center gap-2 pl-2 pr-0.5">
					<button type="button" onClick={() => setChatOpen(!chatOpen)} aria-expanded={chatOpen} title={chatOpen ? "Collapse the chat" : "Open the chat"} className="flex items-center gap-1.5">
						<ChevronDown className={`size-3.5 text-muted-foreground transition-transform duration-200 ${chatOpen ? "rotate-180" : ""}`} />
					</button>
					<span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={title}>{title}</span>
					<DropdownMenu>
						<DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-background px-2 text-[11px] tabular-nums text-muted-foreground outline-none hover:text-foreground" title="Spending cap">
							{run || viewing ? `$${spent.toFixed(2)} / $${budget}` : `Budget $${budget}`}
							<ChevronDown className="size-3" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Stop the swarm at</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={String(budget)}
								onValueChange={(v) => {
									setBudget(Number(v));
									if (run) void invoke("swarm_set_budget", { run, usd: Number(v) });
								}}
							>
								{BUDGETS.map((b) => (
									<DropdownMenuRadioItem key={b} value={String(b)} disabled={Boolean(run) && b <= spent}>${b}</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					{run ? (
						<button type="button" onClick={() => void invoke("swarm_stop", { run })} title="Stop the swarm" className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-background px-2 text-[11px] text-foreground hover:bg-muted">
							<Square className="size-3" />Stop
						</button>
					) : null}
				</div>
				{chatOpen ? (
				<div className="shadow-card mt-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
				<div ref={chat} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
					{shown.length === 0 && !run ? <p className="text-muted-foreground">Start the swarm and its agents talk here. Message them anytime to steer.</p> : null}
					{shown.map((e, i) =>
						e.kind === "you" ? (
							<div key={i} className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-foreground px-3 py-2 text-background">{e.text}</div>
						) : e.kind === "tool" || e.kind === "result" ? (
							<p key={i} className="truncate pl-4 font-mono text-[11px] text-muted-foreground">{e.kind === "tool" ? `› ${e.text}` : e.text.split("\n")[0]}</p>
						) : (
							<div key={i}>
								<p className="mb-1 flex items-center gap-1.5 text-xs font-medium capitalize" style={{ color: e.kind === "bug" ? "#dc2626" : colorOf(e.role) }}>
									<span className="size-1.5 rounded-full" style={{ background: e.kind === "bug" ? "#dc2626" : colorOf(e.role) }} />
									{e.kind === "bug" ? "bug reported" : e.role}
									{/^\d+$/.test(e.item) ? <span className="font-normal text-muted-foreground">· item {e.item}</span> : null}
								</p>
								{e.kind === "bug" ? (
									<button
										type="button"
										onClick={() => {
											// Open the bugs card on this report.
											const hit = bugs.find((b) => e.text.includes(b.file));
											setPanel("bugs");
											if (hit) setOpenBug(hit.file);
										}}
										className="whitespace-pre-wrap rounded-2xl rounded-tl-md bg-red-500/10 px-3 py-2 text-left hover:bg-red-500/15"
									>
										{e.text.split(" — ")[0]}
										<span className="mt-1 block text-xs text-red-700/70 dark:text-red-400/70">Open the report →</span>
									</button>
								) : (
									e.kind === "plan" || e.kind === "done" ? (
										<p className="text-[13px] text-muted-foreground">{e.text}</p>
									) : (
										// Flat on the page, as Markdown, like the web chats.
										<ChatMarkdown>{e.text}</ChatMarkdown>
									)
								)}
							</div>
						),
					)}
					{finished ? <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">Finished: {finished.text}</p> : null}
				</div>

				<div className="shrink-0 space-y-2 p-3">
					{error ? <p className="text-xs text-red-600">{error}</p> : null}
					{/* The Swarm page's composer: steer while it runs; before that, what you type is its focus and ↑ starts it. */}
					<ChatComposer
						value={run ? say : goal}
						onChange={(e) => (run ? setSay(e.target.value) : setGoal(e.target.value))}
						onSubmit={() => void (run ? send() : start())}
						onStop={() => {}}
						isLoading={false}
						modelPicker={{
							value: model,
							options: MODELS,
							disabled: Boolean(run),
							onChange: (m) => {
								setModel(m);
								store.set("fm:model", m);
							},
						}}
						placeholder={run ? "Steer the swarm: a question, a new focus, an idea to check…" : "What should the swarm focus on? (optional) ↑ starts it"}
						context={
							<span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm font-medium text-secondary-foreground">
								{name} swarm
							</span>
						}
					/>
					{run ? null : (
						<div className="flex flex-wrap items-center gap-1.5 px-1 text-xs">
							<button type="button" onClick={() => void start()} disabled={provider === "anthropic" && !hasKey} className="btn-dark ml-auto h-7 gap-1.5 px-3 disabled:opacity-50"><Play className="size-3" />{plan.some((i) => i.mark === " ") ? "Resume" : "Start"}</button>
						</div>
					)}
				</div>
				</div>
				) : null}
			</aside>
		</div>
	);
}
