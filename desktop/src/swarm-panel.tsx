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
type AuditTab = "tree" | "plan" | "entries" | "functions" | "files";

/** A chip in the AST tree: a bordered, rounded value. */
function Chip({ children, tone }: { children: React.ReactNode; tone?: "muted" | "amber" | "violet" }) {
	const color = tone === "amber" ? "text-amber-700 dark:text-amber-400" : tone === "violet" ? "text-violet-700 dark:text-violet-400" : tone === "muted" ? "text-muted-foreground" : "text-foreground";
	return <span className={`inline-flex h-7 shrink-0 items-center rounded-lg border bg-background px-2.5 font-mono text-[12px] ${color}`}>{children}</span>;
}

/** One member of a contract in the tree: a row of chips. */
function TreeRow({ children }: { children: React.ReactNode }) {
	return <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-1.5 text-[13px]">{children}</div>;
}

/** A contract (or base) as a group: its state, then its functions; the entry contract starts open. */
function TreeGroup({ c, open: initial }: { c: AstContract; open: boolean }) {
	const [open, setOpen] = useState(initial);
	const reached = c.functions.filter((f) => f.reached).length;
	return (
		<div className="rounded-2xl border p-3">
			<button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-[13px]">
				<ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
				<span className="font-mono font-medium">{c.name}</span>
				<span className="text-muted-foreground">· {c.kind} · {c.stateVars.length} state · {c.functions.length} functions ({reached} reached)</span>
				{c.file ? <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{c.file}</span> : null}
			</button>
			{open ? (
				<div className="relative mt-3 space-y-2 pl-10">
					{/* The bracket joining the members, as in a rule builder. */}
					<span aria-hidden className="absolute bottom-5 left-4 top-5 w-4 rounded-l-lg border-y border-l" />
					{c.stateVars.map((v) => (
						<TreeRow key={`v:${v.name}`}>
							<Chip>{v.name}</Chip>
							<span className="text-muted-foreground">is</span>
							<Chip tone="muted">{v.type}</Chip>
							{v.constant ? <Chip tone="violet">constant</Chip> : v.immutable ? <Chip tone="violet">immutable</Chip> : v.slot != null ? <Chip tone="muted">slot {v.slot}{v.offset ? `+${v.offset}` : ""}</Chip> : null}
						</TreeRow>
					))}
					{c.functions.map((f, i) => (
						<TreeRow key={`f:${f.name}:${i}`}>
							<Chip>{f.name}{f.kind === "function" ? "()" : ""}</Chip>
							<span className="text-muted-foreground">{f.kind === "modifier" ? "modifier" : "is"}</span>
							{f.kind !== "modifier" ? <Chip tone="muted">{f.visibility}</Chip> : null}
							{f.mutability && f.mutability !== "nonpayable" ? <Chip tone="muted">{f.mutability}</Chip> : null}
							{f.modifiers.map((m) => <Chip key={m} tone="violet">{m}</Chip>)}
							{f.entry ? <Chip tone="amber">entry point</Chip> : f.reached ? null : <span className="text-[11px] text-muted-foreground">not reached</span>}
						</TreeRow>
					))}
					{c.stateVars.length + c.functions.length === 0 ? <p className="text-[12px] text-muted-foreground">No members.</p> : null}
				</div>
			) : null}
		</div>
	);
}

/** The entry contract and its bases as the AST has them, in inheritance order, joined by "is". */
function AstTree({ tree }: { tree: AstContract[] }) {
	const [entry, ...bases] = tree;
	return (
		<div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-5 shadow-card">
			<p className="mb-3 font-mono text-[12px] font-medium uppercase tracking-wider text-muted-foreground">Contract</p>
			{entry ? <TreeGroup c={entry} open /> : null}
			{bases.length ? (
				<div className="relative mt-3 pl-16">
					<span aria-hidden className="absolute bottom-6 left-6 top-6 w-6 rounded-l-xl border-y border-l" />
					<span className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full border bg-background px-2 py-0.5 text-[12px] text-muted-foreground">is</span>
					<div className="space-y-3">
						{bases.map((c) => <TreeGroup key={c.name} c={c} open={false} />)}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** Audit mode: the contract as the AST reads it — entry points, their storage footprint and risks, and each one's
 *  slice (what an agent gets). */
function AuditView({ folder, scan, invoke, preferred, plan, planMeta }: { folder: string; scan: Scan | null; invoke: Bridge["invoke"]; preferred: string | null; plan: React.ReactNode; planMeta: string }) {
	const sources = (scan?.solidity ?? []).filter((f) => !f.endsWith(".t.sol") && !f.endsWith(".s.sol"));
	const pick = preferred && sources.includes(preferred) ? preferred : (sources.find((f) => f.startsWith("src/")) ?? sources[0] ?? null);
	const [entry, setEntry] = useState<string | null>(pick);
	const [data, setData] = useState<AstUnits | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [unit, setUnit] = useState<string | null>(null);
	const [slice, setSlice] = useState<string | null>(null);
	const [tab, setTab] = useState<AuditTab>("tree");
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
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">AST</span>
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
				{data ? (
					<div role="tablist" aria-label="What to show" className="flex min-w-0 items-center gap-0.5 rounded-lg border bg-background/60 p-0.5">
						{([
							["tree", `${data.contract} syntax tree`],
							["plan", `Plan${planMeta ? ` ${planMeta}` : ""}`],
							["entries", `${data.units.length} entry points`],
							["functions", `${data.reachable} functions`],
							["files", `${data.inScope} of ${data.files} files`],
						] as [AuditTab, string][]).map(([id, label]) => (
							<button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`h-6 shrink-0 rounded-md px-2.5 text-[12px] transition-colors ${tab === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
								{label}
							</button>
						))}
					</div>
				) : null}
				{data ? <span className="shrink-0 text-[11px] text-muted-foreground">{data.ms} ms</span> : null}
			</div>
			{data && tab === "tree" && data.tree ? <AstTree tree={data.tree} /> : null}
			{data && tab === "plan" ? <div className="min-h-0 overflow-y-auto rounded-xl border bg-card shadow-card">{plan}</div> : null}
			{data && tab === "functions" ? (
				<div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-3 shadow-card">
					{Object.entries(Object.groupBy(data.reached ?? [], (f) => f.name.split(".")[0])).map(([contract, fns]) => (
						<div key={contract} className="mb-4">
							<p className="mb-1.5 flex items-center gap-2 font-mono text-[12px] font-medium">
								{contract}
								{fns?.[0]?.dependency ? <span className="font-sans text-[11px] font-normal text-muted-foreground">dependency</span> : null}
							</p>
							<div className="flex flex-wrap gap-1.5">
								{fns?.map((f) => (
									<span key={f.name} title={`${f.kind} · ${f.visibility} · ${f.calls} calls · ${f.arith} arithmetic${f.asm ? ` · ${f.asm} assembly` : ""}`} className={`inline-flex h-7 items-center rounded-lg border px-2.5 font-mono text-[12px] ${f.dependency ? "text-muted-foreground" : "bg-background"}`}>
										{f.name.split(".").slice(1).join(".") || f.kind}
										{f.asm ? <span className="ml-1.5 text-violet-600">asm</span> : null}
									</span>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
			{data && tab === "files" ? (
				<div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-3 font-mono text-[12px] shadow-card">
					{[true, false].map((inScope) => (
						<div key={String(inScope)} className="mb-4">
							<p className="mb-1.5 font-sans text-[12px] font-medium">{inScope ? "In scope" : "Compiled, not reached"}</p>
							<ul className="space-y-0.5">
								{(data.scopeFiles ?? []).filter((f) => f.inScope === inScope).sort((a, b) => Number(a.dependency) - Number(b.dependency) || a.path.localeCompare(b.path)).map((f) => (
									<li key={f.path} className={`flex items-center gap-2 ${inScope && !f.dependency ? "" : "text-muted-foreground"}`}>
										<span className="truncate">{f.path}</span>
										{f.dependency ? <span className="font-sans text-[10px]">dependency</span> : null}
										{data.unusedImports.includes(f.path) ? <span className="font-sans text-[10px] text-amber-700">unused import</span> : null}
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			) : null}
			<div className={`min-h-0 flex-1 grid-cols-[minmax(0,22rem)_minmax(0,1fr)] gap-1 ${data && tab !== "entries" ? "hidden" : "grid"}`}>
				<div className="min-h-0 overflow-y-auto rounded-xl border bg-card p-1 shadow-card">
					{error ? <p className="whitespace-pre-wrap p-3 font-mono text-[11px] text-red-600">{error}</p> : null}
					{!data && !error ? <p className="p-3 text-[13px] text-muted-foreground">{entry ? "Reading the AST…" : "No Solidity sources in this folder."}</p> : null}
					{data?.unusedImports.length ? <p className="px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">Unused imports: {data.unusedImports.join(", ")}</p> : null}
					<ul>
						{data?.units.map((u) => (
							<li key={u.name}>
								<button type="button" onClick={() => open(u.name)} className={`w-full rounded-lg px-2 py-1.5 text-left hover:bg-muted ${unit === u.name ? "bg-muted" : ""}`}>
									<span className="flex items-center gap-2">
										<span className="truncate font-mono text-[12px]">{u.name}</span>
										<span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{u.mutability}</span>
									</span>
									<span className="mt-0.5 flex flex-wrap gap-x-2 text-[10.5px] text-muted-foreground">
										{u.writes.length ? <span className="text-foreground/80">writes {u.writes.join(", ")}</span> : <span>writes nothing</span>}
										{u.external ? <span className="text-amber-700 dark:text-amber-400">{u.external} external</span> : null}
										{u.guards ? <span>{u.guards} guards</span> : null}
										{u.arith ? <span>{u.arith} arith{u.unchecked ? ` (${u.unchecked} unchecked)` : ""}</span> : null}
										{u.asm ? <span className="text-violet-700 dark:text-violet-400">{u.asm} asm</span> : null}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
				<div className="min-h-0 overflow-y-auto rounded-xl border bg-card px-4 py-3 shadow-card">
					{unit ? (
						slice ? <div className="prose prose-sm max-w-none dark:prose-invert"><ChatMarkdown>{slice}</ChatMarkdown></div> : <p className="text-[13px] text-muted-foreground">Building the slice…</p>
					) : (
						<div className="text-[13px] text-muted-foreground">
							<p>Pick an entry point to see its slice: its storage footprint, the external calls and what each is followed by, its guards, arithmetic and assembly, and its code.</p>
							{data?.clusters.length ? (
								<div className="mt-4">
									<p className="mb-1 font-medium text-foreground">Units that write the same state</p>
									<ul className="space-y-1">
										{data.clusters.map((c, i) => (
											<li key={i} className="font-mono text-[11px]">
												{c.shared.join(", ")} ← {c.units.join(", ")}
											</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
					)}
				</div>
			</div>
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
	useEffect(() => {
		if (openPath) loadFile(openPath);
		else setFile(null);
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
	const finished = !run ? events.find((e) => e.kind === "done") : undefined;
	const shown = events.filter((e) => e.kind !== "status");

	// The plan as a list with each item's proof, shown in Audit's Plan tab.
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
	);

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
				{mode === "bugs" ? (
					<div className="absolute inset-x-0 bottom-0 top-14 z-10 overflow-y-auto">
						<div className="mx-auto w-full max-w-3xl px-4 pb-6">
							{bugs.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No bugs reported yet. The swarm files them here, each with a proof of concept.</p> : null}
							<ul className="space-y-2">
								{bugs.map((b) => (
									<li key={b.file} className="rounded-2xl border border-red-500/25 bg-red-50/60 dark:bg-red-950/30">
										<button type="button" onClick={() => setOpenBug(openBug === b.file ? null : b.file)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[14px]">
											<span className="size-1.5 shrink-0 rounded-full bg-red-500" />
											<span className="flex-1 font-medium">{b.title}</span>
											<CopyButton get={() => withPoc(b.body)} label="Copy the report as Markdown, PoC included" />
											<ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${openBug === b.file ? "rotate-180" : ""}`} />
										</button>
										{openBug === b.file ? <div className="prose prose-sm max-w-none border-t border-red-500/20 bg-background px-4 py-3 text-[13px] dark:prose-invert"><ChatMarkdown>{b.body.replace(/^# .*\n/, "")}</ChatMarkdown></div> : null}
									</li>
								))}
							</ul>
						</div>
					</div>
				) : null}
				{mode === "audit" ? (
					<div className="pointer-events-auto absolute bottom-3 left-3 right-3 top-14 z-10 flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-muted/60 p-1">
						<AuditView folder={folder} scan={scan} invoke={invoke} preferred={openPath ?? null} plan={planList} planMeta={plan.length ? `${done}/${plan.length}` : ""} />
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
