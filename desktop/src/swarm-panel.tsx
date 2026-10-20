import { MarkGithubIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { Bug, Check, ChevronDown, Copy, FileCode2, Maximize2, Minimize2, Play, Plus, Square, WandSparkles, Wrench } from "lucide-react";
import { useSearchParams } from "react-router";
import { ChatComposer } from "@/components/chat-composer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChatMarkdown } from "@/components/chat-markdown";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
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


type Block = { e: Ev } | { steps: { call: Ev; result?: Ev }[] };

/** The chat as blocks: messages stand alone; a run of tool calls (each with its result) folds into one trace. */
function blocks(events: Ev[]): Block[] {
	const out: Block[] = [];
	for (const e of events) {
		const last = out.at(-1);
		if (e.kind === "tool") {
			if (last && "steps" in last) last.steps.push({ call: e });
			else out.push({ steps: [{ call: e }] });
		} else if (e.kind === "result") {
			const step = last && "steps" in last ? last.steps.at(-1) : undefined;
			if (step && !step.result) step.result = e;
		} else out.push({ e });
	}
	return out;
}

/** A run of tool calls: "Used 4 tools", opening to each call and the start of its output. */
function Steps({ steps, running }: { steps: { call: Ev; result?: Ev }[]; running: boolean }) {
	const one = steps.length === 1 ? steps[0].call.text : null;
	return (
		<Trace className="pl-1">
			<TraceCollapsible>
				<TraceCollapsibleTrigger>
					<TraceLine status={running ? "running" : undefined}>
						<TraceIcon><Wrench className="size-3.5" /></TraceIcon>
						<TraceTitle className="font-mono text-[11px]">{one ?? `Used ${steps.length} tools`}</TraceTitle>
					</TraceLine>
				</TraceCollapsibleTrigger>
				<TraceCollapsibleContent className="ml-2 space-y-2">
					{steps.map((s, i) => (
						<div key={i} className="space-y-1">
							<p className="truncate font-mono text-[11px] text-foreground/80">› {s.call.text}</p>
							{s.result?.text.trim() ? (
								<ToolOutput call={s.call.text} text={s.result.text} />
							) : null}
						</div>
					))}
				</TraceCollapsibleContent>
			</TraceCollapsible>
		</Trace>
	);
}

const EXT: Record<string, string> = { sol: "solidity", lean: "lean", ts: "typescript", tsx: "tsx", js: "javascript", json: "json", md: "markdown", toml: "toml", sh: "bash", py: "python", yml: "yaml", yaml: "yaml" };

/** A tool's output, highlighted by the file it read (or as shell for a run); read_file's line numbers sit in a gutter. */
function ToolOutput({ call, text }: { call: string; text: string }) {
	const [tool, path = ""] = call.split(" ");
	const language = tool === "run" ? "bash" : (EXT[path.split(".").pop() ?? ""] ?? "text");
	const all = text.split("\n").slice(0, 40);
	const numbered = all.map((l) => /^\s*(\d+) {2}(.*)$/.exec(l));
	const first = numbered.findIndex(Boolean);
	const head = first < 0 ? (tool === "read_file" ? all : []) : all.slice(0, first);
	const body = first < 0 ? (tool === "read_file" ? [] : all) : all.slice(first);
	const code = body.map((l, i) => numbered[first + i]?.[2] ?? l).join("\n");
	const lines = useHighlightedCode(code, language);
	return (
		<CodeBlock size="sm" className="text-[11px]">
			<CodeBlockContent className="max-h-48">
				{head.map((l, i) => <span key={`h${i}`} className="block text-muted-foreground">{l}</span>)}
				{lines.map((line, i) => (
					<span key={i} className="block whitespace-pre">
						{first >= 0 ? <span className="mr-3 inline-block w-8 select-none text-right text-muted-foreground/60">{numbered[first + i]?.[1]}</span> : null}
						{line}
					</span>
				))}
			</CodeBlockContent>
		</CodeBlock>
	);
}

/** One agent's message: who said it (and on which item), then the text flat as Markdown; a bug opens its report. */
function AgentMessage({ e, onBug }: { e: Ev; onBug: () => void }) {
	const color = e.kind === "bug" ? "#dc2626" : colorOf(e.role);
	return (
		<Message>
			<MessageContent className="gap-1">
				<MessageHeader className="gap-1.5 px-0 capitalize" style={{ color }}>
					<span className="size-1.5 rounded-full" style={{ background: color }} />
					{e.kind === "bug" ? "bug reported" : e.role}
					{/^\d+$/.test(e.item) ? <span className="font-normal normal-case text-muted-foreground">· item {e.item}</span> : null}
				</MessageHeader>
				{e.kind === "bug" ? (
					<button type="button" onClick={onBug} className="w-fit whitespace-pre-wrap rounded-2xl rounded-tl-md bg-red-500/10 px-3 py-2 text-left hover:bg-red-500/15">
						{e.text.split(" — ")[0]}
						<span className="mt-1 block text-xs text-red-700/70 dark:text-red-400/70">Open the report →</span>
					</button>
				) : e.kind === "plan" || e.kind === "done" ? (
					<p className="text-[13px] text-muted-foreground">{e.text}</p>
				) : (
					<ChatMarkdown>{e.text}</ChatMarkdown>
				)}
			</MessageContent>
		</Message>
	);
}

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
/** A whole file, highlighted by its extension, with a line-number gutter. */
function FileView({ path, text }: { path: string; text: string }) {
	const lines = useHighlightedCode(text, EXT[path.split(".").pop() ?? ""] ?? "text");
	return (
		<pre className="overflow-x-auto py-2 font-mono text-[11px] leading-5">
			{lines.map((line, i) => (
				<span key={i} className="block whitespace-pre pr-3">
					<span className="mr-3 inline-block w-9 select-none text-right text-muted-foreground/60">{i + 1}</span>
					{line}
				</span>
			))}
		</pre>
	);
}

/**
 * `onDebug` (the desktop app) opens debug mode on a test file; without it the files have no debug action.
 */
export function SwarmPanel({ folder, name, scan, bridge, session, file: openPath, actions, onDebug }: { folder: string; name: string; scan: Scan | null; bridge: Bridge; session?: string | null; file?: string | null; actions?: React.ReactNode; onDebug?: (file: string | null) => void }) {
	const { invoke, listen, apiBase } = bridge;
	const [run, setRun] = useState<string | null>(null);
	const [events, setEvents] = useState<Ev[]>([]);
	const [plan, setPlan] = useState<Item[]>([]);
	const [bugs, setBugs] = useState<Bug[]>([]);
	const [goal, setGoal] = useState("");
	// The cap is kept per folder, so the chat header, the canvas ledger and the next start all agree after a reload.
	const budgetKey = `fm:budget:${folder}`;
	const [budget, setBudget] = useState(() => Number(store.get(budgetKey)) || 5);
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
	// The file card can widen to read code comfortably; it stops short of the chat card.
	const [wideFile, setWideFile] = useState(false);
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
	// A file picked in the sidebar's tree opens in the file card.
	useEffect(() => {
		if (openPath) view(openPath);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openPath, folder]);
	// Sessions are picked from the chat card's title (the sidebar holds the folder's files).
	const [params, setParams] = useSearchParams();
	const pickSession = (run: string) => {
		const next = new URLSearchParams(params);
		next.set("run", run);
		setParams(next);
	};
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
	// A cheap model drafts your next message from the recent chat; it lands in the composer for you to edit or send.
	const [drafting, setDrafting] = useState(false);
	const draft = async () => {
		if (!run || drafting) return;
		setDrafting(true);
		const transcript = events.filter((e) => e.kind === "say" || e.kind === "you" || e.kind === "bug" || e.kind === "done").slice(-20).map((e) => `${e.role}${e.item ? ` (item ${e.item})` : ""}: ${e.text}`).join("\n");
		await invoke<string>("swarm_suggest", { folder, apiBase: apiBase(), provider, run, transcript })
			.then((text) => text && setSay(text))
			.catch((e) => setError(String(e)))
			.finally(() => setDrafting(false));
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
	const shown = events.filter((e) => e.kind !== "status");

	return (
		<div className="relative flex h-full min-h-0 flex-1">
			{/* The canvas, as on the Swarm page, with the plan, files and bugs floating over it as one accordion. */}
			<div className="absolute inset-0 flex flex-col overflow-hidden">
				<SwarmCanvas
					state={localBoard(folder, plan, events, Boolean(run), budget)}
					fill
					local
					repo={folder}
					actions={actions}
					title={
						<>
							<span className="inline-flex h-8 min-w-0 items-center rounded-full border bg-background/90 px-3 text-sm shadow-sm backdrop-blur">{scan?.git ? <MarkGithubIcon className="mr-2 size-4 shrink-0" /> : null}<span className="truncate">{name}</span></span>
							{onDebug ? (
								<button type="button" onClick={() => onDebug(null)} title="Debug this folder's Foundry tests" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-background/90 px-3 text-[12px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
									<Bug className="size-3.5" />Debug
								</button>
							) : null}
						</>
					}
				/>
				<div className={`pointer-events-none absolute left-3 top-14 z-10 flex max-h-[calc(100%-4.5rem)] flex-col gap-2 transition-[width] duration-200 ${wideFile && panel === "file" ? "bottom-3 w-[min(48rem,calc(100%-26.5rem))]" : "w-[min(18rem,calc(100%-1.5rem))]"}`}>
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
						<Floating id="file" open={panel} onOpen={setPanel} title={file.path.split("/").pop() ?? "File"} meta={file.path} action={
							<span className="flex items-center gap-1">
								{onDebug && file.path.endsWith(".t.sol") ? (
									<button type="button" onClick={(e) => { e.stopPropagation(); onDebug(file.path); }} title={`Debug a test in ${file.path}`} className="inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-[11px] text-foreground hover:bg-muted">
										<Bug className="size-3" />Debug
									</button>
								) : null}
								<CopyButton text={file.text} label="Copy the file" />
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setWideFile(!wideFile);
										setPanel("file");
									}}
									title={wideFile ? "Make the file card narrow again" : "Expand the file card"}
									aria-label={wideFile ? "Collapse the file card" : "Expand the file card"}
									className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									{wideFile ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
								</button>
							</span>
						}>
							<FileView path={file.path} text={file.text} />
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
					<DropdownMenu>
						<DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left text-[13px] font-medium outline-none hover:text-foreground" title={`${title} — switch sessions`}>
							<span className="truncate">{title}</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-64">
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sessions in {name}</DropdownMenuLabel>
							<DropdownMenuRadioGroup value={viewing ?? ""} onValueChange={pickSession}>
								{sessions.map((x, i) => (
									<DropdownMenuRadioItem key={x.run} value={x.run} className="text-[13px]">
										<span className="truncate">{x.title || (x.run === "swarm" ? "Main session" : `Session ${sessions.length - i}`)}</span>
										{x.run === run ? <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-label="running" /> : null}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => pickSession("new")} className="text-[13px]">
								<Plus className="size-3.5" /> New session
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
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
									store.set(budgetKey, v);
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
					{blocks(shown).map((block, i) =>
						"steps" in block ? (
							<Steps key={i} steps={block.steps} running={Boolean(run) && i === blocks(shown).length - 1} />
						) : block.e.kind === "you" ? (
							<Message key={i} align="end">
								<MessageContent>
									<div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-foreground px-3 py-2 text-background">{block.e.text}</div>
								</MessageContent>
							</Message>
						) : (
							<AgentMessage key={i} e={block.e} onBug={() => {
								// Open the bugs card on this report.
								const hit = bugs.find((b) => block.e.text.includes(b.file));
								setPanel("bugs");
								if (hit) setOpenBug(hit.file);
							}} />
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
						extra={run ? (
							<button type="button" onClick={() => void draft()} disabled={drafting} title="Draft a reply for me" className="inline-flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
								<WandSparkles className={`size-3.5 ${drafting ? "animate-pulse" : ""}`} />
								{drafting ? "Drafting…" : "Draft reply"}
							</button>
						) : null}
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
