import { MarkGithubIcon } from "@primer/octicons-react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NvimTerminal } from "./nvim-terminal";
import { reportError } from "@/lib/report-error";
import { JsonTree } from "./json-tree";
import { Bug, Check, ChevronDown, Code2, Copy, FileCode2, MessagesSquare, Network, Play, Plus, ScanSearch, Square, WandSparkles, Wrench } from "lucide-react";

// The project roadmap (GitHub Projects-style), the same view the web app had on its own page.
import { motion as vimMotion, search as vimSearch, setVimMode, useVimMode, type Cursor } from "@/components/vim-mode";
const ProjectView = lazy(() => import("@/components/project/project-view").then((m) => ({ default: m.ProjectView })));
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
function FileView({ path, text, big, start = 1, mark, cursor }: { path: string; text: string; big?: boolean; start?: number; mark?: number | null; cursor?: Cursor | null }) {
	const lines = useHighlightedCode(text, EXT[path.split(".").pop() ?? ""] ?? "text");
	const marked = useRef<HTMLSpanElement | null>(null);
	useEffect(() => {
		marked.current?.scrollIntoView({ block: "center" });
	}, [mark, path, lines.length]);
	const caret = useRef<HTMLSpanElement | null>(null);
	useEffect(() => {
		caret.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [cursor?.line, cursor?.col]);
	return (
		<pre className={`overflow-x-auto py-2 font-mono ${big ? "text-[12.5px] leading-6" : "text-[11px] leading-5"}`}>
			{lines.map((line, i) => (
				<span key={i} ref={i === mark ? marked : undefined} data-line={i} className={`relative block whitespace-pre pr-3 ${i === mark ? "bg-amber-300/25" : cursor?.line === i ? "bg-muted/60" : ""}`}>
					<span className="mr-3 inline-block w-9 select-none text-right text-muted-foreground/60">{i + start}</span>
					<span data-code>{line}</span>
					{cursor?.line === i ? <span ref={caret} data-vim-cursor className="pointer-events-none absolute top-0 h-full w-[1ch] bg-foreground/35" style={{ left: `calc(3rem + ${cursor.col}ch)` }} /> : null}
				</span>
			))}
		</pre>
	);
}

/** Whether a file parses as JSON (tsconfig-style comments don't, and show as text). */
function jsonValid(text: string) {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/** The 0-based line and UTF-16 character under a point in a FileView, when it is on a word. */
function codePosition(x: number, y: number): { line: number; character: number } | null {
	const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
	let node: Node | null = null;
	let offset = 0;
	if (doc.caretPositionFromPoint) {
		const p = doc.caretPositionFromPoint(x, y);
		if (p) [node, offset] = [p.offsetNode, p.offset];
	} else if (document.caretRangeFromPoint) {
		const r = document.caretRangeFromPoint(x, y);
		if (r) [node, offset] = [r.startContainer, r.startOffset];
	}
	if (!node || node.nodeType !== Node.TEXT_NODE) return null;
	const code = node.parentElement?.closest("[data-code]");
	const row = code?.parentElement;
	if (!code || !row?.dataset.line) return null;
	let character = 0;
	const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
	for (let t = walk.nextNode(); t && t !== node; t = walk.nextNode()) character += t.textContent?.length ?? 0;
	character += offset;
	const text = code.textContent ?? "";
	// On a word: the character under the pointer, or the one before it at a word's end.
	if (!/[\w$]/.test(text[character] ?? "") && !/[\w$]/.test(text[character - 1] ?? "")) return null;
	return { line: Number(row.dataset.line), character: /[\w$]/.test(text[character] ?? "") ? character : character - 1 };
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
		<div className="absolute inset-x-0 bottom-0 top-[var(--fm-top)] z-10 grid grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-3 px-3 pb-3">
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

type Mode = "code" | "chat" | "swarm" | "roadmap" | "audit" | "bugs" | "debug";

const MODES: { id: Mode; label: string; icon: typeof Code2 }[] = [
	{ id: "code", label: "Code", icon: Code2 },
	{ id: "chat", label: "Chat", icon: MessagesSquare },
	{ id: "swarm", label: "Swarm", icon: Network },
	{ id: "audit", label: "Audit", icon: ScanSearch },
	{ id: "bugs", label: "Bugs", icon: Bug },
];

/**
 * The folder's name, Debug and the page's modes as one macOS-style segmented control. The Mac app shows it in its
 * title bar; the web app centres it at the top of the page.
 */
function NavGroup({ name, git, onDebug, mode, onMode, inBar, compact }: { name: string; git: boolean; onDebug?: () => void; mode: Mode; onMode: (m: Mode) => void; inBar?: boolean; compact?: boolean }) {
	const seg = "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
	const h = inBar ? "h-6" : "h-7";
	return (
		<div role="tablist" aria-label="Mode" className={`pointer-events-auto inline-flex min-w-0 items-center gap-0.5 rounded-lg border bg-muted/90 p-0.5 shadow-sm backdrop-blur ${inBar ? "h-7" : "absolute left-1/2 top-3 z-20 h-8 max-w-[calc(100%-1.5rem)] -translate-x-1/2"}`}>
			<span className={`${seg} ${h} min-w-0 text-foreground`} title={name}>
				{git ? <MarkGithubIcon className="size-3.5 shrink-0" /> : null}
				<span className={`truncate ${compact ? "max-w-28" : "max-w-48"}`}>{name}</span>
			</span>
			{onDebug ? (
				<button type="button" role="tab" aria-selected={mode === "debug"} onClick={onDebug} title="Debug this folder's scripts and tests" className={`${seg} ${h} ${mode === "debug" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
					<Bug className="size-3.5" />
					{compact ? null : "Debug"}
				</button>
			) : null}
			<span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
			{MODES.map(({ id, label, icon: Icon }) => (
				<button key={id} type="button" role="tab" aria-selected={mode === id} aria-label={label} title={compact ? label : undefined} onClick={() => onMode(id)} className={`${seg} ${h} ${mode === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
					<Icon className="size-3.5" />
					{compact ? null : label}
				</button>
			))}
		</div>
	);
}

/** The Mac app's title bar slot (desktop/src/tabs.tsx), when there is one. */
function useTitlebarSlot() {
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	useEffect(() => setSlot(document.getElementById("fm-titlebar-slot")), []);
	return slot;
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

type FormalFn = {
	name: string;
	kind: string;
	visibility: string;
	mutability: string;
	entry: boolean;
	dependency: boolean;
	file: string | null;
	line: number;
	endLine: number;
	solidity: string;
	lean: string;
	def: string | null;
	why: string | null;
	theorems: number[];
};
type FormalTheorem = { name: string; file: string; line: number; sorry: boolean; text: string };
type Scripts = {
	scripts: { file: string; contract?: string; deploys?: string[]; calls?: { contract: string; function: string; line: number }[]; error?: string; ms: number }[];
	entryPoints: { contract: string; function: string; file: string; scripts: string[] }[];
	contracts: { name: string; file: string; kind: string; inScope: boolean; deployedBy: string[]; via: string | null }[];
};
type Formal = { contract: string; namespace: string; modelLines: number; translated: number; opaque: number; ext: number; functions: FormalFn[]; theorems: FormalTheorem[]; ms: number };

/** Where a function stands: proved by a finished theorem, modeled in Lean, or left opaque (and why). */
function fnStatus(f: FormalFn, theorems: FormalTheorem[]) {
	if (f.why) return { key: "opaque", label: "Opaque", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" } as const;
	const by = f.theorems.map((i) => theorems[i]);
	if (by.some((t) => !t.sorry)) return { key: "proved", label: "Proved", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" } as const;
	if (by.length) return { key: "sorry", label: "Has sorry", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-400" } as const;
	return { key: "modeled", label: "In Lean", dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-400" } as const;
}

const COVERAGE_FILTERS = [
	{ id: "all", label: "All" },
	{ id: "proved", label: "Proved" },
	{ id: "modeled", label: "Not proved" },
	{ id: "opaque", label: "Opaque" },
] as const;

/**
 * What the agents have established for one contract, read from the AST: every function the Lean model reached, its
 * Solidity beside its Lean, and the theorems in the folder that name it. Opaque functions say why they couldn't be
 * translated (the model then holds for every behaviour of them).
 */
function CoverageView({ data, scripts, onOpenFile }: { data: Formal; scripts: Scripts | null; onOpenFile: (path: string) => void }) {
	// The scripts that call a function, matched by its contract (or the contract it is inherited into) and name.
	const contractOf = (f: FormalFn) => f.name.split(".").slice(0, -1).join(".");
	const fnName = (f: FormalFn) => f.name.split(".").pop() ?? f.name;
	const calledBy = (f: FormalFn) => (scripts?.entryPoints ?? []).filter((e) => e.function === fnName(f) && (e.contract === contractOf(f) || e.contract === data.contract)).flatMap((e) => e.scripts);
	const [filter, setFilter] = useState<(typeof COVERAGE_FILTERS)[number]["id"]>("all");
	const [deps, setDeps] = useState(false);
	const shown = data.functions.filter((f) => (deps || !f.dependency) && (filter === "all" || (filter === "modeled" ? ["modeled", "sorry"].includes(fnStatus(f, data.theorems).key) : fnStatus(f, data.theorems).key === filter)));
	const groups = [
		{ title: "Called by scripts", fns: shown.filter((f) => f.entry && calledBy(f).length) },
		{ title: scripts ? "Other entry points" : "Entry points", fns: shown.filter((f) => f.entry && !calledBy(f).length) },
		{ title: "Internal", fns: shown.filter((f) => !f.entry && !f.dependency) },
		{ title: "Libraries", fns: shown.filter((f) => !f.entry && f.dependency) },
	].filter((g) => g.fns.length);
	const [picked, setPicked] = useState<string | null>(null);
	const current = data.functions.find((f) => f.name === picked) ?? groups[0]?.fns[0] ?? null;
	const own = data.functions.filter((f) => !f.dependency);
	const proved = own.filter((f) => fnStatus(f, data.theorems).key === "proved").length;
	const inLean = own.filter((f) => !f.why).length;
	const status = current ? fnStatus(current, data.theorems) : null;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1">
			<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-2 text-[12px]">
				<span><span className="font-mono font-medium">{inLean}</span><span className="text-muted-foreground">/{own.length} functions in Lean</span></span>
				<span><span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">{proved}</span><span className="text-muted-foreground"> proved</span></span>
				<span><span className="font-mono font-medium text-amber-700 dark:text-amber-400">{own.length - inLean}</span><span className="text-muted-foreground"> opaque</span></span>
				<span className="text-muted-foreground"><span className="font-mono">{data.theorems.length}</span> theorems{data.theorems.some((t) => t.sorry) ? ` · ${data.theorems.filter((t) => t.sorry).length} with sorry` : ""}</span>
				<span className="ml-auto text-[11px] text-muted-foreground">{data.namespace} model · {data.modelLines} lines</span>
			</div>
			<div className="flex min-h-0 flex-1 gap-1">
				<nav className="flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-card">
					<div className="flex shrink-0 flex-wrap items-center gap-1 border-b p-1.5">
						{COVERAGE_FILTERS.map((f) => (
							<button key={f.id} type="button" onClick={() => setFilter(f.id)} className={`h-6 rounded-md px-2 text-[11px] ${filter === f.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
								{f.label}
							</button>
						))}
						<label className="ml-auto flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
							<input type="checkbox" checked={deps} onChange={(e) => setDeps(e.target.checked)} className="size-3" />
							libraries
						</label>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-1">
						{groups.map((g) => (
							<div key={g.title} className="mb-1">
								<p className="px-2 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{g.title} · {g.fns.length}</p>
								{g.fns.map((f) => {
									const st = fnStatus(f, data.theorems);
									return (
										<button
											key={f.name}
											type="button"
											onClick={() => setPicked(f.name)}
											title={st.label}
											className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] ${current?.name === f.name ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
										>
											<span className={`size-2 shrink-0 rounded-full ${st.dot}`} />
											<span className="truncate">{f.name.split(".").slice(-1)[0]}</span>
											{f.theorems.length ? <span className="ml-auto shrink-0 text-[10px]">{f.theorems.length}</span> : null}
											{calledBy(f).length ? <span className="ml-auto shrink-0 rounded bg-muted px-1 font-sans text-[10px] text-muted-foreground" title={calledBy(f).join("\n")}>{calledBy(f).length} script{calledBy(f).length > 1 ? "s" : ""}</span> : null}
										</button>
									);
								})}
							</div>
						))}
						{groups.length === 0 ? <p className="p-2 text-[12px] text-muted-foreground">Nothing matches.</p> : null}
					</div>
				</nav>
				{current && status ? (
					<section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
						<header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
							<span className="font-mono text-[13px] font-medium">{current.name}</span>
							<span className={`inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] ${status.text}`}>
								<span className={`size-1.5 rounded-full ${status.dot}`} />
								{status.label}
							</span>
							<span className="text-[11px] text-muted-foreground">{[current.visibility, current.mutability !== "nonpayable" ? current.mutability : ""].filter(Boolean).join(" · ")}</span>
							{calledBy(current).length ? <span className="text-[11px] text-muted-foreground">called by {calledBy(current).map((x) => x.split("/").pop()).join(", ")}</span> : null}
							{current.file ? (
								<button type="button" onClick={() => onOpenFile(current.file!)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Open in Code">
									<FileCode2 className="size-3" />
									{current.file}:{current.line}
								</button>
							) : null}
						</header>
						<div className="min-h-0 flex-1 overflow-y-auto">
							<div className="grid min-h-0 grid-cols-1 divide-y xl:grid-cols-2 xl:divide-x xl:divide-y-0">
								<div className="min-w-0">
									<p className="px-3 pt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Solidity</p>
									<FileView path="f.sol" text={current.solidity} start={current.line} />
								</div>
								<div className="min-w-0">
									<p className="px-3 pt-2 font-mono text-[10px] tracking-wider text-muted-foreground">Lean4 SPEC{current.def ? ` · ${current.lean}` : ""}</p>
									{current.def ? (
										<FileView path="f.lean" text={current.def.trimEnd()} />
									) : (
										<div className="m-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] leading-5">
											<p className="font-medium text-amber-800 dark:text-amber-300">Not translated: {current.why}</p>
											<p className="mt-1 text-muted-foreground">
												The model keeps it as <code className="rounded bg-muted px-1 font-mono text-[11px]">ext.{current.lean}</code>, so every theorem holds for any behaviour of it.
											</p>
										</div>
									)}
								</div>
							</div>
							<div className="border-t">
								<p className="px-3 pt-2 font-mono text-[10px] tracking-wider text-muted-foreground">Lean4 PROOF · {current.theorems.length}</p>
								{current.theorems.length === 0 ? (
									<p className="px-3 pb-3 pt-1 text-[12px] text-muted-foreground">No proof in this folder names {current.def ? <code className="font-mono">{current.lean}</code> : "it"} yet.</p>
								) : (
									current.theorems.map((i) => {
										const t = data.theorems[i];
										return (
											<div key={i} className={`mx-2 mb-2 mt-1 overflow-hidden rounded-lg border ${t.sorry ? "border-sky-500/30 bg-sky-500/[0.06]" : "border-emerald-500/30 bg-emerald-500/10"}`}>
												<div className={`flex items-center gap-2 border-b px-2.5 py-1 text-[11px] ${t.sorry ? "border-sky-500/20" : "border-emerald-500/20"}`}>
													<span className={`size-1.5 rounded-full ${t.sorry ? "bg-sky-500" : "bg-emerald-500"}`} />
													<span className="font-mono font-medium">{t.name}</span>
													{t.sorry ? <span className="text-sky-700 dark:text-sky-400">sorry</span> : null}
													<button type="button" onClick={() => onOpenFile(t.file)} className="ml-auto font-mono text-muted-foreground hover:text-foreground">
														{t.file}:{t.line}
													</button>
												</div>
												<FileView path="f.lean" text={t.text} start={t.line} />
											</div>
										);
									})
								)}
							</div>
						</div>
					</section>
				) : null}
			</div>
		</div>
	);
}

/** Audit mode: what's been established for the contract picked here, as Lean coverage. */
function AuditView({ folder, scan, invoke, preferred, onOpenFile }: { folder: string; scan: Scan | null; invoke: Bridge["invoke"]; preferred: string | null; onOpenFile: (path: string) => void }) {
	const sources = (scan?.solidity ?? []).filter((f) => !f.endsWith(".t.sol") && !f.endsWith(".s.sol"));
	const pick = preferred && sources.includes(preferred) ? preferred : (sources.find((f) => f.startsWith("src/")) ?? sources[0] ?? null);
	const [entry, setEntry] = useState<string | null>(pick);
	const [formal, setFormal] = useState<Formal | null>(null);
	const [scripts, setScripts] = useState<Scripts | null>(null);
	const [error, setError] = useState<string | null>(null);
	const errorSource = useRef("");
	errorSource.current = `Audit · ${entry ?? ""}`;
	useEffect(() => {
		if (error) reportError(errorSource.current, error);
	}, [error]);
	useEffect(() => {
		setScripts(null);
		void invoke<Scripts>("ast_scripts", { folder }).then(setScripts, () => setScripts(null));
	}, [folder, invoke]);
	useEffect(() => {
		if (!entry && pick) setEntry(pick);
	}, [entry, pick]);
	useEffect(() => {
		if (!entry) return;
		setFormal(null);
		setError(null);
		void invoke<Formal>("ast_formal", { folder, entry }).then(setFormal, (e) => setError(String(e)));
	}, [folder, entry, invoke]);
	const ready = formal;
	return (
		<>
			<div className="flex h-8 shrink-0 items-center gap-2 px-1.5 text-[12px]">
				<span className="pl-1 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lean coverage</span>
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
				{ready ? <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{ready.contract} · {ready.ms} ms</span> : null}
			</div>
			{error ? <p className="whitespace-pre-wrap rounded-xl border bg-card p-3 font-mono text-[11px] text-red-600">{error}</p> : null}
			{!ready && !error ? <p className="p-3 text-[13px] text-muted-foreground">{entry ? "Building the Lean model from the AST…" : "No Solidity sources in this folder."}</p> : null}
			{formal ? <CoverageView key={entry} data={formal} scripts={scripts} onOpenFile={onOpenFile} /> : null}
		</>
	);
}

/**
 * `debug` (the desktop app) renders Debug mode — the folder's Foundry tests in the debugger — for a test file;
 * without it there is no Debug mode.
 */
export function SwarmPanel({ folder, name, scan, bridge, session, file: openPath, actions, debug }: { folder: string; name: string; scan: Scan | null; bridge: Bridge; session?: string | null; file?: string | null; actions?: React.ReactNode; debug?: (file: string | null, test: string | null, onPick: (file: string) => void) => React.ReactNode }) {
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
	// Markdown files open rendered; the toggle shows their source (the choice is kept).
	const [mdSource, setMdSource] = useState(() => store.get("fm:md-view") === "source");
	// JSON files open as a collapsible tree; Raw shows the file as it is.
	// Every error the page shows also goes to the bell (copyable) and the app's error log.
	const errorSource = useRef(name);
	errorSource.current = name;
	useEffect(() => {
		if (error) reportError(errorSource.current, error);
	}, [error]);
	const [jsonRaw, setJsonRaw] = useState(() => store.get("fm:json-view") === "raw");
	const jsonOk = useMemo(() => Boolean(file && /\.json$/i.test(file.path) && jsonValid(file.text)), [file]);
	// Images a Markdown file points at, read from the folder (relative to the file), by path.
	const [images, setImages] = useState<Record<string, string>>({});
	const imagePath = (src: string, from: string) => {
		if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
		const parts = (src.startsWith("/") ? [] : from.split("/").slice(0, -1));
		for (const seg of src.replace(/^\//, "").split(/[?#]/)[0].split("/")) {
			if (seg === "..") parts.pop();
			else if (seg && seg !== ".") parts.push(decodeURIComponent(seg));
		}
		return parts.join("/");
	};
	useEffect(() => {
		if (!file || !/\.(md|markdown)$/i.test(file.path)) return;
		const srcs = [...file.text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g), ...file.text.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
		for (const src of new Set(srcs)) {
			const path = imagePath(src, file.path);
			if (!path || images[path]) continue;
			void invoke<string>("folder_image", { folder, path }).then(
				(url) => setImages((m) => ({ ...m, [path]: url })),
				() => undefined,
			);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [file, folder]);
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
	// Debug mode exists only where the page is given a debugger; an old link to it opens Code instead.
	const asked = (params.get("mode") as Mode | null) ?? "swarm";
	// The roadmap lives on the Swarm canvas now; an old link to its tab opens Swarm.
	const mode: Mode = asked === "debug" && !debug ? "code" : asked === "roadmap" ? "swarm" : asked;
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
	const view = (path: string, line?: number) => {
		const next = new URLSearchParams(params);
		next.set("file", path);
		next.set("mode", "code");
		if (line) next.set("line", String(line));
		else next.delete("line");
		setParams(next);
	};
	const markLine = Number(params.get("line")) || null;
	/** Debug mode on a test file (the debugger compiles it and lists its tests). */
	const debugFile = (path: string) => {
		const next = new URLSearchParams(params);
		next.set("file", path);
		next.set("mode", "debug");
		next.delete("line");
		setParams(next);
	};
	// Code navigation (solidity-language-server in the app): ⌘/Ctrl-click goes to the definition; resting on a
	// symbol shows its hover.
	const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hoverAt = useRef<string>("");
	const navigable = (path: string) => path.endsWith(".sol");
	// Vim keys (a setting): a cursor over the read-only file.
	const vim = useVimMode();
	const [cursor, setCursor] = useState<Cursor>({ line: 0, col: 0 });
	const [vimSearchText, setVimSearchText] = useState<string | null>(null);
	const lastSearch = useRef("");
	const pending = useRef("");
	const codeBox = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		setCursor({ line: markLine ? markLine - 1 : 0, col: 0 });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [file?.path, markLine]);
	const lspAt = (path: string, pos: { line: number; character: number }, then: "definition" | "hover") => {
		if (!navigable(path)) return;
		if (then === "definition") {
			void invoke<{ path: string; line: number; character: number }[]>("lsp_definition", { folder, path, ...pos }).then((defs) => defs[0] && view(defs[0].path, defs[0].line + 1), (err) => setError(String(err)));
			return;
		}
		const r = codeBox.current?.querySelector("[data-vim-cursor]")?.getBoundingClientRect();
		void invoke<string | null>("lsp_hover", { folder, path, ...pos }).then((text) => setHover(text && r ? { x: r.left, y: r.top, text } : null), () => setHover(null));
	};
	const vimKey = (e: React.KeyboardEvent) => {
		if (!vim || slot || !file || e.metaKey || e.altKey) return;
		const lines = file.text.split("\n");
		if (vimSearchText !== null) return;
		const key = e.ctrlKey ? `ctrl+${e.key}` : e.key;
		const page = Math.max(1, Math.floor((codeBox.current?.clientHeight ?? 480) / 24 / 2));
		const done = () => {
			e.preventDefault();
			pending.current = "";
		};
		if (key === "Escape") return done(), setHover(null);
		if (key === "ctrl+o") return done(), window.history.back();
		if (key === "ctrl+i") return done(), window.history.forward();
		if (/^[1-9]$/.test(key) || (key === "0" && /\d$/.test(pending.current))) {
			pending.current += key;
			return e.preventDefault();
		}
		const count = Number(pending.current.match(/\d+/)?.[0] ?? 1);
		const seq = pending.current.replace(/\d+/, "") + key;
		if (seq === "g" || seq === "y") {
			pending.current = pending.current + key;
			return e.preventDefault();
		}
		const pos = { line: cursor.line, character: cursor.col };
		if (seq === "gd" || key === "F12") return done(), lspAt(file.path, pos, "definition");
		if (seq === "K") return done(), lspAt(file.path, pos, "hover");
		if (seq === "yy") return done(), void navigator.clipboard?.writeText(lines[cursor.line] ?? "");
		if (seq === "/") return done(), setVimSearchText("");
		if (seq === "n" || seq === "N") {
			const to = vimSearch(lines, cursor, lastSearch.current, seq === "N");
			if (to) setCursor(to);
			return done();
		}
		const to = vimMotion(lines, cursor, seq === "gg" ? "gg" : key, pending.current.match(/\d+/) ? count : seq === "G" || seq === "gg" ? 1 : count, page);
		pending.current = "";
		if (to) {
			e.preventDefault();
			setHover(null);
			setCursor(to);
		}
	};
	const goToDefinition = (path: string, e: React.MouseEvent) => {
		if (!(e.metaKey || e.ctrlKey) || !navigable(path)) return;
		const pos = codePosition(e.clientX, e.clientY);
		if (!pos) return;
		e.preventDefault();
		setHover(null);
		void invoke<{ path: string; line: number; character: number }[]>("lsp_definition", { folder, path, ...pos }).then(
			(defs) => {
				const d = defs[0];
				if (d) view(d.path, d.line + 1);
			},
			(err) => setError(String(err)),
		);
	};
	const hoverMove = (path: string, e: React.MouseEvent) => {
		if (!navigable(path)) return;
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		const { clientX: x, clientY: y } = e;
		hoverTimer.current = setTimeout(() => {
			const pos = codePosition(x, y);
			const key = pos ? `${path}:${pos.line}:${pos.character}` : "";
			if (!pos) return setHover(null);
			if (key === hoverAt.current) return;
			hoverAt.current = key;
			void invoke<string | null>("lsp_hover", { folder, path, ...pos }).then(
				(text) => setHover(text && hoverAt.current === key ? { x, y, text } : null),
				() => setHover(null),
			);
		}, 450);
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
	// constructor, receive and fallback have no name of their own in the AST.
	const label = (u: AstUnit) => u.function || (u.name.split(".").pop() ?? u.name);
	const named = (text: string) => entryUnits.filter((u) => u.function && new RegExp(`\\b${u.function}\\b`).test(text));
	const inPlan = new Set(plan.flatMap((i) => named(i.text).map((u) => u.name)));
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
															<span key={u.name} className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground" title={u.writes.length ? `writes ${u.writes.join(", ")}` : "writes nothing"}>{label(u)}</span>
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

	// Every state-changing entry point and the storage it writes and reads (from the AST); the ones no plan item
	// names are the gaps.
	const entryList = entryUnits.length ? (
		<div className="border-t p-2">
			<div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground">
				<span className="font-mono uppercase tracking-wider">Entry points</span>
				<span>{inPlan.size}/{entryUnits.length} in the plan</span>
				<span className="ml-auto inline-flex items-center gap-2">
					<span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-red-500/70" />writes</span>
					<span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-sky-500/50" />reads</span>
				</span>
			</div>
			<ul className="space-y-px">
				{entryUnits.map((u) => {
					const reads = u.reads.filter((v) => !u.writes.includes(v));
					return (
						<li key={u.name} className="rounded-md px-2 py-1 hover:bg-muted/50">
							<div className="flex items-center gap-1.5">
								<span className={`size-1.5 shrink-0 rounded-full ${inPlan.has(u.name) ? "bg-emerald-500" : "border border-dashed border-muted-foreground/60"}`} title={inPlan.has(u.name) ? "In the plan" : "Not in the plan"} />
								<span className={`truncate font-mono text-[11.5px] ${inPlan.has(u.name) ? "text-foreground" : "text-muted-foreground"}`}>{label(u)}</span>
							</div>
							{u.writes.length || reads.length ? (
								<div className="ml-3 mt-0.5 flex flex-wrap gap-1">
									{u.writes.map((v) => (
										<span key={`w${v}`} className="rounded bg-red-500/10 px-1 font-mono text-[10px] text-red-700 dark:text-red-400">{v}</span>
									))}
									{reads.map((v) => (
										<span key={`r${v}`} className="rounded bg-sky-500/10 px-1 font-mono text-[10px] text-sky-700 dark:text-sky-400">{v}</span>
									))}
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	) : null;

	const slot = useTitlebarSlot();
	// Narrow pages show the modes as icons only (the Mac title bar also holds the app's tabs, so it needs more room).
	const root = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(1200);
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const compact = width < (slot ? 1100 : 820);
	const nav = <NavGroup name={name} git={Boolean(scan?.git)} onDebug={debug ? () => setMode("debug") : undefined} mode={mode} onMode={setMode} inBar={Boolean(slot)} compact={compact} />;

	return (
		// In the Mac app the controls live in the title bar, so the page starts at the top.
		<div ref={root} className="relative flex h-full min-h-0 flex-1" style={{ "--fm-top": slot ? "0px" : "3.5rem" } as React.CSSProperties}>
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
						below={{
							title: "Roadmap",
							height: 640,
							node: (
								<Suspense fallback={null}>
									<ProjectView repo={name} />
								</Suspense>
							),
						}}
					/>
				) : (
					<div className="relative h-full w-full bg-background">
						<div className="absolute right-3 top-3 flex items-center gap-2">{actions}</div>
					</div>
				)}
				{slot ? createPortal(nav, slot) : nav}
				{mode === "swarm" ? (
					<section className={`pointer-events-auto absolute left-3 top-[var(--fm-top)] z-10 flex w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border bg-muted/80 p-1 shadow-pop backdrop-blur ${planOpen ? "max-h-[calc(100%-var(--fm-top)-1rem)]" : ""}`}>
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
					<div className="absolute inset-x-0 bottom-0 top-[var(--fm-top)] z-10 flex min-h-0 flex-col">
						{file ? (
							<>
								<div className="flex h-8 shrink-0 items-center gap-2 border-y px-4">
									<FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
									<Breadcrumbs root={name} path={file.path} files={tree} onOpen={view} />
									<span className="ml-auto flex items-center gap-1">
										{debug && /\.[ts]\.sol$/.test(file.path) ? (
											<button type="button" onClick={() => debugFile(file.path)} title={`Debug ${file.path.endsWith(".s.sol") ? "this script" : "a test in this file"}`} className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
												<Bug className="size-3" />Debug
											</button>
										) : null}
										{/\.(md|markdown)$/i.test(file.path) ? (
											<span role="tablist" aria-label="Markdown view" className="mr-1 inline-flex h-6 items-center rounded-md border bg-muted/60 p-0.5">
												{(["Preview", "Source"] as const).map((v) => {
													const on = (v === "Source") === mdSource;
													return (
														<button
															key={v}
															type="button"
															role="tab"
															aria-selected={on}
															onClick={() => {
																setMdSource(v === "Source");
																store.set("fm:md-view", v === "Source" ? "source" : "preview");
															}}
															className={`h-5 rounded px-2 text-[11px] ${on ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
														>
															{v}
														</button>
													);
												})}
											</span>
										) : null}
										{/\.json$/i.test(file.path) ? (
											<span role="tablist" aria-label="JSON view" className="mr-1 inline-flex h-6 items-center rounded-md border bg-muted/60 p-0.5">
												{(["Tree", "Raw"] as const).map((v) => {
													const on = (v === "Raw") === jsonRaw;
													return (
														<button
															key={v}
															type="button"
															role="tab"
															aria-selected={on}
															onClick={() => {
																setJsonRaw(v === "Raw");
																store.set("fm:json-view", v === "Raw" ? "raw" : "tree");
															}}
															className={`h-5 rounded px-2 text-[11px] ${on ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
														>
															{v}
														</button>
													);
												})}
											</span>
										) : null}
										<button
											type="button"
											onClick={() => setVimMode(!vim)}
											aria-pressed={vim}
											title={vim ? (slot ? "Vim mode is on: Neovim runs here. Turn it off" : "Vim keys are on. Turn them off") : slot ? "Open in Neovim (Vim mode)" : "Vim keys"}
											className={`inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[11px] font-medium ${vim ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
										>
											vim
										</button>
										<CopyButton text={file.text} label="Copy the file" />
									</span>
								</div>
								<div
									className={`min-h-0 flex-1 overflow-auto ${navigable(file.path) ? "[&_[data-code]]:cursor-text" : ""}`}
									ref={codeBox}
									tabIndex={vim && !slot ? 0 : undefined}
									onKeyDown={vimKey}
									onClick={(e) => {
										if (vim && slot) return;
										if (vim) {
											const pos = codePosition(e.clientX, e.clientY);
											if (pos) setCursor({ line: pos.line, col: pos.character });
										}
										goToDefinition(file.path, e);
									}}
									onMouseMove={(e) => !(vim && slot) && hoverMove(file.path, e)}
									onMouseLeave={() => {
										if (hoverTimer.current) clearTimeout(hoverTimer.current);
										hoverAt.current = "";
										setHover(null);
									}}
									onScroll={() => setHover(null)}
								>
									{vim && slot ? (
										// The Mac app runs real Neovim (bundled); the web keeps the light cursor below.
										<NvimTerminal bridge={bridge} folder={folder} path={file.path} line={markLine} />
									) : jsonOk && !jsonRaw ? (
										<JsonTree text={file.text} />
									) : /\.(md|markdown)$/i.test(file.path) && !mdSource ? (
										<ChatMarkdown className="mx-auto max-w-3xl px-6 py-6 text-[14px]" image={(src) => { const p = imagePath(src, file.path); return p === null ? src : images[p]; }}>{file.text}</ChatMarkdown>
									) : (
										<FileView path={file.path} text={file.text} big mark={markLine ? markLine - 1 : null} cursor={vim ? cursor : null} />
									)}
									{hover ? (
										<div className="pointer-events-none fixed z-50 max-h-72 max-w-xl overflow-hidden rounded-lg border bg-popover p-2 shadow-pop" style={{ left: Math.min(hover.x + 8, window.innerWidth - 580), top: hover.y + 16 }}>
											<ChatMarkdown className="text-[12px] [&_pre]:my-0 [&_pre]:p-2">{hover.text}</ChatMarkdown>
											<p className="mt-1 text-[10px] text-muted-foreground">{vim ? "gd goes to the definition · ctrl-o comes back" : "⌘-click to go to the definition"}</p>
										</div>
									) : null}
									{vim && !slot ? (
										<div className="sticky bottom-0 left-0 flex h-6 items-center gap-3 border-t bg-background/95 px-3 font-mono text-[11px] text-muted-foreground backdrop-blur">
											{vimSearchText !== null ? (
												<label className="flex flex-1 items-center">
													/
													<input
														autoFocus
														value={vimSearchText}
														onChange={(e) => setVimSearchText(e.target.value)}
														onKeyDown={(e) => {
															e.stopPropagation();
															if (e.key === "Enter") {
																lastSearch.current = vimSearchText;
																const to = vimSearch(file.text.split("\n"), cursor, vimSearchText);
																if (to) setCursor(to);
																setVimSearchText(null);
																codeBox.current?.focus();
															} else if (e.key === "Escape") {
																setVimSearchText(null);
																codeBox.current?.focus();
															}
														}}
														className="ml-0.5 min-w-0 flex-1 bg-transparent text-foreground outline-none"
													/>
												</label>
											) : (
												<>
													<span className="font-medium text-foreground">NORMAL</span>
													<span>{lastSearch.current ? `/${lastSearch.current}` : ""}</span>
													<span className="ml-auto">{cursor.line + 1}:{cursor.col + 1}</span>
												</>
											)}
										</div>
									) : null}
								</div>
							</>
						) : (
							<p className="m-auto text-sm text-muted-foreground">Pick a file in the sidebar.</p>
						)}
					</div>
				) : null}
				{mode === "debug" && debug ? (
					<div className="pointer-events-auto absolute inset-x-0 bottom-0 top-[var(--fm-top)] z-10 flex min-h-0 bg-background">
						{debug(openPath && /\.[ts]\.sol$/.test(openPath) ? openPath : null, params.get("test"), debugFile)}
					</div>
				) : null}
				{mode === "bugs" ? <BugsView bugs={bugs} openBug={openBug} setOpenBug={setOpenBug} withPoc={withPoc} onOpenFile={view} /> : null}
				{mode === "audit" ? (
					<div className="pointer-events-auto absolute bottom-3 left-3 right-3 top-[var(--fm-top)] z-10 flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-muted/60 p-1">
						<AuditView folder={folder} scan={scan} invoke={invoke} preferred={openPath ?? null} onOpenFile={view} />
					</div>
				) : null}
			</div>

			{/* The chat: start and steer the swarm, the plan, and the agents' messages. */}
			{/* The chat floats over the canvas on the right: a gray title bar with the run's controls, the white chat inside.
			    The strip above it stays free for the Live pill and the bell. */}
			{mode === "chat" ? (
			<aside className="absolute inset-x-0 bottom-0 top-[var(--fm-top)] z-20 mx-auto flex w-full max-w-3xl flex-col px-4 pb-3">
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
