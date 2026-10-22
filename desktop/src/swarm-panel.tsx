import { MarkGithubIcon } from "@primer/octicons-react";
import { isTauri } from "@tauri-apps/api/core";
import { SemanticsPanel } from "./semantics-panel";
import { ProofWorkspace } from "./proof-workspace";
import { ProofRail, fnKey, proofGutter, useFileProofs } from "./code-proof-panel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NvimTerminal } from "./nvim-terminal";
import { reportError } from "@/lib/report-error";
import { JsonTree } from "./json-tree";
import { ArrowDown, Bug, Check, ChevronDown, Code2, Copy, FileCode2, FileDown, Network, Play, Plus, ScanSearch, Square, Terminal, ThumbsDown, ThumbsUp, WandSparkles } from "lucide-react";

// The project roadmap (GitHub Projects-style), the same view the web app had on its own page.
import { motion as vimMotion, search as vimSearch, setVimMode, useVimMode, type Cursor } from "@/components/vim-mode";
import { useSearchParams } from "react-router";
import { ChatComposer } from "@/components/chat-composer";
import { useReportDirs } from "@/lib/report-dirs";
import { auditJsonPath, parseAuditDoc, type AuditDoc, type AuditFindingDoc } from "@/lib/audit-format";
import { readEntryPoints, setMainEntryPoint } from "@/lib/entry-points";
import { openOnWeb } from "@/lib/open-web";
import { ChatScrubber } from "./chat-scrubber";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChatMarkdown } from "@/components/chat-markdown";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import { localBoard } from "./local-board";
import { ContextBody, ContextPanel, parseContext } from "./context-panel";
import type { Scan } from "./local";

/** What the panel needs from its host: the desktop app's Tauri commands and events, or the web demo's stand-ins. */
export type Bridge = {
	invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
	listen: <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;
	apiBase: () => string;
};

import type { Diagnostic } from "@/lib/ast/run";

export type Ev = { folder?: string; run: string; kind: "start" | "status" | "context" | "say" | "tool" | "result" | "you" | "bug" | "plan" | "done" | "error"; role: string; item: string; text: string; spent: number };
type Item = { index: number; mark: string; text: string };
export type Bug = { file: string; title: string; body: string };
type Provider = "formal" | "anthropic" | "openai";
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
/** With your OpenAI key (Settings → Models), these instead. */
const OPENAI_MODELS = [
	{ value: "gpt-5", label: "GPT-5" },
	{ value: "gpt-5-mini", label: "GPT-5 mini" },
];
const colorOf = (role: string) => (ROLE_COLORS as Record<string, string>)[role] ?? "hsl(var(--muted-foreground))";
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };


type Block = { e: Ev } | { steps: { call: Ev; result?: Ev }[] };

/** The chat as blocks: messages stand alone; a run of tool calls (each with its result) folds into one trace. */
export function blocks(events: Ev[]): Block[] {
	const out: Block[] = [];
	for (const e of events) {
		const last = out.at(-1);
		if (e.kind === "tool") {
			if (last && "steps" in last) last.steps.push({ call: e });
			else out.push({ steps: [{ call: e }] });
		} else if (e.kind === "result") {
			const step = last && "steps" in last ? last.steps.at(-1) : undefined;
			if (step && !step.result) step.result = e;
		} else if (e.text.trim()) out.push({ e });
		// A line with nothing to say (a start without a focus) isn't shown.
	}
	return out;
}

/** A run of tool calls: "Used 4 tools", opening to each call and the start of its output. */
export function Steps({ steps, running }: { steps: { call: Ev; result?: Ev }[]; running: boolean }) {
	const one = steps.length === 1 ? steps[0].call.text : null;
	return (
		<Trace className="pl-1">
			<TraceCollapsible>
				<TraceCollapsibleTrigger>
					<TraceLine status={running ? "running" : undefined}>
						<TraceIcon><Terminal className="size-3.5" /></TraceIcon>
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
/** Under an agent's reply, as Mike's chat draws it: copy (a tick for a moment) and a thumbs up or down. */
function ReplyActions({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const [vote, setVote] = useState<"up" | "down" | null>(null);
	return (
		<div className="mt-1 flex items-center gap-3.5 text-muted-foreground/70 opacity-0 transition-opacity group-hover/reply:opacity-100 [@media(hover:none)]:opacity-100">
			<button
				type="button"
				title="Copy"
				onClick={() =>
					void navigator.clipboard.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
				}
				className="hover:text-foreground"
			>
				{copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
			</button>
			<button type="button" title="Good reply" onClick={() => setVote(vote === "up" ? null : "up")} className="hover:text-foreground">
				<ThumbsUp className={`size-3.5 ${vote === "up" ? "fill-current text-foreground" : ""}`} />
			</button>
			<button type="button" title="Bad reply" onClick={() => setVote(vote === "down" ? null : "down")} className="hover:text-foreground">
				<ThumbsDown className={`size-3.5 ${vote === "down" ? "fill-current text-foreground" : ""}`} />
			</button>
		</div>
	);
}

export function AgentMessage({ e, onBug }: { e: Ev; onBug: () => void }) {
	const color = e.kind === "bug" ? "#dc2626" : colorOf(e.role);
	return (
		<Message>
			<MessageContent className="gap-1">
				{/* The name in its colour says who it is. */}
				<MessageHeader className="gap-1.5 px-0 capitalize" style={{ color }}>
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
					<div className="group/reply">
						<ChatMarkdown>{e.text}</ChatMarkdown>
						<ReplyActions text={e.text} />
					</div>
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
/** A dot in the code's gutter (a function's proof status), on a 0-based line. */
export type GutterMark = { dot: string; title: string; onClick: () => void };

export function FileView({ path, text, big, start = 1, mark, cursor, diagnostics, gutter, band }: { path: string; text: string; big?: boolean; start?: number; mark?: number | null; cursor?: Cursor | null; /** solc's errors and warnings in this file: a wavy underline, the message under the line. */ diagnostics?: Diagnostic[]; gutter?: Map<number, GutterMark>; /** 0-based lines tinted as one block (the function the Proofs rail has picked). */ band?: { from: number; to: number } | null }) {
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
		// With gutter dots, a 1rem strip left of the line numbers holds them (lines keep their columns, so positions
		// measured from a line's start, like squiggles and the Vim cursor, don't move).
		<pre className={`overflow-x-auto py-2 font-mono ${gutter ? "pl-4" : ""} ${big ? "text-[12.5px] leading-6" : "text-[11px] leading-5"}`}>
			{lines.map((line, i) => (
				<span key={i} ref={i === mark ? marked : undefined} data-line={i} className={`relative block whitespace-pre pr-3 ${i === mark ? "bg-amber-300/25" : cursor?.line === i ? "bg-muted/60" : band && i >= band.from && i <= band.to ? "bg-foreground/[0.035]" : ""}`}>
					{band && i >= band.from && i <= band.to ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-foreground/25" /> : null}
					{gutter?.get(i) ? (
						<button
							type="button"
							title={gutter.get(i)!.title}
							aria-label={gutter.get(i)!.title}
							onClick={(e) => {
								e.stopPropagation();
								gutter.get(i)!.onClick();
							}}
							className="absolute -left-3.5 top-[0.5lh] grid size-3 -translate-y-1/2 place-items-center rounded-full hover:bg-muted"
						>
							<span className={`size-2 rounded-full ${gutter.get(i)!.dot}`} />
						</button>
					) : null}
					<span className="mr-3 inline-block w-9 select-none text-right text-muted-foreground/60">{i + start}</span>
					<span data-code>{line}</span>
					{cursor?.line === i ? <span ref={caret} data-vim-cursor className="pointer-events-none absolute top-0 h-full w-[1ch] bg-foreground/35" style={{ left: `calc(3rem + ${cursor.col}ch)` }} /> : null}
					{diagnostics
						?.filter((d) => d.line - start === i)
						.map((d, k) => {
							// To the end of its range on this line (a range over several lines: to the line's end).
							const width = d.endLine === d.line ? Math.max(1, d.endCol - d.col) : Math.max(1, (text.split("\n")[i]?.length ?? d.col) - d.col + 1);
							return (
								<span key={`u${k}`} className={`pointer-events-none absolute top-[calc(1lh-3px)] h-[3px] ${d.severity === "error" ? "fm-squiggle-error" : "fm-squiggle-warning"}`} style={{ left: `calc(3rem + ${d.col - 1}ch)`, width: `${width}ch` }} />
							);
						})}
					{diagnostics
						?.filter((d) => d.line - start === i)
						.map((d, k) => (
							<span key={`m${k}`} className={`block whitespace-pre-wrap py-0.5 pl-12 font-sans text-[11px] leading-4 ${d.severity === "error" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400"}`}>
								{d.severity === "error" ? "Error" : "Warning"}: {d.message}
							</span>
						))}
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

export const SEVERITY: Record<string, string> = {
	critical: "border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-400",
	high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
	medium: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	low: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
};

/** A report or finding on the Bugs page: the file it comes from on the card's header row, as on the Proofs page. */
function DetailCard({ label, action, bare, children }: { label: string; action?: React.ReactNode; bare?: boolean; children: React.ReactNode }) {
	return (
		<section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
			<header className="flex h-10 shrink-0 items-center gap-2 border-b pl-4 pr-2">
				<FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground" title={label}>{label}</span>
				{action}
			</header>
			{/* `bare`: the content lays itself out (a report: its PDF viewer, or its own scrolling text). */}
			<article className={`min-h-0 flex-1 ${bare ? "flex flex-col overflow-hidden" : "overflow-y-auto px-6 py-5"}`}>{children}</article>
		</section>
	);
}

/** Bug reports: a list on the left, the selected report on the right with its facts as chips. */
/** A finding from an audit index: a row of a "| ID | Severity | Finding | Status | Evidence |" table under its report's heading. */
export type AuditFinding = { report: string; id: string; severity: string; title: string; status: "fixed" | "works" | "acknowledged" | "rejected" | "open"; statusText: string; evidence: string; tests: string[]; index: string; detail?: AuditFindingDoc; doc?: AuditDoc };

/** Formal Mind's own report and findings: its `formal-mind.audit.json` (and the PDF made from it), and the swarm's
 * `formal-mind-swarm.md` rows in an index. Bugs lists them apart from the other audit reports. */
const isFormalMind = (report: string) => /^formal-mind(-swarm)?\.(md|pdf|audit\.json)$/i.test(report.split("/").pop() ?? "");

/** A report's findings in the standard format, as the Bugs list shows them. */
function findingsOfDoc(doc: AuditDoc, path: string): AuditFinding[] {
	// Formal Mind's own file has no source: its findings go under the PDF made from it.
	const name = doc.source?.split("/").pop() ?? (doc.kind === "internal" ? (path.split("/").pop() ?? path).replace(/\.audit\.json$/, ".pdf") : doc.title);
	return doc.findings.map((f) => ({
		report: name,
		id: f.id,
		severity: f.severity ? f.severity[0].toUpperCase() + f.severity.slice(1) : "—",
		title: f.title,
		status: f.status === "works as expected" ? "works" : f.status,
		statusText: f.status === "works as expected" ? "Works as expected" : f.status[0].toUpperCase() + f.status.slice(1),
		evidence: f.evidence ?? "",
		tests: [...new Set([...(f.tests ?? []), ...(f.poc ? [f.poc] : []), ...((f.evidence ?? "").match(/test\/[\w/.-]+\.t\.sol/g) ?? [])])],
		index: path,
		detail: f,
		doc,
	}));
}

// `text` colours a finding's ID in the list by its status (the list has no dots).
export const STATUS: Record<AuditFinding["status"], { label: string; dot: string; chip: string; text: string }> = {
	fixed: { label: "Fixed", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
	works: { label: "Works as expected", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", chip: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400" },
	acknowledged: { label: "Acknowledged", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", chip: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
	rejected: { label: "Rejected", dot: "bg-muted-foreground/50", text: "text-muted-foreground", chip: "border-border bg-muted text-muted-foreground" },
	open: { label: "Open", dot: "bg-red-500", text: "text-red-600 dark:text-red-400", chip: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400" },
};

/** Every finding in an audit index (audit/README.md and the like), with its status and the tests its evidence names. */
function parseAuditIndex(text: string, index: string): AuditFinding[] {
	const out: AuditFinding[] = [];
	let report = "";
	let cols: string[] | null = null;
	const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
	for (const line of text.split("\n")) {
		const h = line.match(/^#{2,3}\s+(.+)$/);
		if (h) {
			report = h[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`/g, "").trim();
			cols = null;
			continue;
		}
		if (!line.trim().startsWith("|")) {
			cols = null;
			continue;
		}
		const row = cells(line);
		if (!cols) {
			const lower = row.map((c) => c.toLowerCase());
			if (lower.includes("status") && (lower.includes("id") || lower.includes("finding"))) cols = lower;
			continue;
		}
		if (row.every((c) => /^:?-{2,}:?$/.test(c))) continue;
		const get = (name: string) => row[cols!.indexOf(name)] ?? "";
		const statusText = get("status");
		const st = statusText.toLowerCase();
		const status: AuditFinding["status"] = /fixed|✅/.test(st) ? "fixed" : /works|🟢/.test(st) ? "works" : /acknowledged|📝/.test(st) ? "acknowledged" : /rejected|❌/.test(st) ? "rejected" : "open";
		const evidence = get("evidence");
		out.push({
			report,
			id: get("id") || "—",
			severity: get("severity") || "—",
			title: get("finding") || get("title"),
			status,
			statusText: statusText.replace(/[✅🟢📝❌⏳]\s*/gu, ""),
			evidence,
			tests: [...new Set(evidence.match(/test\/[\w/.-]+\.t\.sol/g) ?? [])],
			index,
		});
	}
	return out;
}

/** A finding's own section of its report: from its `### [ID] …` heading (or one naming its title) to the next heading at that level or above. */
export function findingSection(report: string, id: string, title: string): string | null {
	const lines = report.split("\n");
	const clean = (t: string) => t.replace(/[`*_]/g, "").toLowerCase();
	const words = clean(title).split(/\W+/).filter((w) => w.length > 3).slice(0, 4);
	const at = lines.findIndex((l) => /^#{2,4}\s/.test(l) && (l.includes(`[${id}]`) || new RegExp(`^#{2,4}\\s+${id.replace(/[-]/g, "\\-")}\\b`).test(l) || (id === "—" && words.length > 0 && words.every((w) => clean(l).includes(w)))));
	if (at < 0) return null;
	const level = lines[at].match(/^#+/)![0].length;
	let end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l) && l.match(/^#+/)![0].length <= level);
	if (end < 0) end = lines.length;
	return lines.slice(at + 1, end).join("\n").trim();
}

/** A Solidity function's lines (by name) in a file: its signature to its closing brace, with the line it starts on. */
function functionLines(text: string, name: string): { code: string; line: number } | null {
	const lines = text.split("\n");
	const at = lines.findIndex((l) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(l));
	if (at < 0) return null;
	let depth = 0;
	let seen = false;
	for (let i = at; i < lines.length; i++) {
		for (const c of lines[i]) {
			if (c === "{") {
				depth++;
				seen = true;
			} else if (c === "}") depth--;
		}
		if (seen && depth <= 0) return { code: lines.slice(at, i + 1).join("\n"), line: at + 1 };
	}
	return { code: lines.slice(at).join("\n"), line: at + 1 };
}

/** A finding's proof of concept: the test function the evidence names, else the whole test file. */
function PocView({ folder, invoke, path, fns, onOpenFile }: { folder: string; invoke: Bridge["invoke"]; path: string; fns: string[]; onOpenFile: (path: string) => void }) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		setText(null);
		void invoke<string>("folder_read", { folder, path }).then(setText, (e) => setText(`// Couldn't read ${path}: ${e}`));
	}, [folder, path, invoke]);
	const parts = text ? fns.map((f) => functionLines(text, f)).filter((x): x is { code: string; line: number } => Boolean(x)) : [];
	return (
		<div className="mt-2 overflow-hidden rounded-xl border">
			<div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
				<Bug className="size-3.5 text-muted-foreground" />
				<span className="font-mono text-[12px]">{path}</span>
				{parts.length ? <span className="text-[11px] text-muted-foreground">· {fns.filter((f) => text && functionLines(text, f)).join(", ")}</span> : null}
				<button type="button" onClick={() => onOpenFile(path)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground">
					<Code2 className="size-3" />
					Open
				</button>
			</div>
			<div className="max-h-[28rem] overflow-auto bg-card">
				{text === null ? (
					<p className="p-3 text-[12px] text-muted-foreground">Reading…</p>
				) : parts.length ? (
					parts.map((p) => <FileView key={p.line} path={path} text={p.code} start={p.line} />)
				) : (
					<FileView path={path} text={text} />
				)}
			</div>
		</div>
	);
}

/** What `report_generate` wrote: Formal Mind's audit file, its AsciiDoc, the PDF when asciidoctor-pdf made one, and why not otherwise. */
type GeneratedReport = { json: string; adoc: string; pdf: string | null; note: string | null; findings: number; warnings: string[] };

type ReportQuote = { price_cents: number; paid: boolean; balance_cents: number; repo: string; commit: string };

/** Generate report's confirm step: what it's for, what it costs from credits, and the balance after. */
function ReportConfirm({ quote, onGenerate, onCancel }: { quote: ReportQuote; onGenerate: () => void; onCancel: () => void }) {
	const usd = (c: number) => `$${(c / 100).toFixed(2).replace(/\.00$/, "")}`;
	const short = (c: number) => usd(Math.max(0, c));
	const enough = quote.paid || quote.balance_cents >= quote.price_cents;
	return (
		<div className="mx-1 mb-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-3 py-2 text-[12px]">
			<div className="min-w-0 flex-1">
				<p>
					Formal Mind's report for <span className="font-medium">{quote.repo}</span> at <span className="font-mono">{quote.commit.slice(0, 7)}</span>
				</p>
				<p className="text-muted-foreground">
					{quote.paid
						? "Already paid for this commit: generating it again is free."
						: enough
							? `${usd(quote.price_cents)} from your credits, once for this commit. Balance ${short(quote.balance_cents)} → ${short(quote.balance_cents - quote.price_cents)}.`
							: `It costs ${usd(quote.price_cents)} and your balance is ${short(quote.balance_cents)}.`}
				</p>
			</div>
			<button type="button" onClick={onCancel} className="h-7 rounded-lg px-2 text-muted-foreground hover:bg-muted hover:text-foreground">
				Cancel
			</button>
			{enough ? (
				<button type="button" onClick={onGenerate} className="h-7 rounded-lg bg-foreground px-2.5 font-medium text-background hover:opacity-90">
					{quote.paid ? "Generate" : `Generate · ${usd(quote.price_cents)}`}
				</button>
			) : (
				<button type="button" onClick={() => openOnWeb("/billing")} className="h-7 rounded-lg bg-foreground px-2.5 font-medium text-background hover:opacity-90">
					Add credits
				</button>
			)}
		</div>
	);
}

/**
 * Bugs: the folder's audit reports (Markdown in its report folders, which the gear sets) and the swarm's findings,
 * each opened on the right.
 */
/**
 * The audit findings of a folder's report folders (`dirs`): each index's rows (README.md / INDEX.md) and each
 * standard audit file, with Formal Mind's own rows shown once. The reports are the other files there. Bugs on the Mac
 * and the web, and the phone's Bugs, read them this way.
 */
export function useAuditFindings(folder: string, files: string[], invoke: Bridge["invoke"], dirs: string[], reload = 0) {
	const inDirs = files.filter((f) => /\.(md|markdown|txt|pdf)$/i.test(f) && dirs.some((d) => f.startsWith(`${d.replace(/\/+$/, "")}/`))).sort();
	// An index (README.md / INDEX.md in a report folder) lists every finding with its status; the rest are reports.
	const indexes = inDirs.filter((f) => /(^|\/)(readme|index)\.md$/i.test(f));
	const reports = inDirs.filter((f) => !indexes.includes(f));
	const [findings, setFindings] = useState<AuditFinding[]>([]);
	// Which reading the findings are from, so `loaded` turns false again while a new one runs.
	const key = [folder, indexes.join("|"), reports.join("|"), reload].join("\n");
	const [loadedKey, setLoadedKey] = useState<string | null>(null);
	useEffect(() => {
		let gone = false;
		// The standard files: one next to each report (read even before the file tree lists them), and any others.
		const docs = [...new Set([...reports.map(auditJsonPath), ...files.filter((f) => f.endsWith(".audit.json") && dirs.some((d) => f.startsWith(`${d.replace(/\/+$/, "")}/`)))])];
		void Promise.all([
			...indexes.map((f) => invoke<string>("folder_read", { folder, path: f }).then((t) => parseAuditIndex(t, f), () => [] as AuditFinding[])),
			...docs.map((f) =>
				invoke<string>("folder_read", { folder, path: f }).then(
					(t) => {
						const doc = parseAuditDoc(t);
						return doc ? findingsOfDoc(doc, f) : [];
					},
					() => [] as AuditFinding[],
				),
			),
		]).then((all) => {
			if (gone) return;
			// The swarm's index rows that Formal Mind's file already has are shown once, from the file.
			const flat = all.flat();
			const inDoc = new Set(flat.filter((f) => f.doc && isFormalMind(f.report)).map((f) => f.id));
			setFindings(flat.filter((f) => f.doc || !isFormalMind(f.report) || !inDoc.has(f.id)));
			setLoadedKey(key);
		});
		return () => {
			gone = true;
		};
		// `reload` ticks when the swarm files a finding in the index.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder, indexes.join("|"), reports.join("|"), invoke, reload]);
	return { reports, indexes, findings, loaded: loadedKey === key };
}

export function BugsView({ folder, files, invoke, apiBase, bugs, openBug, setOpenBug, withPoc, onOpenFile, reload = 0, onTriage, onFilesChanged }: { folder: string; files: string[]; invoke: Bridge["invoke"]; apiBase: Bridge["apiBase"]; bugs: Bug[]; openBug: string | null; setOpenBug: (f: string | null) => void; withPoc: (body: string) => Promise<string>; onOpenFile: (path: string) => void; reload?: number; onTriage?: (path: string) => Promise<void>; onFilesChanged?: () => void }) {
	const dirs = useReportDirs(folder);
	// Generate report: the findings, Proofs coverage and in-scope code as an AsciiDoc report (and its PDF) in the audit
	// folder; `generated` ticks so a PDF already open is read again.
	const [generating, setGenerating] = useState<{ busy: boolean; note?: string } | null>(null);
	const [generated, setGenerated] = useState(0);
	// The confirm step: the report costs credits once per repository and commit, so ask first with the numbers.
	const [quote, setQuote] = useState<ReportQuote | "loading" | null>(null);
	const ask = async () => {
		setGenerating(null);
		setQuote("loading");
		try {
			setQuote(await invoke<ReportQuote>("report_quote", { folder, apiBase: apiBase() }));
		} catch (e) {
			setQuote(null);
			setGenerating({ busy: false, note: `Couldn't price the report: ${e}` });
		}
	};
	const generate = async () => {
		setQuote(null);
		setGenerating({ busy: true });
		try {
			const g = await invoke<GeneratedReport>("report_generate", { folder, dirs, apiBase: apiBase() });
			onFilesChanged?.();
			setGenerated((n) => n + 1);
			if (g.pdf) {
				setOpenBug(`report:${g.pdf}`);
				setGenerating(null);
			} else setGenerating({ busy: false, note: `Wrote ${g.json} (${g.findings} findings). ${g.note ?? ""}` });
		} catch (e) {
			setGenerating({ busy: false, note: `Couldn't generate the report: ${e}` });
		}
	};
	const { reports, indexes, findings } = useAuditFindings(folder, files, invoke, dirs, reload);
	const findingKey = (f: AuditFinding) => `audit:${f.report}#${f.id}#${f.title}`;
	// With nothing picked, the first finding opens.
	const picked = openBug?.startsWith("audit:") ? (findings.find((f) => findingKey(f) === openBug) ?? null) : !openBug && findings.length ? findings[0] : null;
	// The picked finding's report, for its section.
	const pickedReport = picked ? (reports.find((r) => r.split("/").pop() === picked.report) ?? null) : null;
	const [section, setSection] = useState<{ key: string; text: string | null } | null>(null);
	useEffect(() => {
		if (!picked || !pickedReport) return setSection(null);
		const key = `${picked.report}#${picked.id}#${picked.title}`;
		void invoke<string>("folder_read", { folder, path: pickedReport }).then(
			(t) => setSection({ key, text: findingSection(t, picked.id, picked.title) }),
			() => setSection({ key, text: null }),
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder, pickedReport, picked?.id, picked?.title, invoke]);
	const counts = findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {});
	// The status chips filter the list (several at once; none selected shows every finding).
	const [only, setOnly] = useState<Set<AuditFinding["status"]>>(new Set());
	const shownFindings = only.size ? findings.filter((f) => only.has(f.status)) : findings;
	const byReport = [...new Set(shownFindings.map((f) => f.report))].map((r) => ({ report: r, items: shownFindings.filter((f) => f.report === r) }));
	// Formal Mind's report and findings first, then the other audit reports.
	const fmReports = reports.filter(isFormalMind);
	const otherReports = reports.filter((r) => !isFormalMind(r));
	const fmGroups = byReport.filter((g) => isFormalMind(g.report));
	const otherGroups = byReport.filter((g) => !isFormalMind(g.report));
	const reportPath = openBug?.startsWith("report:") ? openBug.slice(7) : null;
	const [report, setReport] = useState<{ path: string; text: string; url?: string } | null>(null);
	// Reading a report into the index: the paths queued for the auditor this visit, and why one couldn't be.
	const [triaging, setTriaging] = useState<Record<string, string>>({});
	// What's open: a picked report or finding; with nothing picked, the first report, else the first finding.
	const selected = reportPath || picked ? null : (bugs.find((b) => b.file === openBug) ?? (reports.length || findings.length ? null : bugs[0]));
	const showing = picked ? null : reportPath ? `report:${reportPath}` : selected ? null : reports[0] && !findings.length ? `report:${reports[0]}` : null;
	const showingPath = showing?.slice(7) ?? null;
	useEffect(() => {
		if (!showingPath) return;
		setReport(null);
		if (/\.pdf$/i.test(showingPath)) {
			void invoke<string>("folder_image", { folder, path: showingPath }).then(
				(url) => setReport({ path: showingPath, text: "", url }),
				(e) => setReport({ path: showingPath, text: `Couldn't open ${showingPath}: ${e}` }),
			);
			return;
		}
		void invoke<string>("folder_read", { folder, path: showingPath }).then(
			(text) => setReport({ path: showingPath, text }),
			(e) => setReport({ path: showingPath, text: `Couldn't read ${showingPath}: ${e}` }),
		);
	}, [folder, showingPath, invoke, generated]);
	const facts = selected ? bugFacts(selected.body) : null;
	const head = "px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground";
	const reportItem = (r: string) => (
		<li key={r}>
			<button type="button" onClick={() => setOpenBug(`report:${r}`)} title={r} className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${showing === `report:${r}` ? "bg-muted" : "border-transparent hover:bg-muted/60"}`}>
				{/* Level with the title line, not centred on the two lines. */}
				<FileCode2 className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0">
					<span className="block truncate text-[13px] font-medium">{r.split("/").pop()?.replace(/\.(md|markdown|txt|pdf)$/i, "").replace(/[_-]+/g, " ")}</span>
					<span className="block truncate font-mono text-[10px] text-muted-foreground">{r}</span>
				</span>
			</button>
		</li>
	);
	const findingGroup = (g: { report: string; items: AuditFinding[] }) => (
		<div key={g.report} className="mb-2 mt-1">
			<p className="truncate px-2 pb-0.5 font-mono text-[10px] text-muted-foreground" title={g.report}>{g.report}</p>
			<ul className="space-y-0.5">
				{g.items.map((f) => {
					const k = findingKey(f);
					return (
						<li key={k}>
							<button type="button" onClick={() => setOpenBug(k)} title={`${f.id} · ${STATUS[f.status].label}`} className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${picked && findingKey(picked) === k ? "bg-muted" : "hover:bg-muted/60"}`}>
								<span className={`w-9 shrink-0 font-mono text-[11px] font-medium leading-5 ${STATUS[f.status].text}`}>{f.id}</span>
								<span className="min-w-0 flex-1 text-[12.5px] leading-5">{f.title.replace(/`/g, "")}</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
	return (
		// Laid out like Proofs: one gray frame with its label on top, the list and the selected report on white cards.
		<div className="pointer-events-auto absolute bottom-3 left-3 right-3 top-[var(--fm-top)] z-10 flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-muted/60 p-1">
			<div className="flex h-8 shrink-0 items-center gap-2 px-1.5">
				<span className="pl-1 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Bugs</span>
				<span className="ml-auto text-[11px] text-muted-foreground">{reports.length} report{reports.length === 1 ? "" : "s"} · {findings.length} finding{findings.length === 1 ? "" : "s"}</span>
				<button
					type="button"
					disabled={generating?.busy}
					onClick={() => void ask()}
					title="Write Formal Mind's report of this folder (formal-mind.audit.json, and a PDF with asciidoctor-pdf) from the swarm's findings, the Proofs coverage and the reviewed proofs, into the audit folder"
					className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-60"
				>
					<FileDown className="size-3.5" />
					{generating?.busy ? "Generating…" : quote === "loading" ? "Pricing…" : "Generate report"}
				</button>
			</div>
			{quote && quote !== "loading" ? <ReportConfirm quote={quote} onGenerate={() => void generate()} onCancel={() => setQuote(null)} /> : null}
			{generating?.note ? (
				<div className="mx-1 mb-1 flex items-start gap-2 rounded-xl border bg-card px-3 py-2 text-[12px]">
					<p className="min-w-0 flex-1 whitespace-pre-wrap">{generating.note}</p>
					<button type="button" onClick={() => setGenerating(null)} className="shrink-0 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
						Dismiss
					</button>
				</div>
			) : null}
			{/* On a phone the list sits above the report it opens. */}
			<div className="flex min-h-0 flex-1 gap-1 max-sm:flex-col">
				<nav className="flex w-80 shrink-0 flex-col overflow-y-auto rounded-xl border bg-card p-1.5 max-sm:max-h-[40%] max-sm:w-full">
					{findings.length ? (
						<div className="flex flex-wrap gap-1 px-2 pb-1 pt-2">
							{(Object.keys(STATUS) as AuditFinding["status"][]).filter((k) => counts[k]).map((k) => {
								const on = only.has(k);
								return (
									<button
										key={k}
										type="button"
										aria-pressed={on}
										title={on ? "Show every finding" : `Show only ${STATUS[k].label.toLowerCase()}`}
										onClick={() =>
											setOnly((cur) => {
												const next = new Set(cur);
												if (next.has(k)) next.delete(k);
												else next.add(k);
												return next;
											})
										}
										className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-opacity ${STATUS[k].chip} ${only.size && !on ? "opacity-45 hover:opacity-80" : ""} ${on ? "ring-1 ring-current" : ""}`}
									>
										{counts[k]} {STATUS[k].label.toLowerCase()}
									</button>
								);
							})}
							{only.size ? (
								<button type="button" onClick={() => setOnly(new Set())} className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
									Clear
								</button>
							) : null}
						</div>
					) : null}
					<p className={head}>Formal Mind</p>
					<ul className="space-y-1">
						{fmReports.map(reportItem)}
						{fmReports.length === 0 ? <li className="px-2 py-1 text-[12px] text-muted-foreground">No report yet. Generate report writes one from the swarm's findings and proofs.</li> : null}
					</ul>
					{fmGroups.map(findingGroup)}
					<p className="px-2 pb-0.5 pt-2 font-mono text-[10px] text-muted-foreground">Swarm agents · {bugs.length}</p>
					<ul className="space-y-1">
						{bugs.map((b) => {
							const f = bugFacts(b.body);
							const on = selected && b.file === selected.file;
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
						{bugs.length === 0 ? <li className="px-2 py-1 text-[12px] text-muted-foreground">None yet. The swarm files them here, each with a proof of concept.</li> : null}
					</ul>
					<p className={`${head} mt-3`}>Audit reports · {otherReports.length}</p>
					<ul className="space-y-1">
						{otherReports.map(reportItem)}
						{otherReports.length === 0 ? <li className="px-2 py-1 text-[12px] text-muted-foreground">No reports in {dirs.map((d) => `${d}/`).join(", ")}.</li> : null}
					</ul>
					{otherGroups.map(findingGroup)}
			</nav>
			<div className="flex min-w-0 flex-1 flex-col">
			{picked ? (
				<DetailCard label={`${picked.report} · ${picked.id}`}>
					<h2 className="text-[17px] font-semibold leading-snug">{picked.title.replace(/`/g, "")}</h2>
					<div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
						<span className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 font-medium ${STATUS[picked.status].chip}`}>
							{picked.statusText || STATUS[picked.status].label}
						</span>
						{picked.severity !== "—" ? <span className={`inline-flex h-7 items-center rounded-lg border px-2.5 font-medium ${SEVERITY[picked.severity.toLowerCase()] ?? "border-border"}`}>{picked.severity}</span> : null}
						{reports.find((r) => r.endsWith(`/${picked.report}`) || r.split("/").pop() === picked.report) ? (
							<button type="button" onClick={() => setOpenBug(`report:${reports.find((r) => r.split("/").pop() === picked.report)}`)} className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-background px-2.5 font-mono hover:bg-muted" title="Open the report">
								<FileCode2 className="size-3.5 text-muted-foreground" />
								{picked.report}
							</button>
						) : null}
					</div>
					{picked.detail ? (
						// The finding as the standard file holds it: the report's words, then where it stands now.
						<div className="mt-4 space-y-4">
							{picked.detail.locations?.length ? (
								<div className="flex flex-wrap gap-1.5">
									{picked.detail.locations.map((l) => (
										<button key={`${l.file}:${l.line ?? ""}`} type="button" onClick={() => onOpenFile(l.file)} title="Open in Code" className="inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 font-mono text-[11px] hover:bg-muted">
											<FileCode2 className="size-3 text-muted-foreground" />
											{l.file}
											{l.line ? `:${l.line}` : ""}
										</button>
									))}
								</div>
							) : null}
							{(
								[
									["Description", picked.detail.description],
									["Impact", picked.detail.impact],
									["Recommendation", picked.detail.recommendation],
									["Team response", picked.detail.response],
								] as const
							).map(([label, text]) =>
								text ? (
									<div key={label} className="prose prose-sm max-w-none dark:prose-invert">
										<p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
										<ChatMarkdown>{text}</ChatMarkdown>
									</div>
								) : null,
							)}
							{picked.detail.reportStatus ? <p className="text-[12px] text-muted-foreground">The report says: {picked.detail.reportStatus}</p> : null}
						</div>
					) : null}
					{picked.evidence ? (
						<div className="prose prose-sm mt-4 max-w-none dark:prose-invert">
							<p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Status evidence</p>
							<ChatMarkdown>{picked.evidence}</ChatMarkdown>
						</div>
					) : null}
					<div className="mt-5">
						<p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Proof of concept · {picked.tests.length}</p>
						{picked.tests.length ? (
							picked.tests.map((t) =>
								files.includes(t) ? (
									<PocView key={t} folder={folder} invoke={invoke} path={t} fns={(picked.evidence.match(/test\w*/g) ?? []).filter((f) => /^test_|^test[A-Z]/.test(f))} onOpenFile={onOpenFile} />
								) : (
									<p key={t} className="mt-1 font-mono text-[12px] text-red-700 dark:text-red-400">{t} · not in this folder</p>
								),
							)
						) : (
							<p className="mt-1 text-[12px] text-muted-foreground">No test named in the evidence.</p>
						)}
					</div>
					{picked.detail ? null : (
					<div className="mt-6 border-t pt-4">
						<p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">In the report{pickedReport ? ` · ${pickedReport}` : ""}</p>
						{!pickedReport ? (
							<p className="mt-1 text-[12px] text-muted-foreground">The report isn't in the report folders.</p>
						) : section && section.key === `${picked.report}#${picked.id}#${picked.title}` ? (
							section.text ? (
								<div className="prose prose-sm mt-2 max-w-none dark:prose-invert">
									<ChatMarkdown>{section.text}</ChatMarkdown>
								</div>
							) : (
								<p className="mt-1 text-[12px] text-muted-foreground">No section for {picked.id} in the report.</p>
							)
						) : (
							<p className="mt-1 text-[12px] text-muted-foreground">Reading…</p>
						)}
					</div>
					)}
					<p className="mt-5 text-[11px] text-muted-foreground">
						From {picked.index}
						{picked.doc ? ` · ${[picked.doc.auditor, picked.doc.date, picked.detail?.page ? `page ${picked.detail.page}` : ""].filter(Boolean).join(" · ")}` : ""}
					</p>
				</DetailCard>
			) : showing ? (
				<DetailCard
					label={showing.slice(7)}
					bare
					action={
						<>
							{onTriage ? (
								<button
									type="button"
									disabled={Boolean(triaging[showing.slice(7)])}
									onClick={() => {
										const p = showing.slice(7);
										setTriaging((t) => ({ ...t, [p]: "Reading…" }));
										void onTriage(p).then(
											() => setTriaging((t) => ({ ...t, [p]: "Reading… the auditor records each finding below as it goes" })),
											(e) => setTriaging((t) => ({ ...t, [p]: String(e) })),
										);
									}}
									title="The auditor reads this report and records every finding in the index next to it, with its status in the current code"
									className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-60"
								>
									<ScanSearch className="size-3.5" />
									{triaging[showing.slice(7)] ? "Reading" : "Read findings"}
								</button>
							) : null}
							{report && !report.url ? <CopyButton text={report.text} label="Copy the report as Markdown" /> : null}
							<button type="button" onClick={() => onOpenFile(showing.slice(7))} title="Open in Code" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-background hover:text-foreground">
								<Code2 className="size-3.5" />
								Code
							</button>
						</>
					}
				>
					{triaging[showing.slice(7)] ? <p className="border-b bg-muted/40 px-4 py-2 text-[12px] text-muted-foreground">{triaging[showing.slice(7)]}</p> : null}
					{report?.url && report.path === showing.slice(7) ? (
						<iframe src={report.url} title={showing.slice(7)} className="min-h-0 w-full flex-1 border-0" />
					) : (
						<div className="prose prose-sm min-h-0 max-w-none flex-1 overflow-y-auto px-6 py-5 dark:prose-invert">{report && report.path === showing.slice(7) ? <ChatMarkdown>{report.text}</ChatMarkdown> : <p className="text-muted-foreground">Opening…</p>}</div>
					)}
				</DetailCard>
			) : selected && facts ? (
				<DetailCard label={selected.file} action={<CopyButton get={() => withPoc(selected.body)} label="Copy the report as Markdown, PoC included" />}>
					<h2 className="text-[17px] font-semibold leading-snug">{selected.title}</h2>
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
				</DetailCard>
			) : (
				<p className="m-auto text-center text-[13px] text-muted-foreground">Nothing to show yet: no reports in the audit folders and no findings.</p>
			)}
			</div>
			</div>
		</div>
	);
}

export type Mode = "code" | "chat" | "swarm" | "roadmap" | "audit" | "bugs" | "debug";

const MODES: { id: Mode; label: string; icon: typeof Code2 }[] = [
	{ id: "code", label: "Code", icon: Code2 },
	{ id: "swarm", label: "Swarm", icon: Network },
	{ id: "audit", label: "Proofs", icon: ScanSearch },
	{ id: "bugs", label: "Bugs", icon: Bug },
];

/**
 * The page's modes, Debug and then the folder's name, as one macOS-style segmented control. The Mac app shows it in its
 * title bar; the web app centres it at the top of the page.
 */
/** Where the selected tab's pill last was, so a new page's tabs slide from there instead of jumping. */
let lastPill: { left: number; width: number } | null = null;

export function NavGroup({ name, git, onDebug, mode, onMode, inBar, compact }: { name: string; git: boolean; onDebug?: () => void; mode: Mode; onMode: (m: Mode) => void; inBar?: boolean; compact?: boolean }) {
	const seg = "relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring";
	const h = inBar ? "h-6" : "h-7";
	// One white pill under the selected tab, sliding between tabs (and across pages) rather than jumping.
	const box = useRef<HTMLDivElement>(null);
	const [pill, setPill] = useState(lastPill);
	const [animate, setAnimate] = useState(false);
	useLayoutEffect(() => {
		const el = box.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
		if (!el) return setPill(null);
		const next = { left: el.offsetLeft, width: el.offsetWidth };
		lastPill = next;
		setPill(next);
		// The first frame places it where it was; the move after that animates.
		const id = requestAnimationFrame(() => setAnimate(true));
		return () => cancelAnimationFrame(id);
	}, [mode, compact, name]);
	const tab = (on: boolean) => `${seg} ${h} ${on ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`;
	return (
		<div ref={box} role="tablist" aria-label="Mode" className={`pointer-events-auto inline-flex min-w-0 items-center gap-0.5 rounded-lg border bg-muted/90 p-0.5 shadow-sm backdrop-blur ${inBar ? "relative h-7" : "absolute left-1/2 top-3 z-20 h-8 max-w-[calc(100%-1.5rem)] -translate-x-1/2"}`}>
			{pill ? (
				<span
					aria-hidden
					className={`absolute rounded-md bg-background shadow-sm ${h} ${animate ? "transition-[left,width] duration-300 ease-out-quint motion-reduce:transition-none" : ""}`}
					style={{ left: pill.left, width: pill.width }}
				/>
			) : null}
			{MODES.map(({ id, label, icon: Icon }) =>
				// The Code tab is the folder itself: its name, with the GitHub mark when it is a git repository.
				id === "code" ? (
					<button key={id} type="button" role="tab" aria-selected={mode === id} aria-label={`Code · ${name}`} title={`Code · ${name}`} onClick={() => onMode(id)} className={`${tab(mode === id)} min-w-0`}>
						{git ? <MarkGithubIcon className="size-3.5 shrink-0" /> : <Code2 className="size-3.5 shrink-0" />}
						<span className={`truncate ${compact ? "max-w-28" : "max-w-48"}`}>{name}</span>
					</button>
				) : (
					<button key={id} type="button" role="tab" aria-selected={mode === id} aria-label={label} title={compact ? label : undefined} onClick={() => onMode(id)} className={tab(mode === id)}>
						<Icon className="size-3.5" />
						{compact ? null : label}
					</button>
				),
			)}
			{onDebug ? (
				<button type="button" role="tab" aria-selected={mode === "debug"} onClick={onDebug} title="Debug this folder's scripts and tests" className={tab(mode === "debug")}>
					<Bug className="size-3.5" />
					{compact ? null : "Debug"}
				</button>
			) : null}
		</div>
	);
}

/** A filled speech bubble with two lines cut out of it: the "Talk to the swarm" mark. */
export function TalkIcon({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 16 16" className={className} aria-hidden>
			<path
				fillRule="evenodd"
				fill="currentColor"
				d="M4 1h8a3.5 3.5 0 0 1 3.5 3.5v4A3.5 3.5 0 0 1 12 12H8.2l-3.9 2.6A.8.8 0 0 1 3 13.9V12h0A3.5 3.5 0 0 1 .5 8.5v-4A3.5 3.5 0 0 1 4 1Zm.6 4a.7.7 0 0 0 0 1.4h6.8a.7.7 0 0 0 0-1.4H4.6Zm1.4 2.8a.7.7 0 0 0 0 1.4h4a.7.7 0 0 0 0-1.4H6Z"
			/>
		</svg>
	);
}

/**
 * The mode a link asks for, as the page has it: Debug only with a debugger (else Code); Roadmap and Chat have no tab
 * now (the roadmap is on the Swarm canvas), so they open Swarm. The Chat view stays in the code for later.
 */
function resolveMode(asked: Mode, hasDebug: boolean): Mode {
	if (asked === "debug" && !hasDebug) return "code";
	if (asked === "roadmap" || asked === "chat") return "swarm";
	return asked;
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

export type FormalFn = {
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
export type FormalTheorem = { name: string; file: string; line: number; sorry: boolean; text: string };
export type Scripts = {
	scripts: { file: string; contract?: string; deploys?: string[]; calls?: { contract: string; function: string; line: number }[]; error?: string; ms: number }[];
	entryPoints: { contract: string; function: string; file: string; scripts: string[] }[];
	contracts: { name: string; file: string; kind: string; inScope: boolean; deployedBy: string[]; via: string | null }[];
};
export type Formal = { contract: string; namespace: string; modelLines: number; translated: number; opaque: number; ext: number; functions: FormalFn[]; theorems: FormalTheorem[]; ms: number };

/** Where a function stands: proved by a finished theorem, modeled in Lean, or left opaque (and why). */
export function fnStatus(f: FormalFn, theorems: FormalTheorem[]) {
	if (f.why) return { key: "opaque", label: "Not modeled", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" } as const;
	const by = f.theorems.map((i) => theorems[i]);
	if (by.some((t) => !t.sorry)) return { key: "proved", label: "Proved", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" } as const;
	if (by.length) return { key: "sorry", label: "Has sorry", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-400" } as const;
	return { key: "modeled", label: "In Lean", dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-400" } as const;
}

const COVERAGE_FILTERS = [
	{ id: "all", label: "All" },
	{ id: "proved", label: "Proved" },
	{ id: "modeled", label: "Not proved" },
	{ id: "opaque", label: "Not modeled" },
] as const;

/**
 * What the agents have established for one contract, read from the AST: every function the Lean model reached, its
 * Solidity beside its Lean, and the theorems in the folder that name it. Opaque functions say why they couldn't be
 * translated (the model then holds for every behaviour of them).
 */
function CoverageView({ data, scripts, onOpenFile }: { data: Formal; scripts: Scripts | null; onOpenFile: (path: string, line?: number) => void }) {
	// The scripts that call a function, matched by its contract (or the contract it is inherited into) and name.
	const contractOf = (f: FormalFn) => f.name.split(".").slice(0, -1).join(".");
	const fnName = (f: FormalFn) => f.name.split(".").pop() ?? f.name;
	const calledBy = (f: FormalFn) => (scripts?.entryPoints ?? []).filter((e) => e.function === fnName(f) && (e.contract === contractOf(f) || e.contract === data.contract)).flatMap((e) => e.scripts);
	const [filter, setFilter] = useState<(typeof COVERAGE_FILTERS)[number]["id"]>("all");
	// A function's identity: several share a name (overloads, or the same library compiled twice), so add where it is.
	const fnKey = (f: FormalFn) => `${f.name}@${f.file ?? ""}:${f.line}`;
	// Library functions are always listed and counted.
	const shown = data.functions.filter((f) => (filter === "all" || (filter === "modeled" ? ["modeled", "sorry"].includes(fnStatus(f, data.theorems).key) : fnStatus(f, data.theorems).key === filter)));
	const groups = [
		{ title: "Functions", fns: shown.filter((f) => f.entry && calledBy(f).length) },
		{ title: scripts ? "Other entry points" : "Entry points", fns: shown.filter((f) => f.entry && !calledBy(f).length) },
		{ title: "Internal", fns: shown.filter((f) => !f.entry && !f.dependency) },
		{ title: "Libraries", fns: shown.filter((f) => !f.entry && f.dependency) },
	].filter((g) => g.fns.length);
	const [picked, setPicked] = useState<string | null>(null);
	const current = data.functions.find((f) => fnKey(f) === picked) ?? groups[0]?.fns[0] ?? null;
	// The counts cover everything the list shows, library functions and their proofs included.
	const own = data.functions;
	const proved = own.filter((f) => fnStatus(f, data.theorems).key === "proved").length;
	const inLean = own.filter((f) => !f.why).length;
	const status = current ? fnStatus(current, data.theorems) : null;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1">
			<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-2 text-[12px]">
				<span><span className="font-mono font-medium">{inLean}</span><span className="text-muted-foreground">/{own.length} functions in Lean</span></span>
				<span><span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">{proved}</span><span className="text-muted-foreground"> proved</span></span>
				<span><span className="font-mono font-medium text-amber-700 dark:text-amber-400">{own.length - inLean}</span><span className="text-muted-foreground"> not modeled</span></span>
				{/* How much is proved: the share of every listed function (libraries included) with a finished proof. */}
				<span className="ml-auto inline-flex items-center gap-2 text-[11px] text-muted-foreground" title={`${proved} of ${own.length} functions proved`}>
					<span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
						<span className="block h-full rounded-full bg-emerald-500" style={{ width: `${own.length ? (proved / own.length) * 100 : 0}%` }} />
					</span>
					<span className="font-mono font-medium text-foreground">{own.length ? `${Math.round((proved / own.length) * 1000) / 10}%` : "0%"}</span>
					proved
				</span>
			</div>
			{/* On a phone the list sits above the function it opens. */}
			<div className="flex min-h-0 flex-1 gap-1 max-sm:flex-col">
				<nav className="flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-card max-sm:max-h-[42%] max-sm:w-full">
					<div className="flex shrink-0 flex-wrap items-center gap-1 border-b p-1.5">
						{COVERAGE_FILTERS.map((f) => (
							<button key={f.id} type="button" onClick={() => setFilter(f.id)} className={`h-6 rounded-md px-2 text-[11px] ${filter === f.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
								{f.label}
							</button>
						))}
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto p-1">
						{groups.map((g) => (
							<div key={g.title} className="mb-1">
								<p className="flex items-center gap-2 px-2 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
										<span className="truncate">{g.title}</span>
										<span className="ml-auto w-16 shrink-0 text-right">Theorems</span>
									</p>
								{g.fns.map((f) => {
									const st = fnStatus(f, data.theorems);
									return (
										<button
											key={fnKey(f)}
											type="button"
											onClick={() => setPicked(fnKey(f))}
											title={st.label}
											className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] ${current && fnKey(current) === fnKey(f) ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
										>
											<span className={`size-2 shrink-0 rounded-full ${st.dot}`} />
											<span className="truncate">{f.name.split(".").slice(-1)[0]}</span>
											<span className="ml-auto w-16 shrink-0 text-right text-[10px]">{f.theorems.length || null}</span>
										</button>
									);
								})}
							</div>
						))}
						{groups.length === 0 ? <p className="p-2 text-[12px] text-muted-foreground">Nothing matches.</p> : null}
					</div>
				</nav>
				{current && status ? (
					<section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card" style={{ containerType: "inline-size" }}>
						<header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
							{/* A narrow pane keeps the status and the place; the name is already picked in the list. */}
							<span className="font-mono text-[13px] font-medium [@container(max-width:560px)]:hidden">{current.name}</span>
							<span className={`inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] ${status.text}`}>
								<span className={`size-1.5 rounded-full ${status.dot}`} />
								{status.label}
							</span>
							{current.file ? (
								<button type="button" onClick={() => onOpenFile(current.file!, current.line)} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Open in Code">
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
													<button type="button" onClick={() => onOpenFile(t.file, t.line)} className="ml-auto font-mono text-muted-foreground hover:text-foreground">
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

/** Audit mode: what's been established for the contract picked here, as Lean coverage; on the Mac, also the SolidCore experiment. */
export function AuditView(props: { folder: string; scan: Scan | null; invoke: Bridge["invoke"]; onOpenFile: (path: string, line?: number) => void; reload?: number }) {
	const [view, setView] = useState<"coverage" | "semantics">("coverage");
	const views = isTauri() ? (["coverage", "semantics"] as const) : (["coverage"] as const);
	const switcher =
		views.length > 1 ? (
			<span role="tablist" aria-label="Proofs view" className="inline-flex h-6 items-center rounded-md border bg-muted/60 p-0.5">
				{views.map((v) => (
					<button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`h-5 rounded px-2 text-[11px] ${view === v ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
						{v === "coverage" ? "Coverage" : "Semantics"}
					</button>
				))}
			</span>
		) : null;
	return view === "semantics" ? (
		<>
			<div className="flex h-8 shrink-0 items-center gap-2 px-1.5">{switcher}</div>
			<SemanticsPanel invoke={props.invoke} />
		</>
	) : (
		<CoverageAuditView {...props} switcher={switcher} />
	);
}

function CoverageAuditView({ folder, scan, invoke, onOpenFile, reload = 0, switcher }: { folder: string; scan: Scan | null; invoke: Bridge["invoke"]; onOpenFile: (path: string, line?: number) => void; reload?: number; switcher?: React.ReactNode }) {
	// Files found to hold no deployable contract (libraries, interfaces, types): left out of the picker once seen.
	const [noModel, setNoModel] = useState<string[]>([]);
	const sources = (scan?.solidity ?? []).filter((f) => !f.endsWith(".t.sol") && !f.endsWith(".s.sol") && !noModel.includes(f));
	// Libraries, interfaces and types have no model of their own; their functions show under a contract that uses them.
	const support = (f: string) => /(^|\/)(libraries|interfaces|types|utils)\//.test(f) || /\/I[A-Z]\w*\.sol$/.test(f);
	const firstContract = sources.find((f) => f.startsWith("src/") && !support(f)) ?? sources.find((f) => !support(f)) ?? sources[0] ?? null;
	// Your entry points (Settings, or the last contract picked here) come first; the first of them opens by default.
	const [entries, setEntries] = useState(() => readEntryPoints(folder));
	const mains = entries.filter((f) => sources.includes(f));
	const others = sources.filter((f) => !mains.includes(f) && !support(f));
	// Not the file open in Code: the folder's own main entry point, else its first contract.
	const pick = mains[0] ?? firstContract;
	const [entry, setEntry] = useState<string | null>(pick);
	const [formal, setFormal] = useState<Formal | null>(null);
	const [scripts, setScripts] = useState<Scripts | null>(null);
	const [error, setError] = useState<string | null>(null);
	const errorSource = useRef("");
	errorSource.current = `Proofs · ${entry ?? ""}`;
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
		// A reload (the swarm proved something) keeps the table up while the coverage is read again.
		if (!reload) setFormal(null);
		setError(null);
		void invoke<Formal>("ast_formal", { folder, entry }).then(setFormal, (e) => {
			const msg = String(e);
			// No deployable contract in the file: move on to the next file that has one instead of failing.
			if (/no contract|no deployable|libraries, interfaces and types/i.test(msg)) {
				setNoModel((n) => (n.includes(entry) ? n : [...n, entry]));
				const next = sources.find((f) => f !== entry && !noModel.includes(f) && !support(f)) ?? null;
				if (next) return setEntry(next);
			}
			setError(msg);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder, entry, invoke, reload]);
	const ready = formal;
	return (
		<>
			<div className="flex h-8 shrink-0 items-center gap-2 px-1.5 text-[12px]">
				{switcher}
				<span className="pl-1 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lean coverage</span>
				<DropdownMenu>
					<DropdownMenuTrigger className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md border bg-background px-2 font-mono text-[11px] outline-none hover:bg-muted" title="The contract to read">
						<span className="truncate">{entry ?? "No Solidity sources"}</span>
						<ChevronDown className="size-3 shrink-0" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
						{/* Picking one makes it the folder's main entry point, so it opens here next time. */}
						<DropdownMenuRadioGroup
							value={entry ?? ""}
							onValueChange={(f) => {
								setEntry(f);
								setEntries(setMainEntryPoint(folder, f));
							}}
						>
							{mains.length ? <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Entry points</DropdownMenuLabel> : null}
							{mains.map((f, i) => (
								<DropdownMenuRadioItem key={f} value={f} className="font-mono text-[11px]">
									{f}
									{i === 0 ? <span className="ml-auto pl-3 font-sans text-[10px] text-muted-foreground">main</span> : null}
								</DropdownMenuRadioItem>
							))}
							{mains.length && others.length ? <DropdownMenuSeparator /> : null}
							{mains.length && others.length ? <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Other contracts</DropdownMenuLabel> : null}
							{others.map((f) => (
								<DropdownMenuRadioItem key={f} value={f} className="font-mono text-[11px]">{f}</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				{/* The contract and how many theorems it has (the summary row below keeps the coverage). */}
				{ready ? (
					<span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
						{ready.contract} · <span className="font-mono">{ready.theorems.length}</span> theorems
						{ready.theorems.some((t) => t.sorry) ? ` · ${ready.theorems.filter((t) => t.sorry).length} with sorry` : ""}
					</span>
				) : null}
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
/**
 * `defaultMode` is the tab without a ?mode; `onSwarm` sends the Swarm tab elsewhere (the website's imported repositories
 * keep their swarm on the project canvas).
 */
export function SwarmPanel({ folder, name, scan, bridge, session, file: openPath, actions, debug, defaultMode, onSwarm }: { folder: string; name: string; scan: Scan | null; bridge: Bridge; session?: string | null; file?: string | null; actions?: React.ReactNode; debug?: (file: string | null, test: string | null, onPick: (file: string) => void) => React.ReactNode; defaultMode?: Mode; onSwarm?: () => void }) {
	const { invoke, listen, apiBase } = bridge;
	// Every session running in this folder: each is its own swarm, and they keep working while you read another.
	const [runs, setRuns] = useState<string[]>([]);
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
	const [provider] = useState<Provider>(() => {
		const p = store.get("fm:provider");
		return p === "anthropic" || p === "openai" ? p : "formal";
	});
	// The models for how the agents are run: GPT on your OpenAI key, Claude otherwise.
	const models = provider === "openai" ? OPENAI_MODELS : MODELS;
	const pickedModel = models.some((m) => m.value === model) ? model : models[0].value;
	const ownKey = provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : null;
	const [hasKey, setHasKey] = useState(false);
	const [sessions, setSessions] = useState<Session[]>([]);
	const [proofs, setProofs] = useState<Record<string, Proof>>({});
	const [openItem, setOpenItem] = useState<number | null>(null);
	// `url`: a PDF, shown in the browser's own viewer instead of as text.
	const [file, setFile] = useState<{ path: string; text: string; url?: string } | null>(null);
	// The Proofs rail beside Solidity (and, on the Mac, the Lean editor for .lean files): on unless turned off.
	const [proofsOn, setProofsOn] = useState(() => store.get("fm:proofs") !== "0");
	const [proofFn, setProofFn] = useState<string | null>(null);
	const [planOpen, setPlanOpen] = useState(false);
	const [chatOpen, setChatOpen] = useState(() => store.get("fm:chat-open") !== "0");
	// How many agent messages you had seen when the chat was folded; the button counts the ones since.
	const [seen, setSeen] = useState(0);
	const toggleChat = (open: boolean) => {
		setChatOpen(open);
		store.set("fm:chat-open", open ? "1" : "0");
		setSeen(agentMessages);
	};
	// The chat's size, dragged from its left edge, top edge or top-left corner (it is anchored bottom-right). Width and
	// height in px; null height is the default (most of the canvas's height). Kept across launches.
	const [chatSize, setChatSize] = useState<{ w: number; h: number | null }>(() => {
		try {
			const v = JSON.parse(store.get("fm:chat-size") ?? "null");
			if (v && typeof v.w === "number") return { w: v.w, h: typeof v.h === "number" ? v.h : null };
		} catch {
			/* the default */
		}
		return { w: 416, h: null };
	});
	const chatBox = useRef<HTMLElement>(null);
	const startResize = (e: React.PointerEvent, edges: { x: boolean; y: boolean }) => {
		e.preventDefault();
		e.stopPropagation();
		const box = chatBox.current?.getBoundingClientRect();
		const bounds = chatBox.current?.parentElement?.getBoundingClientRect();
		if (!box || !bounds) return;
		const start = { x: e.clientX, y: e.clientY, w: box.width, h: box.height };
		// Room to grow: up to the canvas's left edge and the strip under the top bar, keeping the margins.
		const maxW = bounds.width - 24;
		const maxH = box.bottom - bounds.top - 56;
		let last = chatSize;
		const move = (ev: PointerEvent) => {
			last = {
				w: edges.x ? Math.round(Math.min(maxW, Math.max(320, start.w + start.x - ev.clientX))) : chatSize.w,
				h: edges.y ? Math.round(Math.min(maxH, Math.max(260, start.h + start.y - ev.clientY))) : chatSize.h,
			};
			setChatSize(last);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			store.set("fm:chat-size", JSON.stringify(last));
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const resetChatSize = () => {
		setChatSize({ w: 416, h: null });
		store.set("fm:chat-size", JSON.stringify({ w: 416, h: null }));
	};
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
	const asked = (params.get("mode") as Mode | null) ?? defaultMode ?? "swarm";
	// The roadmap lives on the Swarm canvas now and Chat has no tab; old links to either open Swarm.
	const mode = resolveMode(asked, Boolean(debug));
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
		if (m === "swarm" && onSwarm) return onSwarm();
		const next = new URLSearchParams(params);
		next.set("mode", m);
		setParams(next);
	};
	const loadFile = (path: string) => {
		if (/\.pdf$/i.test(path)) {
			void invoke<string>("folder_image", { folder, path }).then(
				(url) => setFile({ path, text: "", url }),
				(e) => setError(String(e)),
			);
			return;
		}
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
	// The open Solidity file's Lean coverage (gutter dots and the Proofs rail); the Lean editor keeps the last one, to
	// say which Solidity the theorem at its cursor is about.
	const solProofs = useFileProofs(folder, proofsOn && file && !file.url && file.path.endsWith(".sol") ? file.path : null, invoke);
	const [lastFormal, setLastFormal] = useState<Formal | null>(null);
	useEffect(() => {
		if (solProofs.data) setLastFormal(solProofs.data);
	}, [solProofs.data]);
	useEffect(() => setProofFn(null), [file?.path]);
	const pickedFn = solProofs.functions.find((f) => fnKey(f) === proofFn) ?? null;
	/** Picks a function in the rail (or by its gutter dot) and brings its code into view. */
	const pickProof = (f: FormalFn) => {
		setProofFn(fnKey(f));
		codeBox.current?.querySelector(`[data-line="${f.line - 1}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
	};
	const leanEditor = isTauri() && proofsOn && !!file && file.path.endsWith(".lean");
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
	// The session you're reading, if it's running (Stop, messages and the budget act on it).
	const run = viewing && runs.includes(viewing) ? viewing : null;
	// Grouped once per change of the events (a long session has about a thousand): typing in the composer re-renders the
	// panel, and must not regroup the history, rebuild the board or redraw every message.
	const chatBlocks = useMemo(() => blocks(events.filter((e) => e.kind !== "status" && e.kind !== "context")), [events]);
	const scrubItems = useMemo(
		() =>
			chatBlocks.map((b) =>
				"steps" in b
					? { label: `${b.steps.length} tool step${b.steps.length === 1 ? "" : "s"}`, text: b.steps.map((st) => st.call.text).join(" · ") }
					: { label: b.e.kind === "you" ? "You" : `${b.e.role[0]?.toUpperCase() ?? ""}${b.e.role.slice(1)}${b.e.item ? ` · item ${b.e.item}` : ""}`, text: b.e.text },
			),
		[chatBlocks],
	);
	const viewingRef = useRef<string | null>(null);
	viewingRef.current = viewing;
	const chat = useRef<HTMLDivElement>(null);

	/**
	 * A session's events to keep on screen: the whole conversation (messages, plans, findings, starts and ends), but only
	 * the latest 600 of the bookkeeping around it (tool calls, results, status and context), which is most of a long log.
	 */
	const trim = (evs: Ev[]) => {
		const noise = (e: Ev) => ["tool", "result", "status", "context"].includes(e.kind);
		let keep = 600;
		const out: Ev[] = [];
		for (let i = evs.length - 1; i >= 0; i--) if (!noise(evs[i]) || keep-- > 0) out.push(evs[i]);
		return out.reverse();
	};
	/** Shows a session's saved events (.formal/runs/<run>.jsonl), so quitting the app loses nothing. */
	const load = (id: string) => {
		setViewing(id);
		void invoke<Ev[]>("swarm_history", { folder, run: id }).then((evs) => setEvents(trim(evs)), () => setEvents([]));
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

	// Ticks when the swarm proves an item or files a finding, so Audit's coverage, Bugs and the file tree read again.
	const [reload, setReload] = useState(0);
	const refresh = () => {
		void invoke<Item[]>("swarm_plan", { folder }).then(setPlan, () => {});
		void invoke<Bug[]>("swarm_bugs", { folder }).then(setBugs, () => {});
		void invoke<Record<string, Proof>>("swarm_proofs", { folder }).then(setProofs, () => {});
	};

	useEffect(() => {
		refresh();
		void invoke<boolean>(provider === "openai" ? "openai_key_status" : "anthropic_key_status").then(setHasKey);
		void invoke<string[]>("swarm_running", { folder }).then(async (r) => {
			setRuns(r);
			const list = await listSessions();
			// Reopen where you left off: the session picked, else a running one, else the latest.
			const id = (session === "new" ? undefined : session) ?? r[0] ?? list[0]?.run;
			if (id) load(id);
		});
		const off = listen<Ev>("swarm", ({ payload }) => {
			// Other folders' sessions send events too.
			if (payload.folder && payload.folder !== folder) return;
			if (payload.kind === "start") setRuns((r) => (r.includes(payload.run) ? r : [...r, payload.run]));
			// The chat shows the session you're reading; the others carry on in the background.
			if (payload.run === viewingRef.current) setEvents((all) => trim([...all, payload]));
			if (["plan", "bug", "done"].includes(payload.kind) || (payload.kind === "status" && / is working$/.test(payload.text))) refresh();
			// A finding recorded from a report shows in Bugs straight away.
			if (payload.kind === "tool" && payload.text.startsWith("record_finding")) setReload((n) => n + 1);
			if (["plan", "bug", "done"].includes(payload.kind)) {
				setReload((n) => n + 1);
				void invoke<{ files: string[] }>("folder_tree", { path: folder }).then((t) => setTree(t.files), () => {});
			}
			if (payload.kind === "done") {
				setRuns((r) => r.filter((x) => x !== payload.run));
				void listSessions();
			}
		});
		return () => void off.then((f) => f());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder]);
	// A session picked in the sidebar; "new" is an empty one that gets its own queue when started.
	useEffect(() => {
		if (session === "new") {
			setViewing(null);
			setEvents([]);
			return;
		}
		if (session && session !== viewing) load(session);
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
	// New messages scroll the chat down only while you're at the bottom (or just sent one): scrolled up to read, it
	// stays where you are.
	const atBottom = useRef(true);
	// Scrolled up: a button back to the end shows over the composer (Mike's).
	const [away, setAway] = useState(false);
	useEffect(() => {
		const last = events.at(-1);
		if (!atBottom.current && last?.kind !== "you") return;
		// Braces matter: scrollTo returns a Promise in newer browsers, and an effect must return nothing or a cleanup.
		chat.current?.scrollTo({ top: chat.current.scrollHeight });
	}, [events]);

	// `onlyQueued`: a run for the work already queued (reading a report), which stops when that's done.
	const start = async (onlyQueued = false) => {
		setError(null);
		// A new session starts empty; Resume carries on below the chat you're reading.
		const fresh = session === "new" && !viewing;
		if (fresh) setEvents([]);
		try {
			const id = await invoke<string>("swarm_start", { request: { folder, goal: goal.trim() || null, budget_usd: budget, api_base: apiBase(), provider, model: pickedModel, session: fresh ? `s-${Date.now().toString(16)}` : viewing ?? "swarm", only_queued: onlyQueued } });
			setRuns((r) => (r.includes(id) ? r : [...r, id]));
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
		// The app sends it back as a `you` event (desktop/src-tauri/src/swarm.rs), logged with the session.
		await invoke("swarm_say", { folder, run, text }).catch((e) => setError(String(e)));
	};

	const spent = events.at(-1)?.spent ?? 0;
	const sessionTitle = (id: string | null) => {
		const i = sessions.findIndex((x) => x.run === id);
		if (i < 0) return run ? goal.trim() || "New session" : "New session";
		return sessions[i].title || (sessions[i].run === "swarm" ? "Main session" : `Session ${sessions.length - i}`);
	};
	const title = sessionTitle(viewing);
	const working = run ? [...events].reverse().find((e) => e.kind === "status" && e.role !== "swarm") : undefined;
	// What the working agent did last (a tool call, or the step it's thinking on), shown under its plan item.
	const activity = working ? [...events].reverse().find((e) => (e.kind === "tool" || e.kind === "status") && e.role === working.role) : undefined;
	const done = plan.filter((i) => i.mark === "x").length;
	// Entry points a plan item names, matched as whole words in its text.
	// constructor, receive and fallback have no name of their own in the AST.
	const label = (u: AstUnit) => u.function || (u.name.split(".").pop() ?? u.name);
	const named = (text: string) => entryUnits.filter((u) => u.function && new RegExp(`\\b${u.function}\\b`).test(text));
	const inPlan = new Set(plan.flatMap((i) => named(i.text).map((u) => u.name)));
	const finished = !run ? events.find((e) => e.kind === "done") : undefined;
	const shown = chatBlocks;
	const board = useMemo(() => localBoard(folder, plan, events, Boolean(run), budget), [folder, plan, events, run, budget]);
	const chatList = useMemo(
		() =>
			chatBlocks.map((block, i) => (
				<div key={i} data-msg={i} className="fm-settle">
					{"steps" in block ? (
						<Steps steps={block.steps} running={Boolean(run) && i === chatBlocks.length - 1} />
					) : block.e.kind === "you" ? (
						<Message align="end">
							<MessageContent>
								<div className="ml-10 w-fit whitespace-pre-wrap rounded-2xl bg-muted px-3 py-2.5 text-foreground">{block.e.text}</div>
							</MessageContent>
						</Message>
					) : (
						<AgentMessage
							e={block.e}
							onBug={() => {
								// Open the bugs card on this report.
								const hit = bugs.find((b) => block.e.text.includes(b.file));
								setMode("bugs");
								if (hit) setOpenBug(hit.file);
							}}
						/>
					)}
				</div>
			)),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chatBlocks, run, bugs],
	);
	// How full the working agent's context window is and what fills it, from its last reply; past 75% its older steps
	// are summarized.
	const contextEv = working ? [...events].reverse().find((e) => e.kind === "context" && e.role === working.role) : undefined;
	// The canvas's Context notebook: the working agent's, else the last agent's that replied (live from the event
	// stream: every model call and every compaction sends one).
	const lastContextEv = contextEv ?? [...events].reverse().find((e) => e.kind === "context");
	const lastCtx = lastContextEv ? parseContext(lastContextEv.text) : null;
	const ctx = contextEv ? parseContext(contextEv.text) : null;
	const ctxPct = ctx ? Math.min(100, Math.round((ctx.used / ctx.window) * 100)) : null;
	const agentMessages = useMemo(() => events.filter((e) => !["status", "context", "you", "tool"].includes(e.kind)).length, [events]);
	const unread = chatOpen ? 0 : Math.max(0, agentMessages - seen);

	// The plan as a list with each item's proof, on the Swarm canvas.
	const planList = (
						<ul className="space-y-0.5 p-1.5 text-[12px] leading-[18px]">
							{plan.length === 0 ? <li className="p-2 text-muted-foreground">The planner writes .formal/plan.md on the first run.</li> : null}
							{plan.map((i) => {
								const proof = proofs[String(i.index)];
								const expanded = openItem === i.index;
								return (
									<li key={i.index} className={`rounded-md ${working && working.item === String(i.index) ? "bg-muted" : ""}`}>
										<button type="button" disabled={!proof} onClick={() => setOpenItem(expanded ? null : i.index)} className="flex w-full gap-2 px-2 py-1 text-left enabled:hover:bg-muted/60 rounded-md">
											<span className={`mt-px grid size-3.5 shrink-0 place-items-center rounded border ${i.mark === "x" ? "border-emerald-500 bg-emerald-500 text-white" : i.mark === "!" ? "border-amber-500 text-amber-600" : ""}`}>
												{/* Drawn marks, so they sit centred at any zoom (text glyphs ride their baseline). */}
												{i.mark === "x" ? <Check className="size-2.5" strokeWidth={3.5} /> : i.mark === "!" ? (
													<svg viewBox="0 0 10 10" className="size-2.5" aria-hidden><path d="M5 2v3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="5" cy="7.9" r="1" fill="currentColor" /></svg>
												) : null}
											</span>
											<span className="min-w-0 flex-1">
												<span className={i.mark === "x" ? "text-muted-foreground" : ""}>{i.text}</span>
												{working && working.item === String(i.index) && activity ? (
													<span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground" title={activity.text}>
														<span className="truncate">
															<span className="font-medium" style={{ color: colorOf(working.role) }}>{working.role}</span> · {activity.text}
														</span>
													</span>
												) : null}
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
	// The conversation with the swarm: its sessions, budget and Stop on a gray bar, the messages and composer under it.
	const chatPanel = (
		<>
				<div className="flex h-8 shrink-0 items-center gap-2 pl-2 pr-0.5">
					<DropdownMenu>
						<DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left text-[12px] text-muted-foreground outline-none hover:text-foreground" title={`${title} — switch sessions`}>
							<span className="truncate">{title}</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-64">
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sessions in {name}</DropdownMenuLabel>
							{/* The session you're reading stays highlighted, with a check on the right. */}
							{sessions.map((x, i) => (
								<DropdownMenuItem key={x.run} onSelect={() => pickSession(x.run)} aria-current={x.run === viewing} className={`text-[13px] ${x.run === viewing ? "bg-accent text-accent-foreground" : ""}`}>
									<span className="truncate">{x.title || (x.run === "swarm" ? "Main session" : `Session ${sessions.length - i}`)}</span>
									{runs.includes(x.run) ? <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">running</span> : null}
									{x.run === viewing ? <Check className={`size-3.5 shrink-0 ${runs.includes(x.run) ? "" : "ml-auto"}`} /> : null}
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => pickSession("new")} className="text-[13px]">
								<Plus className="size-3.5" /> New session
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{working && ctx && ctxPct !== null ? (
						<DropdownMenu>
							<DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] tabular-nums text-muted-foreground outline-none hover:bg-background hover:text-foreground" title={`The ${working.role}'s context window`}>
								<span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
									<span className="block h-full rounded-full" style={{ width: `${ctxPct}%`, backgroundColor: colorOf(working.role) }} />
								</span>
								{ctxPct}%
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-auto rounded-2xl border-0 bg-transparent p-0 shadow-lg">
								<ContextPanel role={working.role} color={colorOf(working.role)} use={ctx} onCompact={run ? () => invoke("swarm_compact", { folder, run }) : undefined} />
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
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
									if (run) void invoke("swarm_set_budget", { folder, run, usd: Number(v) });
								}}
							>
								{BUDGETS.map((b) => (
									<DropdownMenuRadioItem key={b} value={String(b)} disabled={Boolean(run) && b <= spent}>${b}</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<button type="button" onClick={() => toggleChat(false)} title="Hide the chat" aria-label="Hide the chat" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
						<ChevronDown className="size-3.5" />
					</button>
				</div>
				<div className="mt-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
				{/* The scrubber: a tick per message along the left edge, to preview and jump through the chat. */}
				<div className="relative flex min-h-0 flex-1 flex-col">
				<ChatScrubber
					scroller={chat}
					items={scrubItems}
				/>
				<div
					ref={chat}
					onScroll={(e) => {
						const el = e.currentTarget;
						atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
						setAway(!atBottom.current);
					}}
					className="min-h-0 flex-1 space-y-3.5 overflow-y-auto py-3 pl-6 pr-3 text-[13px]"
				>
					{shown.length === 0 && !run ? <p className="text-muted-foreground">Talk to the agents here. Before a run, what you write is the swarm's focus and ↑ starts it; while it runs, they read your messages before their next turn.</p> : null}
					{chatList}
					{/* While an agent works, Mike's loader until its next words. */}
					{run && working ? (
						<p className="flex items-center gap-2 text-[12px] text-muted-foreground">
							<span className="fm-dots inline-flex gap-1">
								<i />
								<i />
								<i />
							</span>
							<span className="font-medium" style={{ color: colorOf(working.role) }}>{working.role}</span>
							<span className="truncate">{working.text}</span>
						</p>
					) : null}
					{finished ? <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">Finished: {finished.text}</p> : null}
				</div>
				<button
					type="button"
					onClick={() => {
						atBottom.current = true;
						setAway(false);
						chat.current?.scrollTo({ top: chat.current.scrollHeight, behavior: "smooth" });
					}}
					aria-label="Scroll to the end"
					className={`absolute bottom-2 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border bg-background shadow-md transition-all duration-200 ${away ? "scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0"}`}
				>
					<ArrowDown className="size-3.5" strokeWidth={2.6} />
				</button>
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
							value: pickedModel,
							options: models,
							disabled: Boolean(run),
							onChange: (m) => {
								setModel(m);
								store.set("fm:model", m);
							},
						}}
						placeholder={run ? "Talk to the agents: a question, a new focus, an idea to check…" : "What should the swarm focus on? (optional) ↑ starts it"}
						// The composer's top left: the run control (Stop while it runs; Start, or Resume with plan items left,
						// when it doesn't), then the project this chat talks to.
						context={
							<span className="inline-flex items-center gap-1.5">
								{run ? (
									<button type="button" onClick={() => void invoke("swarm_stop", { folder, run })} title="Stop the swarm" className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400">
										<Square className="size-2.5 fill-current" />Stop
									</button>
								) : (
									<button type="button" onClick={() => void start()} disabled={Boolean(ownKey) && !hasKey} title={ownKey && !hasKey ? `Add your ${ownKey} key in Settings first` : "Start the swarm"} className="btn-dark inline-flex h-8 items-center gap-1.5 px-3 text-[13px] disabled:opacity-50">
										<Play className="size-3" />{plan.some((i) => i.mark === " ") ? "Resume" : "Start"}
									</button>
								)}
								<span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-medium text-secondary-foreground">{name}</span>
							</span>
						}
						extra={run ? (
							<button type="button" onClick={() => void draft()} disabled={drafting} title="Draft a reply for me" className="inline-flex h-8 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full px-2.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
								<WandSparkles className={`size-3.5 ${drafting ? "animate-pulse" : ""}`} />
								{drafting ? "Drafting…" : "Draft reply"}
							</button>
						) : null}
					/>
				</div>
				</div>
		</>
	);

	return (
		// In the Mac app the controls live in the title bar, so the page starts at the top.
		<div ref={root} className="relative flex h-full min-h-0 flex-1" style={{ "--fm-top": slot ? "0px" : "3.5rem" } as React.CSSProperties}>
			{/* The canvas, as on the Swarm page, with the plan, files and bugs floating over it as one accordion. */}
			<div className="absolute inset-0 flex flex-col overflow-hidden">
				{/* Swarm mode shows the canvas; Code and Audit replace it. The name and the controls stay in every mode. */}
				{mode === "swarm" ? (
					<SwarmCanvas
						state={board}
						fill
						local
						repo={folder}
						actions={actions}
						// An agent's name tag opens the chat addressed to it.
						onTalk={(role) => {
							toggleChat(true);
							const to = (v: string) => (v.startsWith("@") ? v.replace(/^@\S+\s*/, `@${role} `) : `@${role} ${v}`);
							if (run) setSay(to);
							else setGoal(to);
						}}
						side={{
							title: "Context notebook",
							node: lastCtx && lastContextEv ? (
								<ContextBody
									role={lastContextEv.role}
									color={colorOf(lastContextEv.role)}
									use={lastCtx}
									onCompact={run && contextEv ? () => invoke("swarm_compact", { folder, run }) : undefined}
								/>
							) : (
								<p className="text-[13px] text-muted-foreground">Each agent's context window shows here once it replies: what fills it, and how far it is from compacting.</p>
							),
						}}
						// The roadmap is the folder's own plan (.formal/plan.md, one item per AST function), nothing from GitHub.
						below={{
							title: "Roadmap",
							height: 640,
							node: <div className="min-h-0 flex-1 overflow-y-auto">{planList}{entryList}</div>,
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
											onClick={() => {
												setVimMode(!vim);
												// Vim edits Lean in Neovim, so the Lean editor steps aside.
												if (!vim && leanEditor) setProofsOn(false);
											}}
											aria-pressed={vim}
											title={vim ? (slot ? "Vim mode is on: Neovim runs here. Turn it off" : "Vim keys are on. Turn them off") : slot ? "Open in Neovim (Vim mode)" : "Vim keys"}
											className={`inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[11px] font-medium ${vim ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
										>
											vim
										</button>
										{!file.url && (file.path.endsWith(".sol") || (isTauri() && file.path.endsWith(".lean"))) ? (
											<button
												type="button"
												onClick={() => {
													store.set("fm:proofs", proofsOn ? "0" : "1");
													setProofsOn(!proofsOn);
												}}
												aria-pressed={proofsOn}
												title={file.path.endsWith(".lean") ? (proofsOn ? "Lean editor with live goals is on. Show the plain file" : "Edit with Lean: live goals and messages") : proofsOn ? "Hide the Proofs rail" : "Show which functions are proved"}
												className={`inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium ${proofsOn ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
											>
												<ScanSearch className="size-3" />
												Proofs
											</button>
										) : null}
										<CopyButton text={file.text} label="Copy the file" />
									</span>
								</div>
								{leanEditor ? <ProofWorkspace key={`${folder}:${file.path}:${markLine ?? ""}`} folder={folder} path={file.path} invoke={invoke} initialLine={markLine ?? 1} onOpenFile={view} formal={lastFormal} /> : <div className="flex min-h-0 flex-1">
								<div
									className={`min-w-0 min-h-0 flex-1 overflow-auto ${navigable(file.path) ? "[&_[data-code]]:cursor-text" : ""}`}
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
									{file.url ? (
										<iframe src={file.url} title={file.path} className="h-full w-full border-0" />
									) : vim && slot ? (
										// The Mac app runs real Neovim (bundled); the web keeps the light cursor below.
										<NvimTerminal bridge={bridge} folder={folder} path={file.path} line={markLine} />
									) : jsonOk && !jsonRaw ? (
										<JsonTree text={file.text} />
									) : /\.(md|markdown)$/i.test(file.path) && !mdSource ? (
										<ChatMarkdown className="mx-auto max-w-3xl px-6 py-6 text-[14px]" image={(src) => { const p = imagePath(src, file.path); return p === null ? src : images[p]; }}>{file.text}</ChatMarkdown>
									) : (
										<FileView
											path={file.path}
											text={file.text}
											big
											mark={markLine ? markLine - 1 : null}
											cursor={vim ? cursor : null}
											gutter={solProofs.data ? proofGutter(solProofs.data, solProofs.functions, pickProof) : undefined}
											band={pickedFn ? { from: pickedFn.line - 1, to: pickedFn.endLine - 1 } : null}
										/>
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
								{proofsOn && !file.url && file.path.endsWith(".sol") ? <ProofRail key={file.path} proofs={solProofs} selected={proofFn} onSelect={pickProof} onOpenFile={view} /> : null}
								</div>}
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
				{mode === "bugs" ? (
					<BugsView
						folder={folder}
						files={tree}
						invoke={invoke}
						apiBase={apiBase}
						bugs={bugs}
						openBug={openBug}
						setOpenBug={setOpenBug}
						withPoc={withPoc}
						onOpenFile={view}
						reload={reload}
						onFilesChanged={() => void invoke<{ files: string[] }>("folder_tree", { path: folder }).then((t) => setTree(t.files), () => {})}
						// Queued for the swarm's auditor; a stopped swarm starts just for it (and stops after).
						onTriage={async (path) => {
							await invoke("swarm_triage", { folder, path, session: viewing && viewing !== "new" ? viewing : "swarm" });
							if (!run) await start(true);
						}}
					/>
				) : null}
				{mode === "audit" ? (
					<div className="pointer-events-auto absolute bottom-3 left-3 right-3 top-[var(--fm-top)] z-10 flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-muted/60 p-1">
						<AuditView folder={folder} scan={scan} invoke={invoke} onOpenFile={view} reload={reload} />
					</div>
				) : null}
			</div>

			{/* The chat: start and steer the swarm, the plan, and the agents' messages. */}
			{/* The chat floats over the canvas on the right: a gray title bar with the run's controls, the white chat inside.
			    The strip above it stays free for the Live pill and the bell. */}
			{/* Talk to the agents: floats on the right of the Swarm canvas, the Plan's counterpart on the left. */}
			{mode === "swarm" ? (
				<>
					{/* One box: the chat when open, the round button at its corner when closed. It switches at once, no animation. */}
					<aside
						ref={chatBox}
						className={`pointer-events-auto absolute bottom-3 right-3 z-20 overflow-hidden border shadow-pop backdrop-blur ${chatOpen ? "rounded-2xl bg-muted/80" : "cursor-pointer rounded-[24px] border-transparent bg-foreground hover:opacity-90"}`}
						style={{
							width: chatOpen ? `min(${chatSize.w}px, calc(100% - 1.5rem))` : 48,
							height: chatOpen ? (chatSize.h ? `min(${chatSize.h}px, calc(100% - max(var(--fm-top), 2.75rem) - 1rem))` : "calc(100% - max(var(--fm-top), 2.75rem) - 4rem)") : 48,
						}}
						onClick={chatOpen ? undefined : () => toggleChat(true)}
					>
						<div
							className={`absolute bottom-1 right-1 flex flex-col ${chatOpen ? "" : "pointer-events-none opacity-0"}`}
							style={{
								width: `calc(min(${chatSize.w}px, 100vw - 1.5rem) - 0.5rem - 2px)`,
								height: chatSize.h ? `calc(${chatSize.h}px - 0.5rem - 2px)` : "calc(100vh - max(var(--fm-top), 2.75rem) - 4.5rem - 2px)",
								maxHeight: "calc(100% - 0.5rem)",
							}}
							aria-hidden={!chatOpen}
						>
							{chatPanel}
						</div>
						{/* Drag to resize: the left edge (width), the top edge (height), the top-left corner (both).
						    Double-click one to go back to the default size. */}
						{chatOpen ? (
							<>
								<div onPointerDown={(e) => startResize(e, { x: true, y: false })} onDoubleClick={resetChatSize} title="Drag to resize" className="absolute bottom-3 left-0 top-3 z-10 w-1.5 cursor-ew-resize" />
								<div onPointerDown={(e) => startResize(e, { x: false, y: true })} onDoubleClick={resetChatSize} title="Drag to resize" className="absolute left-3 right-3 top-0 z-10 h-1.5 cursor-ns-resize" />
								<div onPointerDown={(e) => startResize(e, { x: true, y: true })} onDoubleClick={resetChatSize} title="Drag to resize" className="absolute left-0 top-0 z-10 size-3 cursor-nwse-resize" />
							</>
						) : null}
						<button
							type="button"
							tabIndex={chatOpen ? -1 : 0}
							onClick={() => toggleChat(true)}
							title={unread ? `Talk to the swarm · ${unread} new` : "Talk to the swarm"}
							aria-label="Talk to the swarm"
							className={`absolute bottom-0 right-0 grid size-12 place-items-center text-background ${chatOpen ? "pointer-events-none opacity-0" : ""}`}
						>
							<TalkIcon className="size-5" />
						</button>
					</aside>
					{/* New agent messages since you folded the chat, counted like the bell's (outside the shape, so it isn't clipped). */}
					{!chatOpen && unread ? <span className="pointer-events-none absolute bottom-[3.25rem] right-3 z-30 grid h-5 min-w-5 translate-x-1 place-items-center rounded-full border-2 border-background bg-red-500 px-1 text-[10px] font-semibold tabular-nums text-white">{unread > 99 ? "99+" : unread}</span> : null}
				</>
			) : null}
		</div>
	);
}
