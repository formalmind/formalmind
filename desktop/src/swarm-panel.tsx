import { MarkGithubIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import { Bug, Check, ChevronDown, Code2, Copy, FileCode2, MessagesSquare, Network, Play, Plus, ScanSearch, Square, WandSparkles, Wrench } from "lucide-react";
import { useSearchParams } from "react-router";
import { ChatComposer } from "@/components/chat-composer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

/**
 * A local folder's swarm: the canvas on the left (the board, the contract files, bugs) and the chat on the right (start
 * and steer the swarm, the plan, and what each agent says as it works).
 */
/** A whole file, highlighted by its extension, with a line-number gutter. */
function FileView({ path, text, big }: { path: string; text: string; big?: boolean }) {
	const lines = useHighlightedCode(text, EXT[path.split(".").pop() ?? ""] ?? "text");
	return (
		<pre className={`overflow-x-auto py-2 font-mono ${big ? "text-[12.5px] leading-6" : "text-[11px] leading-5"}`}>
			{lines.map((line, i) => (
				<span key={i} className="block whitespace-pre pr-3">
					<span className="mr-3 inline-block w-9 select-none text-right text-muted-foreground/60">{i + 1}</span>
					{line}
				</span>
			))}
		</pre>
	);
}

/** A folder's direct entries among `files`: subfolders and files, each sorted by name. */
function entries(files: string[], dir: string) {
	const prefix = dir ? `${dir}/` : "";
	const dirs = new Set<string>();
	const own: string[] = [];
	for (const f of files) {
		if (!f.startsWith(prefix)) continue;
		const rest = f.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash < 0) own.push(f);
		else dirs.add(prefix + rest.slice(0, slash));
	}
	return { dirs: [...dirs].sort(), files: own.sort() };
}

/** A folder's contents as menu items: files open, subfolders open a submenu. */
function FolderItems({ files, dir, current, onOpen }: { files: string[]; dir: string; current: string; onOpen: (path: string) => void }) {
	const { dirs, files: own } = entries(files, dir);
	return (
		<>
			{dirs.map((d) => (
				<DropdownMenuSub key={d}>
					<DropdownMenuSubTrigger className="font-mono text-[12px]">{d.split("/").pop()}/</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="max-h-96 overflow-y-auto">
						<FolderItems files={files} dir={d} current={current} onOpen={onOpen} />
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			))}
			{own.map((f) => (
				<DropdownMenuItem key={f} onSelect={() => onOpen(f)} className={`font-mono text-[12px] ${f === current ? "font-semibold text-foreground" : ""}`}>
					{f.split("/").pop()}
				</DropdownMenuItem>
			))}
		</>
	);
}

/** The open file's path as breadcrumbs: each folder lists its contents, the file lists its siblings. */
function Breadcrumbs({ root, path, files, onOpen }: { root: string; path: string; files: string[]; onOpen: (path: string) => void }) {
	const parts = path.split("/");
	return (
		<nav aria-label="File path" className="flex min-w-0 items-center overflow-hidden font-mono text-[12px] text-muted-foreground">
			<DropdownMenu>
				<DropdownMenuTrigger className="shrink-0 rounded px-1 py-0.5 outline-none hover:bg-muted hover:text-foreground data-[state=open]:bg-muted" title={`What's in ${root}`}>
					{root}
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
					<FolderItems files={files.length ? files : [path]} dir="" current={path} onOpen={onOpen} />
				</DropdownMenuContent>
			</DropdownMenu>
			<span className="px-1 text-muted-foreground/50">/</span>
			{parts.map((part, i) => {
				const dir = parts.slice(0, i).join("/");
				const last = i === parts.length - 1;
				return (
					<span key={i} className="flex min-w-0 items-center">
						{i > 0 ? <span className="px-1 text-muted-foreground/50">/</span> : null}
						<DropdownMenu>
							<DropdownMenuTrigger className={`truncate rounded px-1 py-0.5 outline-none hover:bg-muted hover:text-foreground data-[state=open]:bg-muted ${last ? "text-foreground" : ""}`} title={last ? `Files next to ${part}` : `What's in ${parts.slice(0, i + 1).join("/")}`}>
								{part}
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
								<FolderItems files={files.length ? files : [path]} dir={last ? dir : parts.slice(0, i + 1).join("/")} current={path} onOpen={onOpen} />
							</DropdownMenuContent>
						</DropdownMenu>
					</span>
				);
			})}
		</nav>
	);
}

/** What a report's front matter says: `**Severity:** high`, `**Location:** src/X.sol:12`, a cited PoC. */
function bugFacts(body: string) {
	const severity = /\*\*Severity:\*\*\s*([\w-]+)/i.exec(body)?.[1]?.toLowerCase() ?? null;
	const location = /\*\*Location:\*\*\s*`?([\w./-]+\.\w+)(?::(\d+))?`?/i.exec(body);
	const poc = /([\w./-]+\.t\.sol)/.exec(body)?.[1] ?? null;
	const rest = body
		.replace(/^# .*\n/, "")
		.replace(/\*\*Severity:\*\*[^\n]*\n?/i, "")
		.replace(/\*\*Location:\*\*[^\n]*\n?/i, "")
		.trim();
	return { severity, file: location?.[1] ?? null, line: location?.[2] ?? null, poc, rest };
}

const SEVERITY: Record<string, string> = {
	critical: "border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-400",
	high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
	medium: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	low: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
};

/** Bug reports: a list on the left, the selected report on the right with its facts as chips. */
function BugsView({ bugs, openBug, setOpenBug, withPoc, onOpenFile }: { bugs: Bug[]; openBug: string | null; setOpenBug: (f: string | null) => void; withPoc: (body: string) => Promise<string>; onOpenFile: (path: string) => void }) {
	const selected = bugs.find((b) => b.file === openBug) ?? bugs[0];
	if (!selected) {
		return <p className="absolute inset-x-0 top-1/3 text-center text-sm text-muted-foreground">No bugs reported yet. The swarm files them here, each with a proof of concept.</p>;
	}
	const facts = bugFacts(selected.body);
	return (
		<div className="absolute inset-x-0 bottom-0 top-14 z-10 grid grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-3 px-3 pb-3">
			<ul className="min-h-0 space-y-1 overflow-y-auto">
				{bugs.map((b) => {
					const f = bugFacts(b.body);
					const on = b.file === selected.file;
					return (
						<li key={b.file}>
							<button type="button" onClick={() => setOpenBug(b.file)} className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${on ? "bg-muted" : "border-transparent hover:bg-muted/60"}`}>
								<span className="flex items-center gap-2">
									{f.severity ? <span className={`rounded-md border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${SEVERITY[f.severity] ?? "border-border text-muted-foreground"}`}>{f.severity}</span> : null}
									{f.file ? <span className="truncate font-mono text-[11px] text-muted-foreground">{f.file.split("/").pop()}{f.line ? `:${f.line}` : ""}</span> : null}
								</span>
								<span className="mt-1 block text-[13px] font-medium leading-snug">{b.title}</span>
							</button>
						</li>
					);
				})}
			</ul>
			<article className="min-h-0 overflow-y-auto rounded-2xl border bg-card px-6 py-5 shadow-card">
				<div className="flex items-start gap-3">
					<h2 className="flex-1 text-[17px] font-semibold leading-snug">{selected.title}</h2>
					<CopyButton get={() => withPoc(selected.body)} label="Copy the report as Markdown, PoC included" />
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
					{facts.severity ? <span className={`inline-flex h-7 items-center rounded-lg border px-2.5 font-medium capitalize ${SEVERITY[facts.severity] ?? ""}`}>{facts.severity}</span> : null}
					{facts.file ? (
						<button type="button" onClick={() => onOpenFile(facts.file!)} title="Open in Code" className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-background px-2.5 font-mono hover:bg-muted">
							<FileCode2 className="size-3.5 text-muted-foreground" />
							{facts.file}{facts.line ? `:${facts.line}` : ""}
						</button>
					) : null}
					{facts.poc ? (
						<button type="button" onClick={() => onOpenFile(facts.poc!)} title="Open the proof of concept in Code" className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-background px-2.5 font-mono hover:bg-muted">
							<Bug className="size-3.5 text-muted-foreground" />
							PoC · {facts.poc.split("/").pop()}
						</button>
					) : null}
				</div>
				<div className="prose prose-sm mt-4 max-w-none dark:prose-invert">
					<ChatMarkdown>{facts.rest}</ChatMarkdown>
				</div>
			</article>
		</div>
	);
}

type Mode = "code" | "chat" | "swarm" | "audit" | "bugs";

const MODES: { id: Mode; label: string; icon: typeof Code2 }[] = [
	{ id: "code", label: "Code", icon: Code2 },
	{ id: "chat", label: "Chat", icon: MessagesSquare },
	{ id: "swarm", label: "Swarm", icon: Network },
	{ id: "audit", label: "Audit", icon: ScanSearch },
	{ id: "bugs", label: "Bugs", icon: Bug },
];

/** The page's modes as a macOS-style segmented control, centred at the top. */
function ModeTabs({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
	return (
		<div role="tablist" aria-label="Mode" className="pointer-events-auto absolute left-1/2 top-3 z-20 inline-flex h-8 -translate-x-1/2 items-center gap-0.5 rounded-lg border bg-muted/90 p-0.5 shadow-sm backdrop-blur">
			{MODES.map(({ id, label, icon: Icon }) => (
				<button
					key={id}
					type="button"
					role="tab"
					aria-selected={mode === id}
					onClick={() => onMode(id)}
					className={`inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${mode === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
				>
					<Icon className="size-3.5" />
					{label}
				</button>
			))}
		</div>
	);
}

type AstUnit = { name: string; function: string; mutability: string; reads: string[]; writes: string[]; external: number; guards: number; arith: number; unchecked: number; asm: number; closure: number };
type AstVar = { name: string; type: string; slot: string | null; offset: number | null; constant: boolean; immutable: boolean; visibility: string };
type AstFn = { name: string; kind: string; visibility: string; mutability: string; modifiers: string[]; reached: boolean; entry: boolean };
type AstContract = { name: string; kind: string; file: string | null; stateVars: AstVar[]; functions: AstFn[] };
type AstUnits = {
	contract: string;
	files: number;
	inScope: number;
	reachable: number;
	unusedImports: string[];
	ms: number;
	units: AstUnit[];
	clusters: { units: string[]; shared: string[] }[];
	tree?: AstContract[];
	reached?: { name: string; kind: string; visibility: string; dependency: boolean; arith: number; asm: number; calls: number }[];
	scopeFiles?: { path: string; inScope: boolean; dependency: boolean; imports: number }[];
};

/**
 * Which entry point touches which storage: rows are state variables (most-written first), columns are entry points
 * (state-changing first). A variable written by many entry points is where invariants and bugs live. Clicking a cell
 * or a column opens that entry point's slice beside the matrix.
 */
function StorageMatrix({ data, unit, slice, onOpen, onClose }: { data: AstUnits; unit: string | null; slice: string | null; onOpen: (name: string) => void; onClose: () => void }) {
	const [hover, setHover] = useState<{ row: string | null; col: string | null }>({ row: null, col: null });
	const [views, setViews] = useState(false);
	// Rows: every mutable state variable of the contract and its bases, plus any the units touch.
	const declared = (data.tree ?? []).flatMap((c) => c.stateVars.filter((v) => !v.constant && !v.immutable).map((v) => ({ ...v, contract: c.name })));
	const touched = new Set(data.units.flatMap((u) => [...u.reads, ...u.writes]));
	const rows = [...declared.filter((v) => touched.has(v.name)), ...declared.filter((v) => !touched.has(v.name))];
	const writers = (name: string) => data.units.filter((u) => u.writes.includes(name)).length;
	rows.sort((a, b) => writers(b.name) - writers(a.name));
	const mutating = data.units.filter((u) => u.mutability !== "view" && u.mutability !== "pure");
	const cols = views ? [...mutating, ...data.units.filter((u) => !mutating.includes(u))] : mutating;
	const short = (n: string) => n.split(".").slice(1).join(".") || n;
	return (
		<div className={`grid min-h-0 flex-1 gap-1 ${unit ? "grid-cols-[minmax(0,1fr)_minmax(0,28rem)]" : "grid-cols-1"}`}>
			<div className="min-h-0 overflow-auto rounded-xl border bg-card shadow-card">
				<div className="sticky left-0 top-0 z-20 flex items-center gap-3 border-b bg-card/95 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur">
					<span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-sm bg-red-500/80" /> writes</span>
					<span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-sm bg-sky-500/50" /> reads</span>
					<span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-sm bg-gradient-to-br from-sky-500/50 from-50% to-red-500/80 to-50%" /> both</span>
					<label className="ml-auto inline-flex cursor-pointer items-center gap-1.5">
						<input type="checkbox" checked={views} onChange={(e) => setViews(e.target.checked)} className="size-3" />
						include view functions
					</label>
				</div>
				<table className="border-separate border-spacing-0 text-[12px]">
					<thead>
						<tr>
							<th className="sticky left-0 top-9 z-10 min-w-56 border-b bg-card px-3 py-2 text-left align-bottom font-normal text-muted-foreground">
								<span className="font-mono">{rows.length}</span> state · <span className="font-mono">{cols.length}</span> entry points
							</th>
							{cols.map((u) => (
								<th key={u.name} className={`sticky top-9 z-[5] h-36 w-8 border-b bg-card px-0 align-bottom font-normal ${hover.col === u.name || unit === u.name ? "bg-muted" : ""}`}>
									<button
										type="button"
										onClick={() => onOpen(u.name)}
										onMouseEnter={() => setHover({ row: null, col: u.name })}
										onMouseLeave={() => setHover({ row: null, col: null })}
										title={`${u.name} — open its slice`}
										className={`mx-auto block max-h-36 truncate pb-2 font-mono text-[11px] [writing-mode:vertical-rl] rotate-180 hover:text-foreground ${unit === u.name ? "font-semibold text-foreground" : "text-muted-foreground"} ${u.mutability === "view" || u.mutability === "pure" ? "opacity-60" : ""}`}
									>
										{short(u.name)}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((v) => {
							const n = writers(v.name);
							return (
								<tr key={`${v.contract}.${v.name}`}>
									<th className={`sticky left-0 z-[5] border-b bg-card px-3 py-1.5 text-left font-normal ${hover.row === v.name ? "bg-muted" : ""}`}>
										<span className="flex items-center gap-2">
											<span className="truncate font-mono text-[12px] text-foreground">{v.name}</span>
											{n ? <span className="shrink-0 rounded bg-red-500/10 px-1 font-mono text-[10px] text-red-700 dark:text-red-400" title={`written by ${n} entry points`}>{n}w</span> : null}
										</span>
									</th>
									{cols.map((u) => {
										const r = u.reads.includes(v.name);
										const w = u.writes.includes(v.name);
										const lit = hover.row === v.name || hover.col === u.name || unit === u.name;
										return (
											<td
												key={u.name}
												onMouseEnter={() => setHover({ row: v.name, col: u.name })}
												onMouseLeave={() => setHover({ row: null, col: null })}
												onClick={() => (r || w ? onOpen(u.name) : undefined)}
												title={`${short(u.name)} ${w && r ? "reads and writes" : w ? "writes" : r ? "reads" : "doesn't touch"} ${v.name}`}
												className={`h-7 w-8 border-b p-0 text-center ${lit ? "bg-muted/70" : ""} ${r || w ? "cursor-pointer" : ""}`}
											>
												{w || r ? (
													<span
														className={`mx-auto block size-4 rounded-[4px] ${w && r ? "bg-gradient-to-br from-sky-500/50 from-50% to-red-500/80 to-50%" : w ? "bg-red-500/80" : "bg-sky-500/50"}`}
													/>
												) : null}
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{unit ? (
				<div className="relative min-h-0 overflow-y-auto rounded-xl border bg-card px-4 py-3 shadow-card">
					<button type="button" onClick={onClose} title="Close the slice" className="absolute right-2 top-2 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">×</button>
					{slice ? <div className="prose prose-sm max-w-none dark:prose-invert"><ChatMarkdown>{slice}</ChatMarkdown></div> : <p className="text-[13px] text-muted-foreground">Building the slice…</p>}
				</div>
			) : null}
		</div>
	);
}

/** Audit mode: which entry point touches which storage, for the contract picked here (read from the AST). */
function AuditView({ folder, scan, invoke, preferred }: { folder: string; scan: Scan | null; invoke: Bridge["invoke"]; preferred: string | null }) {
	const sources = (scan?.solidity ?? []).filter((f) => !f.endsWith(".t.sol") && !f.endsWith(".s.sol"));
	const pick = preferred && sources.includes(preferred) ? preferred : (sources.find((f) => f.startsWith("src/")) ?? sources[0] ?? null);
	const [entry, setEntry] = useState<string | null>(pick);
	const [data, setData] = useState<AstUnits | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [unit, setUnit] = useState<string | null>(null);
	const [slice, setSlice] = useState<string | null>(null);
	useEffect(() => {
		if (!entry && pick) setEntry(pick);
	}, [entry, pick]);
	useEffect(() => {
		if (!entry) return;
		setData(null);
		setError(null);
		setUnit(null);
		setSlice(null);
		void invoke<AstUnits>("ast_units", { folder, entry }).then(setData, (e) => setError(String(e)));
	}, [folder, entry, invoke]);
	const open = (name: string) => {
		setUnit(name);
		setSlice(null);
		void invoke<string>("ast_slice", { folder, entry, function: name }).then(setSlice, (e) => setSlice(`Couldn't build the slice: ${e}`));
	};
	return (
		<>
			<div className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-[12px]">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Storage × entry points</span>
				<DropdownMenu>
					<DropdownMenuTrigger className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border bg-background px-2 font-mono text-[11px] outline-none hover:bg-muted" title="The contract to read">
						<span className="truncate">{entry ?? "No Solidity sources"}</span>
						<ChevronDown className="size-3 shrink-0" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
						<DropdownMenuRadioGroup value={entry ?? ""} onValueChange={setEntry}>
							{sources.map((f) => (
								<DropdownMenuRadioItem key={f} value={f} className="font-mono text-[11px]">{f}</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				{data ? <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{data.contract} · {data.ms} ms</span> : null}
			</div>
			{error ? <p className="whitespace-pre-wrap rounded-xl border bg-card p-3 font-mono text-[11px] text-red-600">{error}</p> : null}
			{!data && !error ? <p className="p-3 text-[13px] text-muted-foreground">{entry ? "Reading the AST…" : "No Solidity sources in this folder."}</p> : null}
			{data ? <StorageMatrix data={data} unit={unit} slice={slice} onOpen={open} onClose={() => setUnit(null)} /> : null}
		</>
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
	const [model, setModel] = useState(() => store.get("fm:model") ?? MODELS[0].value);
	
	// Set in Settings (desktop/src/settings.tsx).
	const [provider] = useState<Provider>(() => (store.get("fm:provider") === "anthropic" ? "anthropic" : "formal"));
	const [hasKey, setHasKey] = useState(false);
	const [sessions, setSessions] = useState<Session[]>([]);
	const [proofs, setProofs] = useState<Record<string, Proof>>({});
	const [openItem, setOpenItem] = useState<number | null>(null);
	const [file, setFile] = useState<{ path: string; text: string } | null>(null);
	const [planOpen, setPlanOpen] = useState(false);
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
	// The page's mode (Code, Swarm, Audit) and the open file live in the URL, so they survive reloads.
	const [params, setParams] = useSearchParams();
	const mode = (params.get("mode") as Mode | null) ?? "swarm";
	// The main contract's entry points, read from the AST, so the plan can name the ones each item covers.
	const [entryUnits, setEntryUnits] = useState<AstUnit[]>([]);
	const mainSource = (scan?.solidity ?? []).find((f) => f.startsWith("src/") && !f.endsWith(".t.sol") && !f.endsWith(".s.sol")) ?? null;
	useEffect(() => {
		setEntryUnits([]);
		if (mode !== "swarm" || !mainSource) return;
		void invoke<AstUnits>("ast_units", { folder, entry: mainSource }).then(
			(d) => setEntryUnits(d.units.filter((u) => u.mutability !== "view" && u.mutability !== "pure" && u.function !== "constructor")),
			() => setEntryUnits([]),
		);
	}, [mode, folder, mainSource, invoke]);
	const setMode = (m: Mode) => {
		const next = new URLSearchParams(params);
		next.set("mode", m);
		setParams(next);
	};
	const loadFile = (path: string) => {
		void invoke<string>("folder_read", { folder, path }).then(
			(text) => setFile({ path, text }),
			(e) => setError(String(e)),
		);
	};
	/** Opens a file in the Code tab. */
	const view = (path: string) => {
		const next = new URLSearchParams(params);
		next.set("file", path);
		next.set("mode", "code");
		setParams(next);
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
	// Every file in the folder, for the breadcrumbs' menus.
	const [tree, setTree] = useState<string[]>([]);
	useEffect(() => {
		void invoke<{ files: string[] }>("folder_tree", { path: folder }).then((t) => setTree(t.files), () => setTree([]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder]);
	// The file picked in the sidebar's tree (or a proof link) is what the Code tab shows.
	// Without one, it reopens the last file this folder showed.
	useEffect(() => {
		const key = `fm:file:${folder}`;
		if (openPath) {
			store.set(key, openPath);
			loadFile(openPath);
			return;
		}
		setFile(null);
		const last = store.get(key);
		if (!last) return;
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.set("file", last);
				return next;
			},
			{ replace: true },
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openPath, folder]);
	// Sessions are picked from the chat card's title (the sidebar holds the folder's files).
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
	// Entry points a plan item names, matched as whole words in its text.
	const named = (text: string) => entryUnits.filter((u) => new RegExp(`\\b${u.function}\\b`).test(text));
	const inPlan = new Set(plan.flatMap((i) => named(i.text).map((u) => u.function)));
	const finished = !run ? events.find((e) => e.kind === "done") : undefined;
	const shown = events.filter((e) => e.kind !== "status");

	// The plan as a list with each item's proof, on the Swarm canvas.
	const planList = (
						<ul className="space-y-0.5 p-2 text-[13px]">
							{plan.length === 0 ? <li className="p-2 text-muted-foreground">The planner writes .formal/plan.md on the first run.</li> : null}
							{plan.map((i) => {
								const proof = proofs[String(i.index)];
								const expanded = openItem === i.index;
								return (
									<li key={i.index} className={`rounded-md ${working && working.item === String(i.index) ? "bg-muted" : ""}`}>
										<button type="button" disabled={!proof} onClick={() => setOpenItem(expanded ? null : i.index)} className="flex w-full gap-2 px-2 py-1 text-left enabled:hover:bg-muted/60 rounded-md">
											<span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${i.mark === "x" ? "border-emerald-500 bg-emerald-500 text-white" : i.mark === "!" ? "border-amber-500 text-amber-600" : ""}`}>{i.mark === "x" ? "✓" : i.mark === "!" ? "!" : ""}</span>
											<span className="min-w-0 flex-1">
												<span className={i.mark === "x" ? "text-muted-foreground" : ""}>{i.text}</span>
												{named(i.text).length ? (
													<span className="mt-1 flex flex-wrap gap-1">
														{named(i.text).map((u) => (
															<span key={u.name} className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground" title={u.writes.length ? `writes ${u.writes.join(", ")}` : "writes nothing"}>{u.function}</span>
														))}
													</span>
												) : null}
											</span>
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
	);

	// Every state-changing entry point; the ones no plan item names are the gaps.
	const entryList = entryUnits.length ? (
		<div className="border-t p-2">
			<div className="flex items-center gap-2 px-2 pb-1.5 text-[11px] text-muted-foreground">
				<span className="font-mono uppercase tracking-wider">Entry points</span>
				<span>{inPlan.size}/{entryUnits.length} in the plan</span>
			</div>
			<div className="flex flex-wrap gap-1 px-1.5">
				{entryUnits.map((u) => (
					<button
						key={u.name}
						type="button"
						onClick={() => setMode("audit")}
						title={`${inPlan.has(u.function) ? "In the plan" : "Not in the plan"} · ${u.writes.length ? `writes ${u.writes.join(", ")}` : "writes nothing"}`}
						className={`rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] hover:bg-muted ${inPlan.has(u.function) ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-dashed text-muted-foreground"}`}
					>
						{u.function}
					</button>
				))}
			</div>
		</div>
	) : null;

	const pageTitle = (
		<>
			<span className="inline-flex h-8 min-w-0 items-center rounded-full border bg-background/90 px-3 text-sm shadow-sm backdrop-blur">{scan?.git ? <MarkGithubIcon className="mr-2 size-4 shrink-0" /> : null}<span className="truncate">{name}</span></span>
			{onDebug ? (
				<button type="button" onClick={() => onDebug(null)} title="Debug this folder's Foundry tests" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-background/90 px-3 text-[12px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
					<Bug className="size-3.5" />Debug
				</button>
			) : null}
		</>
	);

	return (
		<div className="relative flex h-full min-h-0 flex-1">
			{/* The canvas, as on the Swarm page, with the plan, files and bugs floating over it as one accordion. */}
			<div className="absolute inset-0 flex flex-col overflow-hidden">
				{/* Swarm mode shows the canvas; Code and Audit replace it. The name and the controls stay in every mode. */}
				{mode === "swarm" ? (
					<SwarmCanvas
						state={localBoard(folder, plan, events, Boolean(run), budget)}
						fill
						local
						repo={folder}
						actions={actions}
						title={pageTitle}
					/>
				) : (
					<div className="relative h-full w-full bg-background">
						<div className="absolute left-3 top-3 flex min-w-0 max-w-[calc(100%-14rem)] items-center gap-2">{pageTitle}</div>
						<div className="absolute right-3 top-3 flex items-center gap-2">{actions}</div>
					</div>
				)}
				<ModeTabs mode={mode} onMode={setMode} />
				{mode === "swarm" ? (
					<section className={`pointer-events-auto absolute left-3 top-14 z-10 flex w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border bg-muted/80 p-1 shadow-pop backdrop-blur ${planOpen ? "max-h-[calc(100%-4.5rem)]" : ""}`}>
						<button type="button" onClick={() => setPlanOpen(!planOpen)} aria-expanded={planOpen} className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-left">
							<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Plan</span>
							<span className="text-[11px] text-muted-foreground">{plan.length ? `${done}/${plan.length}` : ""}{entryUnits.length ? ` · ${inPlan.size}/${entryUnits.length} entry points` : ""}</span>
							<ChevronDown className={`ml-auto size-3.5 text-muted-foreground transition-transform ${planOpen ? "rotate-180" : ""}`} />
						</button>
						{planOpen ? <div className="min-h-0 overflow-y-auto rounded-xl border bg-card">{planList}{entryList}</div> : null}
					</section>
				) : null}
				{mode === "code" ? (
					// The page is the editor: the file fills the whole page under the tabs.
					<div className="absolute inset-x-0 bottom-0 top-14 z-10 flex min-h-0 flex-col">
						{file ? (
							<>
								<div className="flex h-8 shrink-0 items-center gap-2 border-b px-4">
									<FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
									<Breadcrumbs root={name} path={file.path} files={tree} onOpen={view} />
									<span className="ml-auto flex items-center gap-1">
										{onDebug && file.path.endsWith(".t.sol") ? (
											<button type="button" onClick={() => onDebug(file.path)} title={`Debug a test in ${file.path}`} className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
												<Bug className="size-3" />Debug
											</button>
										) : null}
										<CopyButton text={file.text} label="Copy the file" />
									</span>
								</div>
								<div className="min-h-0 flex-1 overflow-auto">
									<FileView path={file.path} text={file.text} big />
								</div>
							</>
						) : (
							<p className="m-auto text-sm text-muted-foreground">Pick a file in the sidebar.</p>
						)}
					</div>
				) : null}
				{mode === "bugs" ? <BugsView bugs={bugs} openBug={openBug} setOpenBug={setOpenBug} withPoc={withPoc} onOpenFile={view} /> : null}
				{mode === "audit" ? (
					<div className="pointer-events-auto absolute bottom-3 left-3 right-3 top-14 z-10 flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-muted/60 p-1">
						<AuditView folder={folder} scan={scan} invoke={invoke} preferred={openPath ?? null} />
					</div>
				) : null}
			</div>

			{/* The chat: start and steer the swarm, the plan, and the agents' messages. */}
			{/* The chat floats over the canvas on the right: a gray title bar with the run's controls, the white chat inside.
			    The strip above it stays free for the Live pill and the bell. */}
			{mode === "chat" ? (
			<aside className="absolute inset-x-0 bottom-0 top-14 z-20 mx-auto flex w-full max-w-3xl flex-col px-4 pb-3">
				<div className="flex h-8 shrink-0 items-center gap-2 pl-2 pr-0.5">
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
				<div className="mt-1 flex min-h-0 flex-1 flex-col overflow-hidden">
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
								setMode("bugs");
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
				
			</aside>
			) : null}
		</div>
	);
}
