import { MarkGithubIcon } from "@primer/octicons-react";
import { isTauri } from "@tauri-apps/api/core";
import { ProofWorkspace } from "./proof-workspace";
import { ProofRail, fnKey, proofGutter, useFileProofs } from "./code-proof-panel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NvimTerminal } from "./nvim-terminal";
import { reportError } from "@/lib/report-error";
import { JsonTree } from "./json-tree";
import { ArrowDown, Bug, Check, Pencil, ChevronDown, ChevronRight, CircleCheck, CircleX, LoaderCircle, MoreHorizontal, Pause, Code2, Copy, FileCode2, Folder, Network, Plus, ScanSearch, ThumbsDown, ThumbsUp, WandSparkles, ArrowLeft, ArrowRight, History } from "lucide-react";

// The project roadmap (GitHub Projects-style), the same view the web app had on its own page.
import { motion as vimMotion, search as vimSearch, setVimMode, useVimMode, type Cursor } from "@/components/vim-mode";
import { useNavigate, useSearchParams } from "react-router";
import { ChatComposer } from "@/components/chat-composer";
import { useReportDirs } from "@/lib/report-dirs";
import { auditJsonPath, parseAuditDoc, type AuditDoc, type AuditFindingDoc } from "@/lib/audit-format";
import { readEntryPoints, setMainEntryPoint } from "@/lib/entry-points";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChatMarkdown } from "@/components/chat-markdown";
import { GitTree } from "./git-tree";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { ROLE_COLORS, roleName } from "@/lib/swarm-roles";
// AffectUI's run card from the private UI package when it is checked out; `null` otherwise (desktop/src/ui-fallback).
import { RunCard, type Steer } from "@formalmind/ui/run-card";
import { PANE_VIEWS, TalkIcon } from "./pane-views";
import { Composer } from "@formalmind/ui/composer";
import { ContextCard } from "@formalmind/ui/context";
import { ReplyActions as AuiReplyActions } from "@formalmind/ui/reply-actions";
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

export type Ev = { folder?: string; run: string; kind: "start" | "status" | "context" | "say" | "ask" | "tool" | "result" | "you" | "bug" | "plan" | "done" | "error"; role: string; item: string; text: string; spent: number; /** ms since the epoch (newer logs) */ at?: number };
/** One function's entry in the proof ledger (`ledger` op). */
type LedgerEntry = { lean: string; status: "proved" | "partly proved" | "pending" | "unproved" | "not_modeled"; covers?: string[]; notYet: string[] };
type Item = { index: number; mark: string; text: string };
/** A claim in .formal/statements.md (desktop/src-tauri/src/statements.rs), for the swarm to prove or disprove. */
type Statement = { id: string; mark: string; author: string; text: string; details: string[]; obligations: { mark: string; text: string }[] };
export type Bug = { file: string; title: string; body: string };
type Provider = "formal" | "anthropic" | "openai" | "claude-code" | "codex";
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

type Session = { run: string; title: string; outcome: string; spent: number; events: number; at: number };

const BUDGETS = [2, 5, 10, 20, 50, 100];
/** Claude models the local swarm can run on; the choice applies when the swarm starts. */
const MODELS = [
	{ value: "claude-opus-5-5", label: "Claude Opus 5.5" },
	{ value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
	{ value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
];
/** With your OpenAI key (Settings → Models), these instead. */
/** Claude Code's thinking effort for the agents (`--effort`); "" leaves it to Claude Code. */
const EFFORTS = [
	{ value: "", label: "Default" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];
const OPENAI_MODELS = [
	{ value: "gpt-5", label: "GPT-5" },
	{ value: "gpt-5-mini", label: "GPT-5 mini" },
];
/** On Codex with your ChatGPT plan (Settings → Models), these. */
const CODEX_MODELS = [
	{ value: "gpt-6-astra", label: "GPT-6 Astra" },
	{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
	{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
	{ value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];
const colorOf = (role: string) => (ROLE_COLORS as Record<string, string>)[role] ?? "hsl(var(--muted-foreground))";

const MARK_LABEL: Record<string, string> = { " ": "open", "~": "working", x: "proved", "!": "disproved or blocked", "?": "waiting for you", "-": "can't be proved against the model" };

/** A statement's mark, drawn like the plan's: proved, disproved, working, waiting for you, out of the model, open. */
function StatementMark({ mark, small }: { mark: string; small?: boolean }) {
	const box = small ? "mt-[3px] size-2.5" : "mt-px size-3.5";
	const glyph = small ? "size-2" : "size-2.5";
	const tone = mark === "x" ? "border-emerald-500 bg-emerald-500 text-white" : mark === "!" ? "border-amber-500 text-amber-600" : mark === "?" ? "border-violet-500 text-violet-600" : mark === "~" ? "border-sky-500 text-sky-500" : mark === "-" ? "border-muted-foreground/50 text-muted-foreground" : "";
	return (
		<span className={`grid shrink-0 place-items-center rounded border ${box} ${tone}`} title={MARK_LABEL[mark] ?? "open"}>
			{mark === "x" ? <Check className={glyph} strokeWidth={3.5} /> : mark === "!" ? (
				<svg viewBox="0 0 10 10" className={glyph} aria-hidden><path d="M5 2v3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="5" cy="7.9" r="1" fill="currentColor" /></svg>
			) : mark === "?" ? (
				<svg viewBox="0 0 10 10" className={glyph} aria-hidden><path d="M3.4 3.6a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" /><circle cx="5" cy="8.2" r=".9" fill="currentColor" /></svg>
			) : mark === "~" ? (
				<svg viewBox="0 0 10 10" className={`${glyph} animate-pulse`} aria-hidden><circle cx="5" cy="5" r="2.2" fill="currentColor" /></svg>
			) : mark === "-" ? (
				<svg viewBox="0 0 10 10" className={glyph} aria-hidden><path d="M2.5 5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
			) : null}
		</span>
	);
}
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };


/** A row of an activity group: the agent's note on what it's about to do, or a tool call with its result. */
export type Row = { note: Ev } | { call: Ev; result?: Ev };
type Block = { e: Ev } | { steps: Row[] };

/**
 * The chat as blocks. Messages stand alone, except an agent's note right before a tool call: it joins the call's
 * activity group, so the group reads as what it did and why ("Coverage first…", Ran coverage, "Two guards…", Ran …).
 */
export function blocks(events: Ev[]): Block[] {
	const out: Block[] = [];
	for (const e of events) {
		const last = out.at(-1);
		if (e.kind === "tool") {
			let group = last && "steps" in last ? last : null;
			if (!group && last && "e" in last && last.e.kind === "say" && last.e.role === e.role) {
				out.pop();
				const prev = out.at(-1);
				group = prev && "steps" in prev ? prev : null;
				if (group) group.steps.push({ note: last.e });
				else {
					group = { steps: [{ note: last.e }] };
					out.push(group);
				}
			}
			if (!group) {
				group = { steps: [] };
				out.push(group);
			}
			group.steps.push({ call: e });
		} else if (e.kind === "result") {
			const row = last && "steps" in last ? [...last.steps].reverse().find((r): r is { call: Ev; result?: Ev } => "call" in r) : undefined;
			if (row && !row.result) row.result = e;
		} else if (e.text.trim()) out.push({ e });
		// A line with nothing to say (a start without a focus) isn't shown.
	}
	return out;
}

/** A scrolling list whose top and bottom edges fade out only while there is more past them. */
function FadeScroll({ className, children }: { className?: string; children: React.ReactNode }) {
	const box = useRef<HTMLDivElement>(null);
	const [more, setMore] = useState({ up: false, down: false });
	const measure = () => {
		const el = box.current;
		if (!el) return;
		const up = el.scrollTop > 1;
		const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
		setMore((m) => (m.up === up && m.down === down ? m : { up, down }));
	};
	useLayoutEffect(measure);
	const edge = (on: boolean) => (on ? "transparent" : "black");
	const mask = `linear-gradient(to bottom, ${edge(more.up)}, black 2rem, black calc(100% - 2rem), ${edge(more.down)})`;
	return (
		<div ref={box} onScroll={measure} className={`overflow-y-auto ${className ?? ""}`} style={{ maskImage: mask, WebkitMaskImage: mask }}>
			{children}
		</div>
	);
}

/** 12s, 1m 05s. */
const took = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** How run cards show (the ⋯ menu): file paths shown, finished runs folded, notes under each step. Kept per viewer. */
type CardView = { fold: boolean; paths: boolean; compact: boolean };
const CARD_VIEW = "fm:run-card-view";
function useCardView() {
	const [view, setView] = useState<CardView>(() => {
		try {
			return { fold: false, paths: true, compact: false, ...JSON.parse(localStorage.getItem(CARD_VIEW) ?? "{}") };
		} catch {
			return { fold: false, paths: true, compact: false };
		}
	});
	const set = (p: Partial<CardView>) =>
		setView((v) => {
			const next = { ...v, ...p };
			try {
				localStorage.setItem(CARD_VIEW, JSON.stringify(next));
			} catch {
				/* not kept */
			}
			return next;
		});
	return [view, set] as const;
}

/** A step that failed: a command's non-zero exit or a tool's error. */
const failed = (r?: Ev) => Boolean(r && /^(exit [1-9]|error:)/m.test(r.text));

/**
 * One agent run as a card: who and on what, its status, each step (what it did, on which file, how long; the agent's
 * note under the step it led to), and how far along it is. A step opens to its command and output (a write to its diff).
 */
export function Steps({ steps, running, title, onPause }: { steps: Row[]; running: boolean; /** What the run works on (a plan item's text). */ title?: string; onPause?: () => void }) {
	const [view, setView] = useCardView();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [running]);
	// Notes join the call they lead to; notes after the last call stay on their own.
	const items: { call: Ev; result?: Ev; notes: Ev[] }[] = [];
	let notes: Ev[] = [];
	for (const r of steps) {
		if ("note" in r) notes.push(r.note);
		else {
			items.push({ ...r, notes });
			notes = [];
		}
	}
	const trailing = notes;
	const first = items[0]?.call ?? trailing[0];
	const role = first?.role ?? "agent";
	const item = first?.item ?? "";
	const startAt = items[0]?.call.at;
	const endAt = items.at(-1)?.result?.at ?? (running ? now : undefined);
	const elapsed = startAt && endAt ? took(endAt - startAt) : null;
	const changed = items.filter((c) => c.call.text.startsWith("write_file")).length;
	const broke = items.filter((c) => failed(c.result)).length;
	const status = running
		? { label: "Working", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-300" }
		: items.some((c) => !c.result)
			? { label: "Stopped", cls: "bg-muted text-muted-foreground" }
			: { label: "Done", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
	const folded = view.fold && !running;
	const summary = () => [`${role}${item ? ` · item ${item}` : ""}${title ? ` · ${title}` : ""}`, ...items.map((c) => `${failed(c.result) ? "✗" : "✓"} ${c.call.text}`), ...trailing.map((n) => n.text)].join("\n");
	return (
		<div className="overflow-hidden rounded-xl border bg-card text-[13px]">
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<span className="shrink-0 font-medium capitalize" style={{ color: colorOf(role) }}>{role}</span>
				{title || item ? <span className="min-w-0 truncate text-foreground">{title ?? `item ${item}`}</span> : null}
				<span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${status.cls}`}>{status.label}</span>
				<DropdownMenu>
					<DropdownMenuTrigger className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground" aria-label="Card options">
						<MoreHorizontal className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-52">
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">View</DropdownMenuLabel>
						{([["paths", "File paths"], ["fold", "Fold finished runs"]] as const).map(([k, label]) => (
							<DropdownMenuItem key={k} onSelect={(e) => (e.preventDefault(), setView({ [k]: !view[k] }))} className="text-[13px]">
								{label}
								{view[k] ? <Check className="ml-auto size-3.5" /> : null}
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Density</DropdownMenuLabel>
						{([[false, "Comfortable"], [true, "Compact"]] as const).map(([c, label]) => (
							<DropdownMenuItem key={label} onSelect={(e) => (e.preventDefault(), setView({ compact: c }))} className="text-[13px]">
								{label}
								{view.compact === c ? <Check className="ml-auto size-3.5" /> : null}
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(summary())} className="text-[13px]">
							<Copy className="size-3.5" /> Copy summary
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{folded ? (
				<button type="button" onClick={() => setView({ fold: false })} className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-muted/40">
					<CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
					Finished · {items.length} {items.length === 1 ? "step" : "steps"}
					{changed ? <span className="rounded bg-violet-500/15 px-1.5 text-[11px] text-violet-700 dark:text-violet-300">{changed} changed</span> : null}
					{broke ? <span className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-700 dark:text-amber-300">{broke} to check</span> : null}
				</button>
			) : (
				<ul className="divide-y">
					{items.map((c, i) => (
						<CardStep key={i} step={c} running={running && i === items.length - 1 && !c.result} now={now} view={view} defaultOpen={running && i === items.length - 1} />
					))}
					{trailing.map((n, i) => <NoteRow key={`n${i}`} e={n} />)}
				</ul>
			)}
			<div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
				<span className="tabular-nums">
					{items.length} {items.length === 1 ? "step" : "steps"}
					{elapsed ? ` · ${elapsed}` : ""}
				</span>
				{running && onPause ? (
					<button type="button" onClick={onPause} className="ml-auto inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-[11px] text-foreground hover:bg-muted">
						<Pause className="size-3" /> Pause
					</button>
				) : null}
			</div>
		</div>
	);
}

/** One step of a run card: done, failed or running, what and where, how long, the agent's note; opens to its output. */
function CardStep({ step, running, now, view, defaultOpen }: { step: { call: Ev; result?: Ev; notes: Ev[] }; running: boolean; now: number; view: CardView; defaultOpen: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	const [tool, ...rest] = step.call.text.split(" ");
	const arg = rest.join(" ");
	const isRun = tool === "run";
	const end = step.result?.at ?? (running ? now : undefined);
	const elapsed = step.call.at && end ? took(end - step.call.at) : null;
	const bad = failed(step.result);
	const wrote = tool === "write_file";
	return (
		<li>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`flex w-full items-start gap-2 px-3 text-left hover:bg-muted/40 ${view.compact ? "py-1" : "py-2"}`}>
				<span className="mt-0.5 shrink-0">
					{running ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" /> : bad ? <CircleX className="size-4 text-red-500" /> : <CircleCheck className="size-4 text-muted-foreground" />}
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 text-foreground">{isRun ? (running ? "Running" : "Ran") : tool}</span>
						{view.paths && arg ? <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">{arg}</span> : null}
						{wrote ? <span className="shrink-0 rounded bg-violet-500/15 px-1.5 text-[11px] text-violet-700 dark:text-violet-300">Changed</span> : null}
						{bad ? <span className="shrink-0 rounded bg-red-500/15 px-1.5 text-[11px] text-red-700 dark:text-red-400">Failed</span> : null}
						{elapsed ? <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">{elapsed}</span> : null}
					</span>
					{!view.compact && step.notes.length ? <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted-foreground">{step.notes.map((n) => n.text).join(" ")}</span> : null}
					{running ? (
						<span className="mt-1.5 block h-0.5 overflow-hidden rounded-full bg-muted">
							<span className="fm-indeterminate block h-full w-1/3 rounded-full bg-foreground/60" />
						</span>
					) : null}
				</span>
			</button>
			{open ? (
				<div className="space-y-1.5 border-t bg-muted/30 px-3 py-2">
					<p className="whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">$ {step.call.text}</p>
					{step.result?.text.includes("\n```diff\n") ? (
						<DiffOutput text={step.result.text} />
					) : step.result?.text.trim() ? (
						<ToolOutput call={step.call.text} text={step.result.text} />
					) : (
						<p className="font-mono text-[11px] text-muted-foreground">{running ? "running…" : "no result: the session stopped before it finished"}</p>
					)}
				</div>
			) : null}
		</li>
	);
}

function NoteRow({ e }: { e: Ev }) {
	const [open, setOpen] = useState(false);
	return (
		<li>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-muted/50">
				<span className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap" : "truncate"}`}>{e.text}</span>
				{open ? null : <ChevronRight className="size-3.5 shrink-0" />}
			</button>
		</li>
	);
}

const EXT: Record<string, string> = { sol: "solidity", lean: "lean", ts: "typescript", tsx: "tsx", js: "javascript", json: "json", md: "markdown", toml: "toml", sh: "bash", py: "python", yml: "yaml", yaml: "yaml" };

/** A tool's output, highlighted by the file it read (or as shell for a run); read_file's line numbers sit in a gutter. */
/** A file write as the swarm reports it: its one-line result, then the unified diff, added lines green, removed red. */
function DiffOutput({ text }: { text: string }) {
	const [head, rest] = text.split("\n```diff\n");
	const lines = rest.replace(/```\s*$/, "").replace(/\n$/, "").split("\n");
	return (
		<div className="space-y-1.5">
			<p className="font-mono text-[11px] text-muted-foreground">{head}</p>
			<CodeBlock size="sm" className="text-[11px]">
				<CodeBlockContent className="max-h-72">
					{lines.map((l, i) => (
						<span
							key={i}
							className={`block whitespace-pre ${l.startsWith("+++") || l.startsWith("---") ? "text-muted-foreground" : l.startsWith("@@") ? "text-sky-600 dark:text-sky-400" : l.startsWith("+") ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : l.startsWith("-") ? "bg-red-500/10 text-red-700 dark:text-red-400" : ""}`}
						>
							{l || " "}
						</span>
					))}
				</CodeBlockContent>
			</CodeBlock>
		</div>
	);
}

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
	// From its first line: nothing (scroll anchoring as the highlighting lands, a stray scroll) leaves it opened mid-way.
	const box = useRef<HTMLPreElement>(null);
	useLayoutEffect(() => {
		if (box.current) box.current.scrollTop = 0;
	}, [text, lines]);
	return (
		<CodeBlock size="sm" className="text-[11px]">
			<CodeBlockContent ref={box} className="max-h-48 [overflow-anchor:none]">
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
	// AffectUI's message actions from the private UI package when it is checked out.
	if (AuiReplyActions) return <AuiReplyActions text={text} />;
	return <OwnReplyActions text={text} />;
}

function OwnReplyActions({ text }: { text: string }) {
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

/** An `ask` event's text: the question, and the replies the agent drafted for you. */
function parseAsk(text: string): { question: string; replies: string[] } {
	try {
		const v = JSON.parse(text) as { question?: unknown; replies?: unknown };
		return { question: String(v.question ?? ""), replies: Array.isArray(v.replies) ? v.replies.map(String) : [] };
	} catch {
		return { question: text, replies: [] };
	}
}

const askKey = (e: Ev) => `${e.run}:${e.at ?? ""}:${e.text}`;

/** The agents' questions still waiting for you: asked, and not answered by a later message of yours. A question about
 * a statement (`S-07: is this what you meant?`) stays only while that statement is still waiting for an answer: one
 * confirmed, corrected or removed elsewhere (the statements list, the MCP) is no longer a question. */
export function useOpenQuestions(folder: string, events: Ev[], waiting?: Set<string>) {
	const key = `fm:answered:${folder}`;
	const [answered, setAnswered] = useState<string[]>(() => {
		try {
			return JSON.parse(store.get(key) ?? "[]") as string[];
		} catch {
			return [];
		}
	});
	const open = useMemo(() => {
		const said = new Set(events.filter((e) => e.kind === "you").map((e) => e.text.trim()));
		return events.filter((e) => e.kind === "ask" && !answered.includes(askKey(e)) && !parseAsk(e.text).replies.some((r) => said.has(r.trim())) && !(waiting && /^S-\d+$/.test(e.item) && !waiting.has(e.item)));
	}, [events, answered, waiting]);
	const markAnswered = (asks: Ev[]) => {
		const next = [...answered, ...asks.map(askKey)].slice(-500);
		setAnswered(next);
		store.set(key, JSON.stringify(next));
	};
	return { open, markAnswered };
}

/**
 * The agents' open questions, above the composer where you see them: one at a time, a choice from the replies the
 * agent drafted, Next to the following one, and Send to answer them all at once.
 */
export function QuestionStack({ asks, onSend, onSkip, onWrite }: { asks: Ev[]; /** Your picks, one message each, in order. */ onSend: (answers: { ask: Ev; text: string }[]) => void; /** Questions you chose not to answer. */ onSkip: (asks: Ev[]) => void; /** Answer in your own words: the composer takes it. */ onWrite: (ask: Ev) => void }) {
	const [at, setAt] = useState(0);
	const [picks, setPicks] = useState<Record<string, string>>({});
	const i = Math.min(at, asks.length - 1);
	if (!asks.length) return null;
	const e = asks[i];
	const ask = parseAsk(e.text);
	const picked = picks[askKey(e)];
	const last = i === asks.length - 1;
	const chosen = asks.filter((a) => picks[askKey(a)]);
	const send = () => {
		onSend(chosen.map((a) => ({ ask: a, text: picks[askKey(a)] })));
		const skipped = asks.filter((a) => !picks[askKey(a)]);
		if (skipped.length) onSkip(skipped);
		setPicks({});
		setAt(0);
	};
	return (
		<div className="rounded-2xl border bg-card shadow-sm">
			<div className="flex items-center gap-2 border-b px-3 py-1.5 text-[12px]">
				<span className="font-medium capitalize" style={{ color: colorOf(e.role) }}>{roleName(e.role)}</span>
				<span className="text-muted-foreground">asks</span>
				<span className="ml-auto tabular-nums text-muted-foreground">{asks.length > 1 ? `Question ${i + 1} of ${asks.length}` : "Question"}</span>
			</div>
			<div className="max-h-56 overflow-y-auto border-b px-3 py-1.5 [&_.chat-markdown]:leading-5 [&_.chat-markdown_blockquote]:my-1.5 [&_.chat-markdown_p]:my-1">
				<ChatMarkdown>{ask.question}</ChatMarkdown>
			</div>
			<div className="flex flex-col p-1" role="radiogroup" aria-label="Your answer">
				{ask.replies.map((r) => (
					<button key={r} type="button" role="radio" aria-checked={picked === r} onClick={() => setPicks({ ...picks, [askKey(e)]: r })} className={`flex items-start gap-2 rounded-lg px-2.5 py-1 text-left text-[13px] ${picked === r ? "bg-muted" : "hover:bg-muted/60"}`}>
						{/* A round mark: filled with a check when picked, an empty ring otherwise. */}
						<span aria-hidden className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors ${picked === r ? "border-foreground bg-foreground text-background" : "border-muted-foreground/50"}`}>
							{picked === r ? <Check className="size-2.5" strokeWidth={3} /> : null}
						</span>
						<span>{r}</span>
					</button>
				))}
				<button type="button" onClick={() => onWrite(e)} className="rounded-lg px-2.5 py-1 pl-8 text-left text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
					Something else…
				</button>
			</div>
			<div className="flex items-center gap-1 border-t px-2 py-1">
				<button type="button" onClick={() => setAt(i - 1)} disabled={i === 0} className="h-7 rounded-full px-2.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">Back</button>
				<button type="button" onClick={() => (last ? (chosen.length ? send() : onSkip(asks)) : setAt(i + 1))} className="h-7 rounded-full px-2.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
					{last && !chosen.length ? (asks.length > 1 ? "Skip all" : "Skip") : "Skip"}
				</button>
				<span className="ml-auto" />
				{last ? (
					<button type="button" onClick={send} disabled={!chosen.length} className="btn-dark h-7 px-3 text-[12px] disabled:opacity-50">
						{chosen.length > 1 ? `Send ${chosen.length} answers` : "Send"}
					</button>
				) : (
					<button type="button" onClick={() => setAt(i + 1)} disabled={!picked} className="btn-dark h-7 px-3 text-[12px] disabled:opacity-50">Next</button>
				)}
			</div>
		</div>
	);
}

export function AgentMessage({ e, onBug, onReply, turn }: { e: Ev; onBug: () => void; /** A drafted reply picked: it goes to the composer to edit or send. */ onReply?: (text: string) => void; /** The whole turn's text when this is its last message (Copy and the thumbs show once per turn); otherwise none. */ turn?: string }) {
	const color = e.kind === "bug" ? "#dc2626" : colorOf(e.role);
	return (
		<Message>
			<MessageContent className="gap-1">
				{/* The name in its colour says who it is. */}
				{/* The chat reads as one conversation: no agent name over each message, only a bug's own label. */}
				{e.kind === "bug" ? (
					<MessageHeader className="gap-1.5 px-0 capitalize" style={{ color }}>
						bug reported
						{/^\d+$/.test(e.item) ? <span className="font-normal normal-case text-muted-foreground">· item {e.item}</span> : null}
					</MessageHeader>
				) : null}
				{e.kind === "bug" ? (
					<button type="button" onClick={onBug} className="w-fit whitespace-pre-wrap rounded-2xl rounded-tl-md bg-red-500/10 px-3 py-2 text-left hover:bg-red-500/15">
						{e.text.split(" — ")[0]}
						<span className="mt-1 block text-xs text-red-700/70 dark:text-red-400/70">Open the report →</span>
					</button>
				) : e.kind === "plan" || e.kind === "done" ? (
					<p className="text-[13px] text-muted-foreground">{e.text}</p>
				) : e.kind === "ask" ? (
					(() => {
						const ask = parseAsk(e.text);
						return (
							<div className="space-y-2">
								<ChatMarkdown>{ask.question}</ChatMarkdown>
								{ask.replies.length ? (
									<div className="flex flex-wrap gap-1.5">
										{ask.replies.map((r) => (
											<button key={r} type="button" onClick={() => onReply?.(r)} disabled={!onReply} className="max-w-full rounded-2xl border bg-background px-3 py-1 text-left text-[13px] hover:bg-muted enabled:cursor-pointer">
												{r}
											</button>
										))}
									</div>
								) : null}
							</div>
						);
					})()
				) : (
					<div className="group/reply">
						<ChatMarkdown>{e.text}</ChatMarkdown>
						{turn !== undefined ? <ReplyActions text={turn} /> : null}
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
/** A line number marked in the code's gutter (a function's proof status, in its colour), on a 0-based line. */
export type GutterMark = { text: string; title: string; onClick: () => void };

/** Where a text caret sits in a FileView: its 0-based line and column (characters of code before it). */
function caretIn(pre: HTMLElement): { line: number; col: number } | null {
	const sel = window.getSelection();
	const node = sel?.focusNode;
	if (!sel || !node || !pre.contains(node)) return null;
	const row = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>("[data-line]");
	const code = row?.querySelector("[data-code]");
	if (!row || !code) return null;
	if (!code.contains(node)) return { line: Number(row.dataset.line), col: 0 };
	let col = 0;
	const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
	for (let t = walk.nextNode(); t && t !== node; t = walk.nextNode()) col += t.textContent?.length ?? 0;
	return { line: Number(row.dataset.line), col: col + (node.nodeType === Node.TEXT_NODE ? sel.focusOffset : 0) };
}

export function FileView({ path, text, big, start = 1, mark, cursor, diagnostics, gutter, band, onCaret }: { path: string; text: string; big?: boolean; start?: number; mark?: number | null; cursor?: Cursor | null; /** A text caret you can place and move but nothing can be typed: reports where it is (and the line is lit). */ onCaret?: (at: { line: number; col: number } | null) => void; /** solc's errors and warnings in this file: a wavy underline, the message under the line. */ diagnostics?: Diagnostic[]; gutter?: Map<number, GutterMark>; /** 0-based lines tinted as one block (the function the Proofs rail has picked), its numbers in `text`'s colour. */ band?: { from: number; to: number; text?: string } | null }) {
	const lines = useHighlightedCode(text, EXT[path.split(".").pop() ?? ""] ?? "text");
	const marked = useRef<HTMLSpanElement | null>(null);
	useEffect(() => {
		marked.current?.scrollIntoView({ block: "center" });
	}, [mark, path, lines.length]);
	const caret = useRef<HTMLSpanElement | null>(null);
	useEffect(() => {
		caret.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [cursor?.line, cursor?.col]);
	// The read-only caret: the browser's own (click, arrows, ⌥/⌘-arrows, shift to select), with every edit refused.
	const pre = useRef<HTMLPreElement | null>(null);
	const [lit, setLit] = useState<number | null>(null);
	useEffect(() => {
		if (!onCaret) return;
		const moved = () => {
			if (!pre.current || document.activeElement !== pre.current) return;
			const at = caretIn(pre.current);
			setLit(at?.line ?? null);
			onCaret(at);
		};
		document.addEventListener("selectionchange", moved);
		return () => document.removeEventListener("selectionchange", moved);
	}, [onCaret]);
	const readOnly = onCaret
		? {
				contentEditable: true,
				suppressContentEditableWarning: true,
				spellCheck: false,
				role: "textbox",
				"aria-readonly": true,
				"aria-multiline": true,
				onBeforeInput: (e: React.FormEvent) => e.preventDefault(),
				onPaste: (e: React.ClipboardEvent) => e.preventDefault(),
				onCut: (e: React.ClipboardEvent) => e.preventDefault(),
				onDrop: (e: React.DragEvent) => e.preventDefault(),
				// An input method would write into the page before anything can refuse it.
				onCompositionStart: (e: React.CompositionEvent<HTMLPreElement>) => e.currentTarget.blur(),
				onKeyDown: (e: React.KeyboardEvent) => {
					if (e.key === "Enter" || e.key === "Backspace" || e.key === "Delete" || e.key === "Tab") e.preventDefault();
				},
				onBlur: () => {
					setLit(null);
					onCaret(null);
				},
			}
		: {};
	return (
		<pre ref={pre} {...readOnly} className={`overflow-x-auto py-2 font-mono outline-none ${onCaret ? "caret-foreground" : ""} ${big ? "text-[12.5px] leading-6" : "text-[11px] leading-5"}`}>
			{lines.map((line, i) => (
				<span key={i} ref={i === mark ? marked : undefined} data-line={i} className={`relative block whitespace-pre pr-3 ${i === mark ? "bg-amber-300/25" : cursor?.line === i || lit === i ? "bg-muted/60" : band && i >= band.from && i <= band.to ? "bg-foreground/[0.035]" : ""}`}>
					{band && i >= band.from && i <= band.to ? <span aria-hidden contentEditable={false} className={`absolute inset-y-0 left-0 w-0.5 bg-current opacity-70 ${band.text ?? "text-foreground/25"}`} /> : null}
					{/* A marked line's number takes its status colour and picks it; the others stay muted. */}
					{gutter?.get(i) ? (
						<button
							type="button"
							contentEditable={false}
							title={gutter.get(i)!.title}
							aria-label={gutter.get(i)!.title}
							onClick={(e) => {
								e.stopPropagation();
								gutter.get(i)!.onClick();
							}}
							className={`mr-3 inline-block w-9 select-none rounded-sm text-right font-medium hover:underline ${gutter.get(i)!.text}`}
						>
							{i + start}
						</button>
					) : (
						<span contentEditable={false} className={`mr-3 inline-block w-9 select-none text-right ${band?.text && i >= band.from && i <= band.to ? `font-medium ${band.text}` : "text-muted-foreground/60"}`}>{i + start}</span>
					)}
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

/**
 * Bugs: the folder's audit reports (Markdown in its report folders, which the gear sets) and the swarm's findings,
 * each opened on the right.
 */
/**
 * The audit findings of a folder's report folders (`dirs`): each index's rows (README.md / INDEX.md) and each
 * standard audit file, with Formal Mind's own rows shown once. The reports are the other files there. Bugs on the Mac
 * and the web read them this way.
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

/**
 * A side column's width, dragged from its card's right edge (double-click for the default) and kept per view. Returns
 * the width and the handle, which goes right after the column in its row.
 */
function useDragWidth(key: string, initial: number) {
	const [width, setWidth] = useState(() => Number(store.get(key)) || initial);
	const start = (e: React.PointerEvent<HTMLElement>) => {
		e.preventDefault();
		// The row holding the column: the other side keeps at least 280px.
		const row = e.currentTarget.parentElement;
		const max = (row?.clientWidth ?? 900) - 280;
		const from = { x: e.clientX, w: width };
		let last = width;
		const move = (ev: PointerEvent) => {
			last = Math.round(Math.min(max, Math.max(200, from.w + ev.clientX - from.x)));
			setWidth(last);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			store.set(key, String(last));
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const reset = () => {
		setWidth(initial);
		store.set(key, String(initial));
	};
	// Sits between the two cards, over the row's gap.
	const handle = <div onPointerDown={start} onDoubleClick={reset} title="Drag to resize" className="-mx-1 w-3 shrink-0 cursor-col-resize self-stretch max-sm:hidden" />;
	return { width, handle };
}

export function BugsView({ folder, files, invoke, bugs, openBug, setOpenBug, withPoc, onOpenFile, reload = 0, onTriage }: { folder: string; files: string[]; invoke: Bridge["invoke"]; bugs: Bug[]; openBug: string | null; setOpenBug: (f: string | null) => void; withPoc: (body: string) => Promise<string>; onOpenFile: (path: string) => void; reload?: number; onTriage?: (path: string) => Promise<void>}) {
	const dirs = useReportDirs(folder);
	const side = useDragWidth("fm:bugs-list-width", 320);
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
		// `reload` is Refresh (and the swarm's writes): a report open here is read again too.
	}, [folder, showingPath, invoke, reload]);
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
			</div>
			{/* On a phone the list sits above the report it opens. */}
			<div className="flex min-h-0 flex-1 gap-1 max-sm:flex-col">
				<nav style={{ width: side.width }} className="flex shrink-0 flex-col overflow-y-auto rounded-xl border bg-card p-1.5 max-sm:max-h-[40%] max-sm:!w-full">
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
						{fmReports.length === 0 ? <li className="px-2 py-1 text-[12px] text-muted-foreground">No report yet. The swarm writes its findings and proofs here.</li> : null}
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
				{side.handle}
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

export type Mode = "code" | "chat" | "swarm" | "roadmap" | "audit" | "bugs";

/** The views the Mac app shows in the middle, in the order the title bar's icons show them. */
/** How many of a session's latest messages the chat draws at first (and adds per "Show earlier messages"). */
const CHAT_WINDOW = 150;


const MODES: { id: Mode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
	{ id: "code", label: "Code", icon: Code2 },
	{ id: "chat", label: "Chat", icon: TalkIcon },
	{ id: "swarm", label: "Swarm", icon: Network },
	{ id: "audit", label: "Proofs", icon: ScanSearch },
	{ id: "bugs", label: "Bugs", icon: Bug },
];

/**
 * The page's modes and the folder's name, as one macOS-style segmented control. The Mac app shows it in its
 * title bar; the web app centres it at the top of the page.
 */
/** Where the selected tab's pill last was, so a new page's tabs slide from there instead of jumping. */
let lastPill: { left: number; width: number } | null = null;

export function NavGroup({ name, git, mode, onMode, inBar, compact }: { name: string; git: boolean; mode: Mode; onMode: (m: Mode) => void; inBar?: boolean; compact?: boolean }) {
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
			{/* No tab for the folder itself: its files open from the file tree, in the Code view. */}
			{MODES.filter((m) => m.id !== "code").map(({ id, label, icon: Icon }) =>
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
		</div>
	);
}



/**
 * The mode a link asks for, as the page has it: Roadmap and Chat have no tab now (the roadmap is on the Swarm canvas),
 * so they open Swarm, as do links to tabs that are gone (Debug, Concolic, Reach). The Chat view stays in the code for
 * later.
 */
function resolveMode(asked: string): Mode {
	return (["chat", "code", "swarm", "audit", "bugs"] as const).find((m) => m === asked) ?? "swarm";
}

/** A slot in the Mac app's title bar (desktop/src/tabs.tsx), when there is one: the left one for the page's name, the
    right one for its actions. */
function useTitlebarSlot(id = "fm-titlebar-slot") {
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	useEffect(() => setSlot(document.getElementById(id)), [id]);
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
	const side = useDragWidth("fm:coverage-list-width", 288);
	// The scripts that call a function, matched by its contract (or the contract it is inherited into) and name.
	const contractOf = (f: FormalFn) => f.name.split(".").slice(0, -1).join(".");
	const fnName = (f: FormalFn) => f.name.split(".").pop() ?? f.name;
	const calledBy = (f: FormalFn) => (scripts?.entryPoints ?? []).filter((e) => e.function === fnName(f) && (e.contract === contractOf(f) || e.contract === data.contract)).flatMap((e) => e.scripts);
	const [filter, setFilter] = useState<(typeof COVERAGE_FILTERS)[number]["id"]>("all");
	// A function's identity: several share a name (overloads, or the same library compiled twice), so add where it is.
	const fnKey = (f: FormalFn) => `${f.name}@${f.file ?? ""}:${f.line}`;
	// Library functions are always listed and counted.
	// Within a group: those with a sorry, then the modelled ones, and the ones not modelled last, each keeping its order.
	const rank = (f: FormalFn) => ["proved", "sorry", "modeled", "opaque"].indexOf(fnStatus(f, data.theorems).key);
	const shown = data.functions
		.filter((f) => (filter === "all" || (filter === "modeled" ? ["modeled", "sorry"].includes(fnStatus(f, data.theorems).key) : fnStatus(f, data.theorems).key === filter)))
		.sort((a, b) => rank(a) - rank(b));
	// Proved functions sit in their own group on top, out of the others.
	const provedFns = shown.filter((f) => rank(f) === 0);
	const rest = shown.filter((f) => rank(f) !== 0);
	const groups = [
		{ title: "Proved", fns: provedFns },
		{ title: "Functions", fns: rest.filter((f) => f.entry && calledBy(f).length) },
		{ title: scripts ? "Other entry points" : "Entry points", fns: rest.filter((f) => f.entry && !calledBy(f).length) },
		{ title: "Internal", fns: rest.filter((f) => !f.entry && !f.dependency) },
		{ title: "Libraries", fns: rest.filter((f) => !f.entry && f.dependency) },
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
				<nav style={{ width: side.width }} className="flex shrink-0 flex-col overflow-hidden rounded-xl border bg-card max-sm:max-h-[42%] max-sm:!w-full">
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
				{side.handle}
				{current && status ? (
					<section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card" style={{ containerType: "inline-size" }}>
						<header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
							{/* The status and the place; the name is already picked in the list. */}
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
							{/* Side by side when the card is wide enough; stacked (Solidity above the Lean) when it is squeezed. */}
							<div className="grid min-h-0 grid-cols-1 divide-y [@container(min-width:720px)]:grid-cols-2 [@container(min-width:720px)]:divide-x [@container(min-width:720px)]:divide-y-0">
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

/** Audit mode: what's been established for the contract picked here, as Lean coverage. */
export function AuditView(props: { folder: string; scan: Scan | null; invoke: Bridge["invoke"]; onOpenFile: (path: string, line?: number) => void; reload?: number }) {
	return <CoverageAuditView {...props} />;
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
 * `defaultMode` is the tab without a ?mode; `onSwarm` sends the Swarm tab elsewhere (the website's imported repositories
 * keep their swarm on the project canvas).
 */
export function SwarmPanel({ folder, name, scan, bridge, session, file: openPath, actions, defaultMode, onSwarm }: { folder: string; name: string; scan: Scan | null; bridge: Bridge; session?: string | null; file?: string | null; actions?: React.ReactNode; defaultMode?: Mode; onSwarm?: () => void }) {
	const { invoke, listen, apiBase } = bridge;
	// Every session running in this folder: each is its own swarm, and they keep working while you read another.
	const [runs, setRuns] = useState<string[]>([]);
	const [events, setEvents] = useState<Ev[]>([]);
	const [plan, setPlan] = useState<Item[]>([]);
	// The proof ledger (src-tauri/src/ledger.rs): each function's checked status, by Lean def. The plan's marks come
	// from it, so an item shows proved only when the ledger says so.
	const [ledger, setLedger] = useState<Record<string, LedgerEntry>>({});
	const [statements, setStatements] = useState<Statement[]>([]);
	const [claim, setClaim] = useState("");
	const [claimError, setClaimError] = useState<string | null>(null);
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
	const [effort, setEffort] = useState(() => store.get("fm:effort") ?? "");
	
	// Set in Settings (desktop/src/settings.tsx).
	const [provider, setProvider] = useState<Provider>(() => {
		const p = store.get("fm:provider");
		// Claude Code (your Claude plan) unless you picked a key in Settings.
		return p === "anthropic" || p === "openai" || p === "codex" || p === "formal" ? p : "claude-code";
	});
	// The Claude plan Claude Code is signed in to ("Claude Max plan"), or null when it can't run the agents here.
	const [claudePlan, setClaudePlan] = useState<string | null>(null);
	useEffect(() => {
		void invoke<string>("claude_code_status").then(
			(v) => setClaudePlan(v.match(/your (Claude \w+ plan)/)?.[1] ?? "Claude plan"),
			() => setClaudePlan(null),
		);
	}, [invoke]);
	// Whether Codex is signed in with ChatGPT here, so the agents can run on that plan instead.
	const [codexReady, setCodexReady] = useState(false);
	useEffect(() => {
		void invoke<string>("codex_status").then(() => setCodexReady(true), () => setCodexReady(false));
	}, [invoke]);
	const choosePlan = (p: "claude-code" | "codex") => {
		setProvider(p);
		store.set("fm:provider", p);
	};
	const navigate = useNavigate();
	// The models for how the agents are run: GPT on your OpenAI key or ChatGPT plan, Claude otherwise.
	const models = provider === "openai" ? OPENAI_MODELS : provider === "codex" ? CODEX_MODELS : MODELS;
	// The plan that pays when the agents run on Claude Code or Codex (no spend or cap), else null.
	const payingPlan = provider === "claude-code" ? (claudePlan ?? "Claude plan") : provider === "codex" ? "ChatGPT plan" : null;
	// On a plan, the picker offers both plans' models: Claude, and GPT when Codex is signed in with ChatGPT.
	const both = [...(claudePlan ? MODELS : []), ...(codexReady ? CODEX_MODELS : [])];
	const pickable = payingPlan && both.length ? both : models;
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
	// The roadmap lives on the Swarm canvas now and Chat has no tab; old links to either open Swarm.
	// The chat is the page: it opens first, in the Mac app and on the website.
	const mode = resolveMode(params.get("mode") ?? defaultMode ?? "chat");
	const canvas = mode === "swarm";
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
			// A file that can't be read (one that moved since a message or the address named it) just doesn't open; the
			// chat's error line is for the swarm, not for files.
			() => setFile(null),
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
	// Arriving at a function's first line (Back, the history, a theorem's Proves link) picks that function.
	useEffect(() => {
		const f = markLine ? solProofs.functions.find((g) => g.line === markLine) : undefined;
		if (f) setProofFn(fnKey(f));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [markLine, solProofs.data]);
	const pickedFn = solProofs.functions.find((f) => fnKey(f) === proofFn) ?? null;
	/** Picks a function in the rail (or by its line number) and brings its code into view. */
	const pickProof = (f: FormalFn) => {
		setProofFn(fnKey(f));
		if (openPath) remember({ path: openPath, line: f.line, label: f.name.split(".").pop() ?? f.name });
		codeBox.current?.querySelector(`[data-line="${f.line - 1}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
	};
	const leanEditor = isTauri() && proofsOn && !!file && file.path.endsWith(".lean");
	/** Opens a function's generated Lean definition: its `def Contract.function` line, in formal/Generated/ first. */
	const leanTexts = useRef(new Map<string, string>());
	useEffect(() => leanTexts.current.clear(), [folder]);
	const openLeanDef = async (f: FormalFn) => {
		const at = new RegExp(`^(?:[a-z]+ )*def ${f.lean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m");
		const files = tree.filter((p) => p.endsWith(".lean")).sort((a, b) => Number(!/(^|\/)Generated\//.test(a)) - Number(!/(^|\/)Generated\//.test(b)));
		for (const path of files) {
			let text = leanTexts.current.get(path);
			if (text === undefined) {
				text = await invoke<string>("folder_read", { folder, path }).catch(() => "");
				leanTexts.current.set(path, text);
			}
			const m = at.exec(text);
			if (m) return view(path, text.slice(0, m.index).split("\n").length);
		}
	};

	// Where you've been in Code, as a browser's history: a list of places with a cursor in it. Opening a file, a line
	// or a function adds a place after the cursor (dropping the ones ahead of it); Back and Forward move the cursor.
	type Place = { path: string; line: number | null; label: string };
	const [trail, setTrail] = useState<{ places: Place[]; at: number }>({ places: [], at: -1 });
	const travelling = useRef(false);
	const remember = (p: Place) =>
		setTrail(({ places, at }) => {
			const here = places[at];
			if (here && here.path === p.path && here.line === p.line) return { places, at };
			const next = [...places.slice(0, at + 1), p].slice(-50);
			return { places: next, at: next.length - 1 };
		});
	useEffect(() => setTrail({ places: [], at: -1 }), [folder]);
	useEffect(() => {
		if (mode !== "code" || !openPath) return;
		if (travelling.current) {
			travelling.current = false;
			return;
		}
		const base = openPath.split("/").pop() ?? openPath;
		remember({ path: openPath, line: markLine, label: markLine ? `${base}:${markLine}` : base });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, openPath, markLine]);
	const travel = (to: number) => {
		const p = trail.places[to];
		if (!p) return;
		setTrail((t) => ({ ...t, at: to }));
		if (p.path !== openPath || p.line !== markLine) {
			travelling.current = true;
			view(p.path, p.line ?? undefined);
		} else codeBox.current?.querySelector(`[data-line="${(p.line ?? 1) - 1}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
	};
	const canBack = trail.at > 0;
	const canForward = trail.at < trail.places.length - 1;
	// ⌘[ and ⌘] (as in Xcode and Safari) go back and forward in Code.
	const travelKeys = useRef<(e: KeyboardEvent) => void>(() => {});
	travelKeys.current = (e) => {
		if (mode !== "code" || !(e.metaKey || e.ctrlKey) || (e.key !== "[" && e.key !== "]")) return;
		e.preventDefault();
		travel(trail.at + (e.key === "[" ? -1 : 1));
	};
	useEffect(() => {
		const on = (e: KeyboardEvent) => travelKeys.current(e);
		window.addEventListener("keydown", on);
		return () => window.removeEventListener("keydown", on);
	}, []);
	// Code navigation (solidity-language-server in the app): ⌘/Ctrl-click goes to the definition; resting on a
	// symbol shows its hover.
	const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hoverAt = useRef<string>("");
	const navigable = (path: string) => path.endsWith(".sol");
	// Vim keys (a setting): a cursor over the read-only file.
	const vim = useVimMode();
	const [cursor, setCursor] = useState<Cursor>({ line: 0, col: 0 });
	// Where the read-only caret is in the open file (Vim off), for the file bar.
	const [caretAt, setCaretAt] = useState<{ line: number; col: number } | null>(null);
	useEffect(() => setCaretAt(null), [file?.path]);
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
	// While a session's history is being read: the chat shows a skeleton instead of an empty page.
	const [loadingHistory, setLoadingHistory] = useState(true);
	/** Shows a session's saved events (.formal/runs/<run>.jsonl), so quitting the app loses nothing. */
	const load = (id: string) => {
		setViewing(id);
		setLoadingHistory(true);
		void invoke<Ev[]>("swarm_history", { folder, run: id })
			.then((evs) => setEvents(trim(evs)), () => setEvents([]))
			.finally(() => setLoadingHistory(false));
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
	// `check` runs Lean when the sources changed (after a proof or at a session's end); otherwise the last check is read.
	const readLedger = (check = false) =>
		void invoke<{ entries: LedgerEntry[] }>("control", { op: "ledger", folder, args: { check } }).then(
			(l) => setLedger(Object.fromEntries(l.entries.map((e) => [e.lean, e]))),
			() => {},
		);
	const refresh = () => {
		readLedger();
		void invoke<Item[]>("swarm_plan", { folder }).then(setPlan, () => {});
		void invoke<Statement[]>("swarm_statements", { folder }).then((s) => setStatements(s ?? []), () => {});
		void invoke<Bug[]>("swarm_bugs", { folder }).then(setBugs, () => {});
		void invoke<Record<string, Proof>>("swarm_proofs", { folder }).then(setProofs, () => {});
	};

	useEffect(() => {
		// Another folder's chat and sessions never carry over: the page starts empty and loads this folder's.
		setEvents([]);
		setViewing(null);
		setRuns([]);
		setLoadingHistory(true);
		refresh();
		void invoke<boolean>(provider === "openai" ? "openai_key_status" : "anthropic_key_status").then(setHasKey);
		void invoke<string[]>("swarm_running", { folder }).then(async (r) => {
			setRuns(r);
			const list = await listSessions();
			// Reopen where you left off: the session picked, else a running one, else the latest.
			const id = (session === "new" ? undefined : session) ?? r[0] ?? list[0]?.run;
			if (id) load(id);
			else setLoadingHistory(false);
		}, () => setLoadingHistory(false));
		const off = listen<Ev>("swarm", ({ payload }) => {
			// Other folders' sessions send events too.
			if (payload.folder && payload.folder !== folder) return;
			if (payload.kind === "start") setRuns((r) => (r.includes(payload.run) ? r : [...r, payload.run]));
			// The chat shows the session you're reading; the others carry on in the background.
			if (payload.run === viewingRef.current) setEvents((all) => trim([...all, payload]));
			if (["plan", "bug", "done"].includes(payload.kind) || (payload.kind === "status" && / is working$/.test(payload.text))) refresh();
			// An agent's statement shows in the list straight away.
			if (payload.kind === "ask" || (payload.kind === "tool" && /^(add_statement|formalize_result|confirm_statement)/.test(payload.text))) refresh();
			// A finding recorded from a report shows in Bugs straight away.
			if (payload.kind === "tool" && payload.text.startsWith("record_finding")) setReload((n) => n + 1);
			if (["plan", "bug", "done"].includes(payload.kind)) {
				setReload((n) => n + 1);
				void invoke<{ files: string[] }>("folder_tree", { path: folder }).then((t) => setTree(t.files), () => {});
			}
			if (payload.kind === "plan" && / proven$/.test(payload.text)) readLedger(true);
			if (payload.kind === "done") {
				readLedger(true);
				setRuns((r) => r.filter((x) => x !== payload.run));
				void listSessions();
			}
		});
		// Which sessions run is the app's to say (swarm-running, sent whenever one starts or ends, by any route: this
		// page, an agent through the MCP); a check on focus and every 15 s catches anything missed.
		const offRunning = listen<Record<string, string[]>>("swarm-running", ({ payload }) => setRuns(payload[folder] ?? []));
		const check = () => void invoke<string[]>("swarm_running", { folder }).then(setRuns, () => {});
		const every = setInterval(check, 15_000);
		window.addEventListener("focus", check);
		return () => {
			void off.then((f) => f());
			void offRunning.then((f) => f());
			clearInterval(every);
			window.removeEventListener("focus", check);
		};
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
	// The Refresh button: the folder is read again, so reports and indexes added to the audit folders show in Bugs, and
	// the findings, plan and bugs are read again too.
	useEffect(() => {
		const again = () => {
			void invoke<{ files: string[] }>("folder_tree", { path: folder }).then((t) => setTree(t.files), () => {});
			refresh();
			setReload((n) => n + 1);
		};
		window.addEventListener("fm:refresh", again);
		return () => window.removeEventListener("fm:refresh", again);
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
	// A session that just loaded opens at its latest messages: the scroll above ran while the skeleton showed. And while
	// you're at the bottom it stays there as messages settle (off screen they hold a placeholder height, then their own).
	useEffect(() => {
		if (loadingHistory) return;
		atBottom.current = true;
		setAway(false);
		const el = chat.current;
		if (!el) return;
		const pin = () => {
			if (atBottom.current) el.scrollTop = el.scrollHeight;
		};
		pin();
		const ro = new ResizeObserver(pin);
		for (const child of Array.from(el.children)) ro.observe(child);
		return () => ro.disconnect();
	}, [loadingHistory, viewing]);

	// `onlyQueued`: a run for the work already queued (reading a report), which stops when that's done.
	// The page says what to start; the backend (its control API, as the MCP uses it) picks the model
	// route, the model and the cap from the settings.
	/** Starts the swarm. With a message (typed, or `focus`), the assistant answers it and the session stops unless it
	 * asks for work; `work` (a steering interrupt) carries on with the plan after it either way. */
	const start = async (focus?: string, work = false) => {
		setError(null);
		// A new session starts empty; Resume carries on below the chat you're reading.
		const fresh = session === "new" && !viewing;
		if (fresh) setEvents([]);
		try {
			const text = (focus ?? goal).trim();
			const started = await invoke<{ run: string } | undefined>("control", { op: "start", folder, args: { goal: text, run: fresh ? `s-${Date.now().toString(16)}` : viewing ?? "swarm", answer_only: Boolean(text) && !work } });
			if (!started?.run) throw new Error("The swarm didn't start: no session came back.");
			const id = started.run;
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
		const transcript = events.filter((e) => e.kind === "say" || e.kind === "ask" || e.kind === "you" || e.kind === "bug" || e.kind === "done").slice(-20).map((e) => `${e.role}${e.item ? ` (item ${e.item})` : ""}: ${e.kind === "ask" ? parseAsk(e.text).question : e.text}`).join("\n");
		await invoke<string>("swarm_suggest", { folder, apiBase: apiBase(), provider, run, transcript })
			.then((text) => text && setSay(text))
			.catch((e) => setError(String(e)))
			.finally(() => setDrafting(false));
	};
	const waiting = useMemo(() => new Set(statements.filter((s) => s.mark === "?").map((s) => s.id)), [statements]);
	const questions = useOpenQuestions(folder, events, waiting);
	const send = async () => {
		const text = say.trim();
		if (!text || !run) return;
		setSay("");
		// Queued for the agent at work (it reads it at its next step); the app sends it back as a `you` event
		// (desktop/src-tauri/src/swarm.rs), logged with the session.
		await steerSend(text, false);
	};

	// Skill commands in the composer, as Claude Code writes them: `/skills`, `/skills add <id>`, `/skills remove <id>`
	// are handled here and answered in the chat; `/<id> <request>` asks the agents to use that skill. Returns the text to
	// send on (rewritten for `/<id>`), or null when the command was handled.
	const note = (text: string) => setEvents((all) => [...all, { run: viewing ?? "", kind: "say", role: "swarm", item: "", text, spent: all.at(-1)?.spent ?? 0, at: Date.now() }]);
	const skillCommand = async (text: string): Promise<string | null> => {
		const m = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
		if (!m) return text;
		type S = { id: string; name: string; author: string; added: boolean };
		const list = (await invoke<S[] | undefined>("skills_catalog").catch(() => undefined)) ?? [];
		const [, cmd, rest = ""] = m;
		if (cmd === "skills") {
			const [verb, id] = rest.trim().split(/\s+/);
			if (verb === "add" || verb === "remove") {
				const s = list.find((x) => x.id === id);
				if (!s) return note(`No skill \`${id ?? ""}\`. \`/skills\` lists them.`), null;
				await invoke(verb === "add" ? "skills_add" : "skills_remove", { id: s.id }).then(
					() => note(`${verb === "add" ? "Added" : "Removed"} ${s.name} (${s.author}) for every project.`),
					(e) => note(`Couldn't ${verb} ${s.name}: ${String(e)}`),
				);
				return null;
			}
			note(list.map((x) => `- \`${x.id}\` ${x.name} · ${x.author}${x.added ? " · added" : ""}`).join("\n") + "\n\n`/skills add <id>` · `/skills remove <id>` · `/<id> <request>` to use one");
			return null;
		}
		const s = list.find((x) => x.id === cmd);
		if (!s) return text;
		if (!s.added) return note(`${s.name} isn't added yet: \`/skills add ${s.id}\`.`), null;
		return `Use the ${s.name} skill (${s.author}; its files are under @skills/${s.id}/): ${rest.trim() || "audit the code in scope with it"}`;
	};
	const submit = async () => {
		const typed = (run ? say : goal).trim();
		if (!typed.startsWith("/")) return void (run ? send() : start());
		const next = await skillCommand(typed);
		if (next === null) return run ? setSay("") : setGoal("");
		// The rewritten request goes on directly (state set now would land only after this call).
		if (run) {
			setSay("");
			await invoke("swarm_say", { folder, run, text: next }).catch((e) => setError(String(e)));
		} else void start(next);
	};

	const spent = events.at(-1)?.spent ?? 0;
	const sessionTitle = (id: string | null) => {
		const i = sessions.findIndex((x) => x.run === id);
		if (i < 0) return run ? goal.trim() || "New session" : "New session";
		return sessions[i].title || (sessions[i].run === "swarm" ? "Main session" : `Session ${sessions.length - i}`);
	};
	const title = sessionTitle(viewing);
	// Renaming the chat in place: its name becomes a text box; Enter keeps it, Escape leaves it.
	const [renaming, setRenaming] = useState<string | null>(null);
	const rename = (name: string) => {
		setRenaming(null);
		if (!viewing || name.trim() === title) return;
		void invoke("swarm_rename", { folder, run: viewing, title: name }).then(() => listSessions(), (e) => setError(String(e)));
	};
	const working = run ? [...events].reverse().find((e) => e.kind === "status" && e.role !== "swarm") : undefined;
	// What the working agent did last (a tool call, or the step it's thinking on), shown under its plan item.
	const activity = working ? [...events].reverse().find((e) => (e.kind === "tool" || e.kind === "status") && e.role === working.role) : undefined;
	// An item's ledger entry: the Lean def its text names first (`Morpho.supply`).
	const entryOf = (i: Item) => ledger[i.text.split("`")[1] ?? ""];
	// Its mark: proved and partly proved from the ledger; blocked from the plan.
	const markOf = (i: Item) => (i.mark === "!" ? "!" : entryOf(i)?.status === "proved" ? "x" : entryOf(i)?.status === "partly proved" ? "~" : " ");
	const done = plan.filter((i) => markOf(i) === "x").length;
	// Entry points a plan item names, matched as whole words in its text.
	// constructor, receive and fallback have no name of their own in the AST.
	const label = (u: AstUnit) => u.function || (u.name.split(".").pop() ?? u.name);
	const named = (text: string) => entryUnits.filter((u) => u.function && new RegExp(`\\b${u.function}\\b`).test(text));
	const inPlan = new Set(plan.flatMap((i) => named(i.text).map((u) => u.name)));
	// The latest end of the session (a resumed one has several), so the reason shown is the current one.
	const finished = !run ? [...events].reverse().find((e) => e.kind === "done") : undefined;
	const shown = chatBlocks;
	const board = useMemo(() => localBoard(folder, plan, events, Boolean(run), budget), [folder, plan, events, run, budget]);
	const itemTitle = (steps: Row[]) => {
		const r = steps.find((x) => "call" in x) ?? steps[0];
		const item = r ? ("call" in r ? r.call.item : r.note.item) : "";
		const text = plan.find((p) => String(p.index) === item)?.text;
		return text ? text.replace(/\*\*|`/g, "").split(" — ")[0].trim() : undefined;
	};
	// A turn: everything the agents say between two of your messages. Its last message carries Copy and the thumbs,
	// for the whole turn's text.
	const turnEnds = useMemo(() => {
		const ends = new Map<number, string>();
		let texts: string[] = [];
		let last = -1;
		const close = () => {
			if (last >= 0) ends.set(last, texts.join("\n\n"));
			texts = [];
			last = -1;
		};
		chatBlocks.forEach((b, i) => {
			if ("e" in b && b.e.kind === "you") return close();
			if ("e" in b && b.e.kind === "say") {
				texts.push(b.e.text);
				last = i;
			}
		});
		close();
		return ends;
	}, [chatBlocks]);
	// Notes you sent the agent at work from its steering card. Each waits in the card's queue until a step starts after
	// it; its chat copy (your message) shows from then on.
	const [steerNotes, setSteerNotes] = useState<Steer[]>([]);
	useEffect(() => setSteerNotes([]), [viewing]);
	const steerSend = async (text: string, now: boolean, queued?: string) => {
		if (!run) return;
		// A queued note the swarm already has: it interrupts with it, without sending it twice.
		if (queued) setSteerNotes((n) => n.map((x) => (x.id === queued ? { ...x, now: true } : x)));
		else setSteerNotes((n) => [...n, { id: `steer-${Date.now()}`, text, at: Date.now(), now }]);
		// Now: the session stops and starts again on your note; next: the swarm reads it between steps.
		if (now) {
			await invoke("swarm_stop", { folder, run }).catch(() => {});
			void start(queued ? "" : text, true);
		} else await invoke("swarm_say", { folder, run, text }).catch((e) => setError(String(e)));
	};
	const lastCall = useMemo(() => events.reduce((t, e) => (e.kind === "tool" ? Math.max(t, e.at ?? 0) : t), 0), [events]);
	const queuedSteer = steerNotes.filter((n) => lastCall <= n.at);
	// The steps block of the agent at work: the latest one, while only your messages follow it.
	const liveBlock = useMemo(() => {
		if (!run) return -1;
		for (let i = chatBlocks.length - 1; i >= 0; i--) {
			const b = chatBlocks[i];
			if ("steps" in b) return i;
			if (b.e.kind !== "you") return -1;
		}
		return -1;
	}, [chatBlocks, run]);
	// How many of the latest messages are drawn: a long session (thousands of messages) would otherwise build every one
	// on each switch. "Show earlier messages" adds more; a new session starts from the latest again.
	const [drawn, setDrawn] = useState(CHAT_WINDOW);
	useEffect(() => setDrawn(CHAT_WINDOW), [viewing]);
	const firstDrawn = Math.max(0, chatBlocks.length - drawn);
	const chatList = useMemo(
		() =>
			chatBlocks.slice(firstDrawn).map((block, k) => ({ block, i: firstDrawn + k })).map(({ block, i }) =>
				// An open question shows once, as its question card after the history; its plain message is left out.
				("e" in block && block.e.kind === "ask" && run && questions.open.includes(block.e)) ||
				// A note still in the steering card's queue shows there, not twice.
				("e" in block && block.e.kind === "you" && queuedSteer.some((n) => n.text === block.e.text && (block.e.at ?? 0) >= n.at - 5000)) ? null : (
				// Off screen, a message skips layout and paint (`content-visibility`), so scrolling costs what's in view, not
				// the length of the chat; its last measured height holds its place.
				<div key={i} data-msg={i} className="fm-settle [contain-intrinsic-size:auto_96px] [content-visibility:auto]">
					{"steps" in block ? (
						(() => {
							const Card = RunCard ?? Steps;
							return (
								<Card
									steps={block.steps}
									running={i === liveBlock}
									// The plan item the run works on, by its text (bold markers and code ticks off).
									title={itemTitle(block.steps)}
									onPause={run ? () => void invoke("swarm_stop", { folder, run }) : undefined}
								/>
							);
						})()
					) : block.e.kind === "you" ? (
						<Message align="end">
							<MessageContent>
								{/* Your message: on the right, as wide as its text up to most of the chat, wrapping long words. */}
								<div className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl bg-muted px-3 py-2 text-foreground">{block.e.text}</div>
							</MessageContent>
						</Message>
					) : (
						<AgentMessage
							e={block.e}
							turn={turnEnds.get(i)}
							onReply={(text) => {
								setSay(text);
								toggleChat(true);
							}}
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
		[chatBlocks, firstDrawn, run, bugs, plan, questions.open, turnEnds, liveBlock, steerNotes, lastCall],
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
	// Near compaction (85% of the way there), the chat offers a fresh session for the next audit, or keeping on here.
	const [keepHere, setKeepHere] = useState<string | null>(null);
	const nearlyFull = Boolean(run && ctx && ctx.used >= ctx.compact_at * 0.85 && keepHere !== viewing);
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
											<span title={entryOf(i)?.notYet?.join("; ") || undefined} className={`mt-px grid size-3.5 shrink-0 place-items-center rounded border ${markOf(i) === "x" ? "border-emerald-500 bg-emerald-500 text-white" : markOf(i) === "~" ? "border-emerald-500 text-emerald-600" : markOf(i) === "!" ? "border-amber-500 text-amber-600" : ""}`}>
												{/* Drawn marks, so they sit centred at any zoom (text glyphs ride their baseline). */}
												{markOf(i) === "x" ? <Check className="size-2.5" strokeWidth={3.5} /> : markOf(i) === "~" ? (
													<svg viewBox="0 0 10 10" className="size-2.5" aria-hidden><path d="M5 1a4 4 0 0 1 0 8z" fill="currentColor" /></svg>
												) : markOf(i) === "!" ? (
													<svg viewBox="0 0 10 10" className="size-2.5" aria-hidden><path d="M5 2v3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="5" cy="7.9" r="1" fill="currentColor" /></svg>
												) : null}
											</span>
											<span className="min-w-0 flex-1">
												{/* The item's text is markdown (bold names, `code`), rendered inline. */}
												<ChatMarkdown className={`[&_p]:my-0 [&_p]:leading-5 ${markOf(i) === "x" ? "text-muted-foreground" : ""}`}>{i.text}</ChatMarkdown>
												{/* What the ledger still needs, once a proof exists: what it covers, what's missing, the review. */}
												{entryOf(i) && entryOf(i).status !== "proved" && entryOf(i).status !== "unproved" && entryOf(i).notYet?.length ? (
													<span className="mt-0.5 block text-[11px] text-muted-foreground">
														{entryOf(i).status === "partly proved" ? "Partly proved: " : ""}
														{entryOf(i).notYet.join("; ")}
													</span>
												) : null}
												{working && working.item === String(i.index) && activity ? (
													<span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground" title={activity.text}>
														<span className="truncate">
															<span className="font-medium" style={{ color: colorOf(working.role) }}>{roleName(working.role)}</span> · {activity.text}
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

	// The statements checklist (.formal/statements.md): claims in plain words, the maintainer's and the agents'.
	const addClaim = () => {
		const text = claim.trim();
		if (!text) return;
		invoke("control", { op: "add_statement", folder, args: { text } }).then(
			() => {
				setClaim("");
				setClaimError(null);
				refresh();
			},
			(e) => setClaimError(String(e)),
		);
	};
	// Statement work goes through the backend, which starts a stopped swarm just for it (and stops after).
	const statementOp = (op: string, args: Record<string, string>) => invoke<{ statements: Statement[] }>("control", { op, folder, args }).then((r) => r.statements);
	const afterStatement = (s: Statement[]) => setStatements(s);
	const setStatementMark = (id: string, mark: string) => void statementOp("mark_statement", { id, mark }).then(afterStatement, (e) => setClaimError(String(e)));
	const confirmStatement = (id: string) => void statementOp("confirm_statement", { id }).then(afterStatement, (e) => setClaimError(String(e)));
	// What you say a formalized statement should mean instead (empty: just try again).
	const [correcting, setCorrecting] = useState<{ id: string; text: string } | null>(null);
	const correctStatement = (id: string, text: string) =>
		void statementOp("correct_statement", { id, text }).then(
			(s) => {
				afterStatement(s);
				setCorrecting(null);
			},
			(e) => setClaimError(String(e)),
		);
	const removeStatement = (id: string) => void invoke<Statement[]>("swarm_remove_statement", { folder, id }).then(setStatements, (e) => setClaimError(String(e)));
	const proved = statements.filter((st) => st.mark === "x").length;
	const statementsList = (
		<div className="border-t p-2">
			<div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-muted-foreground">
				<span className="font-mono uppercase tracking-wider">Statements</span>
				{statements.length ? <span className="ml-auto tabular-nums">{proved}/{statements.length} proved</span> : null}
			</div>
			<form
				className="px-1 pb-1"
				onSubmit={(e) => {
					e.preventDefault();
					addClaim();
				}}
			>
				<input
					value={claim}
					onChange={(e) => {
						setClaim(e.target.value);
						setClaimError(null);
					}}
					placeholder="State something about the code…"
					aria-label="A claim about the code, for the swarm to prove or disprove"
					className="h-7 w-full rounded-md border bg-background px-2 text-[12px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
				/>
				{claimError ? <p className="px-1 pt-1 text-[11px] text-amber-600">{claimError}</p> : null}
			</form>
			{statements.length === 0 ? <p className="px-2 py-1 text-[12px] leading-[18px] text-muted-foreground">Claims you want proved or disproved, in plain words. They're kept in .formal/statements.md.</p> : null}
			<ul className="space-y-0.5 text-[12px] leading-[18px]">
				{statements.map((st) => (
					<li key={st.id} className="rounded-md px-2 py-1 hover:bg-muted/50">
						<div className="flex gap-2">
							<StatementMark mark={st.mark} />
							<span className="min-w-0 flex-1">
								<span className={st.mark === "x" || st.mark === "-" ? "text-muted-foreground" : ""}>{st.text}</span>
								<span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
									<span className="font-mono text-[10px]">{st.id}</span>
									{st.author === "you" ? <span>you</span> : <span className="font-medium" style={{ color: colorOf(st.author) }}>{roleName(st.author)}</span>}
									<span>· {MARK_LABEL[st.mark] ?? "open"}</span>
									{st.obligations.length ? <span className="tabular-nums">· {st.obligations.filter((o) => o.mark === "x").length}/{st.obligations.length} functions</span> : null}
								</span>
								{working && working.item.startsWith(`${st.id}.`) && activity ? (
									<span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground" title={activity.text}>
										<span className="truncate">
											<span className="font-medium" style={{ color: colorOf(working.role) }}>{roleName(working.role)}</span> · function {working.item.slice(st.id.length + 1)} · {activity.text}
										</span>
									</span>
								) : null}
								{st.details.length || st.obligations.length ? (
									<span className="mt-0.5 block space-y-px text-[11px] text-muted-foreground">
										{st.details.map((d, i) => (
											<span key={`d${i}`} className="block">{d}</span>
										))}
										{st.obligations.map((o, i) => (
											<span key={`o${i}`} className="flex items-start gap-1.5">
												<StatementMark mark={o.mark} small />
												<span className="min-w-0">{o.text}</span>
											</span>
										))}
									</span>
								) : null}
								{st.mark === "?" && st.details.some((d) => d.startsWith("kind: ")) ? (
									correcting?.id === st.id ? (
										<form
											className="mt-1 flex gap-1"
											onSubmit={(e) => {
												e.preventDefault();
												correctStatement(st.id, correcting.text);
											}}
										>
											<input autoFocus value={correcting.text} onChange={(e) => setCorrecting({ id: st.id, text: e.target.value })} placeholder="What it should mean…" aria-label={`What ${st.id} should mean`} className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring" />
											<button type="submit" className="rounded border bg-background px-1.5 text-[11px] hover:bg-muted">Send</button>
										</form>
									) : (
										<span className="mt-1 flex items-center gap-1">
											<span className="mr-0.5 text-[11px] text-violet-600">Is this what you meant?</span>
											<button type="button" onClick={() => confirmStatement(st.id)} className="rounded border bg-background px-1.5 text-[11px] hover:bg-muted">Yes</button>
											<button type="button" onClick={() => setCorrecting({ id: st.id, text: "" })} className="rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">Edit</button>
										</span>
									)
								) : st.mark === "?" && st.details.some((d) => d.startsWith("note: ")) ? (
									<span className="mt-1 flex gap-1">
										<button type="button" onClick={() => correctStatement(st.id, "")} className="rounded border bg-background px-1.5 text-[11px] hover:bg-muted">Try again</button>
										<button type="button" onClick={() => removeStatement(st.id)} className="rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">Remove</button>
									</span>
								) : st.mark === "?" && st.author !== "you" ? (
									<span className="mt-1 flex gap-1">
										<button type="button" onClick={() => setStatementMark(st.id, " ")} className="rounded border bg-background px-1.5 text-[11px] hover:bg-muted">Accept</button>
										<button type="button" onClick={() => removeStatement(st.id)} className="rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">Dismiss</button>
									</span>
								) : null}
							</span>
						</div>
					</li>
				))}
			</ul>
		</div>
	);

	const slot = useTitlebarSlot();
	// The website's chat page: the history runs the page's full height, under the tabs and the session controls.
	const chatPage = mode === "chat";
	const actionsSlot = useTitlebarSlot("fm-titlebar-actions");
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
	const nav = <NavGroup name={name} git={Boolean(scan?.git)} mode={mode} onMode={setMode} inBar={Boolean(slot)} compact={compact} />;
	// The working agent's context window, with its breakdown; in the Mac app it sits in the title bar.
	const ctxMenu = working && ctx && ctxPct !== null ? (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] tabular-nums text-muted-foreground outline-none hover:bg-background hover:text-foreground" title={`The ${working.role}'s context window`}>
				<span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
					<span className="block h-full rounded-full" style={{ width: `${ctxPct}%`, backgroundColor: colorOf(working.role) }} />
				</span>
				{ctxPct}%
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-[340px] max-w-[calc(100vw-1.5rem)] rounded-2xl border-0 bg-transparent p-0 shadow-lg">
				{(() => {
					// AffectUI's context window from the private UI package when it is checked out; the app's own otherwise.
					const Card = ContextCard ?? ContextPanel;
					return <Card role={working.role} color={colorOf(working.role)} use={ctx} onCompact={run ? () => invoke("swarm_compact", { folder, run }) : undefined} />;
				})()}
			</DropdownMenuContent>
		</DropdownMenu>
	) : null;
	// The run's spend against its cap, with the cap's menu; in the Mac app it sits in the title bar.
	// Who pays for the agents, in the title bar: your Claude plan (no spend or cap; its usage limit applies), or the spend
	// against its cap on a key. A run keeps the route it started with; a change applies at the next start.
	const costMenu = payingPlan ? (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 text-[11px] text-muted-foreground outline-none hover:text-foreground" title={`The agents run on ${provider === "codex" ? "Codex" : "Claude Code"} with your ${payingPlan}`}>
				{payingPlan}
				<ChevronDown className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" sideOffset={6} className="w-60 rounded-2xl p-1.5 shadow-lg [&_[role=menuitem]]:rounded-lg [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-2">
				<DropdownMenuItem onSelect={() => choosePlan("claude-code")} disabled={!claudePlan} className="text-[13px]">
					{claudePlan ?? "Claude plan"}
					{provider === "claude-code" ? <Check className="ml-auto size-3.5" /> : null}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => choosePlan("codex")} disabled={!codexReady} title={codexReady ? "Codex, signed in with ChatGPT" : "Sign in to Codex with ChatGPT first (`codex login`)"} className="text-[13px]">
					ChatGPT plan
					{provider === "codex" ? <Check className="ml-auto size-3.5" /> : null}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => navigate("/settings?section=models")} className="text-[13px]">A key instead…</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	) : (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 text-[11px] tabular-nums text-muted-foreground outline-none hover:text-foreground" title="Spending cap">
				{run || viewing ? `$${spent.toFixed(2)} / $${budget}` : `Budget $${budget}`}
				<ChevronDown className="size-3" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" sideOffset={6} className="w-60 rounded-2xl p-1.5 shadow-lg [&_[role=menuitem]]:rounded-lg [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-2">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Stop the swarm at</DropdownMenuLabel>
				{BUDGETS.map((b) => (
					<DropdownMenuItem
						key={b}
						disabled={Boolean(run) && b <= spent}
						onSelect={() => {
							setBudget(b);
							store.set(budgetKey, String(b));
							if (run) void invoke("swarm_set_budget", { folder, run, usd: b });
						}}
						className="text-[13px] tabular-nums"
					>
						${b}
						{b === budget ? <Check className="ml-auto size-3.5" /> : null}
					</DropdownMenuItem>
				))}
				{claudePlan || codexReady ? (
					<>
						<DropdownMenuSeparator />
						{claudePlan ? <DropdownMenuItem onSelect={() => choosePlan("claude-code")} className="text-[13px]">Use my {claudePlan}</DropdownMenuItem> : null}
						{codexReady ? <DropdownMenuItem onSelect={() => choosePlan("codex")} className="text-[13px]">Use my ChatGPT plan</DropdownMenuItem> : null}
						{run ? <p className="px-2 pb-1.5 text-[11px] text-muted-foreground">This run keeps its key; Stop and Resume to switch.</p> : null}
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
	// What the right pane can show: the open one is highlighted, and clicking it again closes the pane.
	const paneTools = (
		<span className="ml-1 inline-flex shrink-0 items-center gap-0.5">
			{PANE_VIEWS.map(({ id, label, icon: Icon }) => (
				<button
					key={id}
					type="button"
					aria-pressed={mode === id}
					title={label}
					aria-label={label}
					onClick={() => setMode(id)}
					className={`inline-flex size-7 items-center justify-center rounded-md ${mode === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground"}`}
				>
					<Icon className="size-4" />
				</button>
			))}
		</span>
	);
	// The conversation with the swarm: its sessions, budget and Stop on a gray bar, the messages and composer under it.
	const chatPanel = (
		<>
				{/* On the website's chat page the sessions sit at the page's top left and New chat at its top right, over the
				    history; floating over the canvas they head the chat. */}
				<div className={chatPage ? `pointer-events-none absolute inset-x-0 top-3 z-30 flex h-8 items-center gap-1 pr-3 *:pointer-events-auto ${slot ? "pl-3" : "pl-12"}` : "flex h-8 shrink-0 items-center gap-1 pl-3 pr-0.5"}>
					{chatPage ? null : (
						<button type="button" onClick={() => pickSession("new")} aria-label="New chat" title="New chat" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground">
							<Plus className="size-3.5" />
						</button>
					)}
					{renaming !== null ? (
						// The box hugs its text: a hidden copy of it sizes the grid cell the input fills, so it grows as you type.
						<span className={`inline-grid min-w-0 ${chatPage ? (slot ? "max-w-[60%]" : "max-w-[max(9rem,calc(50%-9rem))]") : "flex-1"}`}>
						<span aria-hidden className="invisible col-start-1 row-start-1 h-7 overflow-hidden whitespace-pre px-2 leading-7">{renaming || " "}</span>
						<input
							autoFocus
							value={renaming}
							onChange={(e) => setRenaming(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") rename(renaming);
								if (e.key === "Escape") setRenaming(null);
							}}
							onBlur={() => rename(renaming)}
							aria-label="Chat name"
							// No built-in width (about 20 characters): the hidden copy of the text sizes the box.
							size={1}
							className="col-start-1 row-start-1 h-7 w-full min-w-0 rounded-md border bg-background px-2 text-foreground outline-none"
						/>
						</span>
					) : (
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger className={`flex min-w-0 items-center gap-1 rounded-md text-left text-[14px] text-muted-foreground outline-none hover:text-foreground ${chatPage ? (slot ? "max-w-[60%]" : "max-w-[max(9rem,calc(50%-9rem))]") : "flex-1"}`} title={`${title} — switch sessions (double-click to rename)`} onDoubleClick={() => viewing && setRenaming(title)}>
							<span className="truncate">{title}</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" sideOffset={6} className="w-72 rounded-2xl p-1.5 shadow-lg [&_[role=menuitem]]:rounded-lg [&_[role=menuitem]]:px-2.5 [&_[role=menuitem]]:py-2">
							<DropdownMenuItem onSelect={() => pickSession("new")} className="text-[13px]">
								<Plus className="size-3.5" /> Start new chat
							</DropdownMenuItem>
							{viewing ? (
								<DropdownMenuItem onSelect={() => setRenaming(title)} className="text-[13px]">
									<Pencil className="size-3.5" /> Rename
								</DropdownMenuItem>
							) : null}
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sessions in {name}</DropdownMenuLabel>
							{/* The session you're reading stays highlighted, with a check on the right. */}
							{/* The sessions scroll inside the card; an edge with more chats past it fades out. */}
							<FadeScroll className="max-h-72 py-1">
							{sessions.map((x, i) => (
								<DropdownMenuItem key={x.run} onSelect={() => pickSession(x.run)} aria-current={x.run === viewing} className={`text-[13px] ${x.run === viewing ? "bg-accent text-accent-foreground" : ""}`}>
									<span className="truncate">{x.title || (x.run === "swarm" ? "Main session" : `Session ${sessions.length - i}`)}</span>
									{runs.includes(x.run) ? <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">running</span> : null}
									{x.run === viewing ? <Check className={`size-3.5 shrink-0 ${runs.includes(x.run) ? "" : "ml-auto"}`} /> : null}
								</DropdownMenuItem>
							))}
							</FadeScroll>
						</DropdownMenuContent>
					</DropdownMenu>
					)}
					{actionsSlot ? null : ctxMenu}
					{/* On a plan the model picks it (a GPT model the ChatGPT plan, a Claude one the Claude plan); a key shows its spending cap. */}
					{actionsSlot || payingPlan ? null : costMenu}
					{/* Hiding the chat only applies to it floating over the canvas, not to the chat page. */}
					{slot || mode === "chat" ? null : (
						<button type="button" onClick={() => toggleChat(false)} title="Hide the chat" aria-label="Hide the chat" className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
							<ChevronDown className="size-3.5" />
						</button>
					)}
					{chatPage ? (
						<button type="button" onClick={() => pickSession("new")} aria-label="New chat" title="New chat" className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-background/90 px-3 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
							<Plus className="size-3.5" /> New chat
						</button>
					) : null}
					{/* Settings and the bell, which the other views show at their top right. */}
					{chatPage && !slot ? <span className="flex shrink-0 items-center gap-2">{actions}</span> : null}
				</div>
				{/* Corners nest: the panel 28px, inset 4px; this card 24px; the composer 16px, inset 8px. */}
				{/* On the chat page it has no card around it; floating over the canvas it does. */}
				<div className={`mt-1 flex min-h-0 flex-1 flex-col overflow-hidden ${slot || mode === "chat" ? "" : "rounded-[24px] border bg-card"}`}>
				<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={chat}
					onScroll={(e) => {
						const el = e.currentTarget;
						atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
						setAway(!atBottom.current);
					}}
					// The history fades out at its top and bottom edges as it scrolls under the header and into the composer.
					className={`min-h-0 flex-1 space-y-3.5 overflow-y-auto pb-8 pl-6 pr-3 text-[13px] ${chatPage ? "pt-20 [mask-image:linear-gradient(to_bottom,transparent_3rem,black_5.5rem,black_calc(100%-2rem),transparent)]" : "pt-8 [mask-image:linear-gradient(to_bottom,transparent,black_2rem,black_calc(100%-2rem),transparent)]"}`}
				>
					{shown.length === 0 && !run && !loadingHistory ? <p className="text-muted-foreground">Talk to the agents here. Before a run, what you write is the swarm's focus and ↑ starts it; while it runs, they read your messages before their next turn.</p> : null}
					{firstDrawn > 0 ? (
						<button type="button" onClick={() => setDrawn((n) => n + CHAT_WINDOW)} className="mx-auto block rounded-full border px-3 py-1 text-muted-foreground hover:text-foreground">
							Show earlier messages ({firstDrawn})
						</button>
					) : null}
					{chatList}
					{/* The agents' open questions, in the history after the latest message (not pinned over it). */}
					{run ? (
						<QuestionStack
							asks={questions.open}
							onSend={(answers) => {
								questions.markAnswered(answers.map((a) => a.ask));
								void (async () => {
									for (const a of answers) await invoke("swarm_say", { folder, run, text: a.text }).catch((e) => setError(String(e)));
								})();
							}}
							onSkip={questions.markAnswered}
							onWrite={(ask) => {
								questions.markAnswered([ask]);
								setSay(`About ${parseAsk(ask.text).question.match(/\*\*([^*]+)\*\*/)?.[1] ?? "your question"}: `);
							}}
						/>
					) : null}
					{/* While an agent works: its name, and its current task shimmering until its next words. */}
					{run && working ? (
						<p className="flex items-center gap-2 text-[14px] text-muted-foreground">
							<span className="fm-text-shimmer truncate">{working.text}</span>
						</p>
					) : null}
					{finished ? <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">Finished: {finished.text}</p> : null}
					{nearlyFull && ctx ? (
						<div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card px-3 py-2.5">
							<span className="min-w-0 flex-1 text-muted-foreground">
								This chat's context is {Math.round((ctx.used / ctx.window) * 100)}% full. Start a new chat for the next audit?
							</span>
							<button type="button" onClick={() => pickSession("new")} className="btn-dark h-7 shrink-0 rounded-full px-3">
								Start new chat
							</button>
							<button type="button" onClick={() => setKeepHere(viewing)} className="h-7 shrink-0 rounded-full border px-3 text-muted-foreground hover:text-foreground">
								Keep going here
							</button>
						</div>
					) : null}
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

				<div className="shrink-0 space-y-2 p-2">
					{error ? <p className="text-xs text-red-600">{error}</p> : null}
					{/* Your notes to the agent at work, until it takes them in at its next step; Now interrupts with one. */}
					{run && queuedSteer.length ? (
						<div className="flex flex-wrap items-center gap-1.5 px-1 text-[12px]">
							<span className="text-muted-foreground">Queued for the next step</span>
							{queuedSteer.map((n) => (
								<span key={n.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1">
									<span className="truncate">{n.text}</span>
									<button type="button" onClick={() => void steerSend(n.text, true, n.id)} title="Interrupt the agent with this note now (⌘↵)" className="shrink-0 rounded-full px-1.5 text-muted-foreground hover:bg-background hover:text-foreground">
										Now
									</button>
								</span>
							))}
						</div>
					) : null}
					{/* The Swarm page's composer: steer while it runs; before that, what you type is its focus and ↑ starts it. */}
					{(() => {
						// AffectUI's composer from the private UI package when it is checked out; the app's own otherwise.
						const Box = (Composer ?? ChatComposer) as typeof ChatComposer;
						return (
					// While it runs, ↵ queues what you typed for the agent's next step and ⌘↵ interrupts it with it now.
					<div
						className="contents"
						onKeyDownCapture={(e) => {
							if (!run || e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !say.trim()) return;
							e.preventDefault();
							e.stopPropagation();
							const text = say.trim();
							setSay("");
							void steerSend(text, true);
						}}
					>
					<Box
						compact
						rounded="rounded-2xl"
						value={run ? say : goal}
						onChange={(e) => (run ? setSay(e.target.value) : setGoal(e.target.value))}
						onSubmit={() => void submit()}
						// One button: ↑ starts and sends; while it runs, an empty box
						// makes it Stop, which stops the session.
						onStop={() => void invoke("swarm_stop", { folder, run })}
						isLoading={Boolean(run)}
						allowEmpty={!run}
						sendClassName="btn-dark !px-0"
						sendDisabled={!run && Boolean(ownKey) && !hasKey}
						sendTitle={run ? (say.trim() ? "Send" : "Stop the session") : ownKey && !hasKey ? `Add your ${ownKey} key in Settings first` : plan.some((i) => i.mark === " ") ? "Resume the swarm" : "Start the swarm"}
						modelPicker={{
							value: pickedModel,
							options: pickable,
							disabled: Boolean(run),
							onChange: (m) => {
								// On a plan, a GPT model moves the agents to your ChatGPT plan and a Claude one back to your Claude plan.
								if (payingPlan) choosePlan(CODEX_MODELS.some((c) => c.value === m) ? "codex" : "claude-code");
								setModel(m);
								store.set("fm:model", m);
							},
						}}
						// Claude Code's thinking effort for the agents' turns; Default leaves it to Claude Code. Takes effect at the
						// next turn, so it can change while the swarm runs.
						effortPicker={provider === "claude-code" || provider === "codex" ? {
							value: effort,
							options: EFFORTS,
							onChange: (v) => {
								setEffort(v);
								store.set("fm:effort", v);
							},
						} : undefined}
						placeholder={run ? "Talk to the agents: ↵ for their next step, ⌘↵ to interrupt now…" : "What should the swarm focus on? (optional) ↑ starts it"}
						context={
							<span className="inline-flex items-center gap-1.5">
								<span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12px] font-medium text-secondary-foreground" title={folder}><Folder className="size-3 shrink-0" />{name}</span>
							</span>
						}
						extra={run ? (
							<button type="button" onClick={() => void draft()} disabled={drafting} title="Draft a reply for me" className="inline-flex h-7 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
								<WandSparkles className={`size-3.5 ${drafting ? "animate-pulse" : ""}`} />
								{/* A narrow composer keeps just the wand. */}
								<span className="[@container(max-width:440px)]:hidden">{drafting ? "Drafting…" : "Draft reply"}</span>
							</button>
						) : null}
					/>
					</div>
						);
					})()}
				</div>
				</div>
		</>
	);

	// What the page shows besides the chat: the canvas, Code, Proofs or Bugs. The Mac app opens it in the right
	// pane; the web shows it full page with the chat floating over the canvas.
	const modeViews = (
		<>
		{/* Swarm shows the canvas; Code and Audit replace it. The name and the controls stay in every mode. */}
		{canvas ? (
			<SwarmCanvas
				state={board}
				fill
				local
				repo={folder}
				actions={actions}
				// An agent's name tag opens the chat addressed to it.
				onTalk={(role) => {
					toggleChat(true);
					// In the Mac app the chat is its own page.
					if (slot) setMode("chat");
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
					// The Mac app's pane has no floating Plan card: the plan is this panel, with its counts.
					title: slot ? "Plan" : "Roadmap",
					note: slot ? `${plan.length ? `${done}/${plan.length}` : ""}${entryUnits.length ? ` · ${inPlan.size}/${entryUnits.length} entry points` : ""}` : undefined,
					height: 640,
					node: <div className="min-h-0 flex-1 overflow-y-auto">{planList}{statementsList}{entryList}</div>,
				}}
				// The folder's git tree has a card of its own beside the plan: where the swarm works, HEAD and its
				// uncommitted proofs.
				beside={scan?.git ? { title: "Git", width: 440, node: <GitTree folder={folder} invoke={invoke} working={Boolean(run)} flat /> } : undefined}
			/>
		) : (
			<div className="relative h-full w-full bg-background">
				<div className="absolute right-3 top-3 flex items-center gap-2">{actions}</div>
			</div>
		)}
		{mode === "swarm" && !slot ? (
			<section className={`pointer-events-auto absolute bottom-3 left-3 z-10 flex w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border bg-muted/80 p-1 shadow-pop backdrop-blur ${planOpen ? "max-h-[calc(100%-var(--fm-top)-1rem)]" : ""}`}>
				<button type="button" onClick={() => setPlanOpen(!planOpen)} aria-expanded={planOpen} className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-left">
					<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Plan</span>
					<span className="text-[11px] text-muted-foreground">{plan.length ? `${done}/${plan.length}` : ""}{entryUnits.length ? ` · ${inPlan.size}/${entryUnits.length} entry points` : ""}</span>
					<ChevronDown className={`ml-auto size-3.5 text-muted-foreground transition-transform ${planOpen ? "rotate-180" : ""}`} />
				</button>
				{planOpen ? <div className="min-h-0 overflow-y-auto rounded-xl border bg-card">{planList}{statementsList}{entryList}</div> : null}
			</section>
		) : null}
		{mode === "code" ? (
			// The page is the editor: the file fills the whole page under the tabs.
			<div className="absolute inset-x-0 bottom-0 top-[var(--fm-top)] z-10 flex min-h-0 flex-col">
				{file ? (
					<>
						<div className="flex h-8 shrink-0 items-center gap-2 border-y px-4">
							<span className="-ml-1.5 flex shrink-0 items-center">
								<button type="button" onClick={() => travel(trail.at - 1)} disabled={!canBack} title={canBack ? `Back to ${trail.places[trail.at - 1].label} (⌘[)` : "Back (⌘[)"} aria-label="Back" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
									<ArrowLeft className="size-3.5" />
								</button>
								<button type="button" onClick={() => travel(trail.at + 1)} disabled={!canForward} title={canForward ? `Forward to ${trail.places[trail.at + 1].label} (⌘])` : "Forward (⌘])"} aria-label="Forward" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
									<ArrowRight className="size-3.5" />
								</button>
								<DropdownMenu>
									<DropdownMenuTrigger disabled={trail.places.length < 2} title="Where you've been" aria-label="History" className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30">
										<History className="size-3.5" />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto [&_[role=menuitem]]:py-1 [&_[role=menuitem]]:text-[12px]">
										<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">History</DropdownMenuLabel>
										{trail.places
											.map((p, i) => ({ p, i }))
											.reverse()
											.map(({ p, i }) => (
												<DropdownMenuItem key={i} onSelect={() => travel(i)} className={`gap-2 ${i > trail.at ? "text-muted-foreground" : ""}`}>
													<span className="w-3 shrink-0">{i === trail.at ? <Check className="size-3" /> : null}</span>
													<span className="truncate font-mono">{p.label}</span>
													<span className="ml-auto max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground" title={p.path}>
														{p.path.split("/").slice(0, -1).pop() ?? ""}
													</span>
												</DropdownMenuItem>
											))}
									</DropdownMenuContent>
								</DropdownMenu>
							</span>
							<Breadcrumbs root={name} path={file.path} files={tree} onOpen={view} />
							<span className="ml-auto flex items-center gap-1">
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
								{caretAt && !vim ? (
									<span className="mr-1 font-mono text-[11px] text-muted-foreground/70">
										Ln {caretAt.line + 1}, Col {caretAt.col + 1}
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
									onCaret={vim ? undefined : setCaretAt}
									gutter={solProofs.data ? proofGutter(solProofs.data, solProofs.functions, pickProof) : undefined}
									band={pickedFn && solProofs.data ? { from: pickedFn.line - 1, to: pickedFn.endLine - 1, text: fnStatus(pickedFn, solProofs.data.theorems).text } : null}
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
											<span className="text-foreground">Normal</span>
											<span>{lastSearch.current ? `/${lastSearch.current}` : ""}</span>
											<span className="ml-auto">{cursor.line + 1}:{cursor.col + 1}</span>
										</>
									)}
								</div>
							) : null}
						</div>
						{proofsOn && !file.url && file.path.endsWith(".sol") ? <ProofRail key={file.path} proofs={solProofs} selected={proofFn} onSelect={pickProof} onOpenFile={view} onOpenDef={(f) => void openLeanDef(f)} /> : null}
						</div>}
					</>
				) : (
					<p className="m-auto text-sm text-muted-foreground">Pick a file in the sidebar.</p>
				)}
			</div>
		) : null}
		{mode === "bugs" ? (
			<BugsView
				folder={folder}
				files={tree}
				invoke={invoke}
				bugs={bugs}
				openBug={openBug}
				setOpenBug={setOpenBug}
				withPoc={withPoc}
				onOpenFile={view}
				reload={reload}
				// Queued for the swarm's auditor; the backend starts a stopped swarm just for it (and stops after).
				onTriage={async (path) => {
					await invoke("control", { op: "triage", folder, args: { path, run: viewing && viewing !== "new" ? viewing : "swarm" } });
				}}
			/>
		) : null}
		{mode === "audit" ? (
			<div data-fm-proofs className="pointer-events-auto absolute bottom-3 left-3 right-3 top-[var(--fm-top)] z-10 flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-muted/60 p-1">
				<AuditView folder={folder} scan={scan} invoke={invoke} onOpenFile={view} reload={reload} />
			</div>
		) : null}
		</>
	);

	if (slot) {
		return (
			<div ref={root} className="relative flex h-full min-h-0 flex-1">
				{/* The folder's tab names it, in its own place among the tabs; only the page's actions go to the title bar. */}
				{actionsSlot ? createPortal(<>{ctxMenu}{payingPlan ? null : costMenu}{paneTools}</>, actionsSlot) : null}
				{mode === "chat" ? (
					// The chat as the page: one centred column, as wide as reads well.
					<div className="relative flex min-h-0 min-w-0 flex-1 justify-center px-4 pb-3 pt-2">
						<div className="flex min-h-0 w-full max-w-3xl flex-col">{chatPanel}</div>
					</div>
				) : (
					// The view in the middle (Canvas, Proofs, Bugs, Code).
					<div className="relative min-w-0 flex-1" style={{ "--fm-top": "0px" } as React.CSSProperties}>
						<div className="absolute inset-0 flex flex-col overflow-hidden">{modeViews}</div>
					</div>
				)}
			</div>
		);
	}

	return (
		// In the Mac app the controls live in the title bar, so the page starts at the top.
		<div ref={root} className="relative flex h-full min-h-0 flex-1" style={{ "--fm-top": slot ? "0px" : "3.5rem" } as React.CSSProperties}>
			{/* The canvas, as on the Swarm page, with the plan, files and bugs floating over it as one accordion. */}
			<div className="absolute inset-0 flex flex-col overflow-hidden">
				{mode === "chat" ? (
					// The chat as the page: one centred column under the tabs, as wide as reads well.
					<div className="flex min-h-0 flex-1 justify-center px-4 pb-3">
						<div className="flex min-h-0 w-full max-w-3xl flex-col">{chatPanel}</div>
					</div>
				) : (
					modeViews
				)}
				{nav}
			</div>

			{/* The chat: start and steer the swarm, the plan, and the agents' messages. */}
			{/* The chat floats over the canvas on the right: a gray title bar with the run's controls, the white chat inside.
			    The strip above it stays free for the Live pill and the bell. */}
			{/* Talk to the agents: floats on the right of the Swarm canvas, the Plan's counterpart on the left. */}
			{canvas ? (
				<>
					{/* One box: the chat when open, the round button at its corner when closed. It switches at once, no animation. */}
					<aside
						ref={chatBox}
						className={`pointer-events-auto absolute bottom-3 right-3 z-20 overflow-hidden border shadow-pop backdrop-blur ${chatOpen ? "rounded-[28px] bg-muted/80" : "cursor-pointer rounded-[24px] border-transparent bg-foreground hover:opacity-90"}`}
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
					{!chatOpen && unread ? <span className="pointer-events-none absolute bottom-[3.25rem] right-3 z-30 grid h-5 min-w-5 translate-x-1 place-items-center fm-badge rounded-full border-2 border-background bg-red-500 px-1 text-[10px] font-semibold tabular-nums text-white">{unread > 99 ? "99+" : unread}</span> : null}
				</>
			) : null}
		</div>
	);
}
