import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, RotateCw, Save, SquareArrowOutUpRight, Undo2 } from "lucide-react";
import type { Bridge, Formal } from "./swarm-panel";
import { fnStatus } from "./swarm-panel";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SpecificationCode } from "./specification-code";

type Position = { line: number; character: number };
type Diagnostic = { range: { start: Position; end: Position }; severity?: number; message: string };
type State = { version: number; diagnosticsVersion: number | null; diagnostics: Diagnostic[]; processing: unknown[] | null; error: string | null };
type Opened = { text: string; version: number; project: string; toolchain: string };
type Goal = { version: number; goals: { rendered: string; goals: string[] } | null; term: { goal: string } | null };
type Symbol = { name: string; selectionRange?: { start: Position }; range?: { start: Position }; children?: Symbol[] };
type Spec = { id: string; title: string; signature: string; assumptions: string[]; solidity: { path: string; line: number }; lean: { path: string; line: number } };
type Draft = { text: string; original: string };

const drafts = new Map<string, Draft>();
const key = (folder: string, path: string) => `fm:proof-draft:${folder}:${path}`;
function readDraft(id: string): Draft | null {
	try {
		return drafts.get(id) ?? JSON.parse(sessionStorage.getItem(id) ?? "null");
	} catch {
		return drafts.get(id) ?? null;
	}
}
function writeDraft(id: string, draft: Draft | null) {
	if (draft) drafts.set(id, draft);
	else drafts.delete(id);
	try {
		if (draft) sessionStorage.setItem(id, JSON.stringify(draft));
		else sessionStorage.removeItem(id);
	} catch {
		/* Memory keeps the draft for this app session. */
	}
}

/** The LSP position (0-based line, UTF-16 column) of an offset in the buffer. */
export function cursorPosition(text: string, offset: number): Position {
	const prefix = text.slice(0, offset);
	const last = prefix.lastIndexOf("\n");
	return { line: prefix.split("\n").length - 1, character: prefix.length - last - 1 };
}
export function positionOffset(text: string, p: Position): number {
	const lines = text.split("\n");
	return lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + Math.min(p.character, (lines[p.line] ?? "").length);
}

// One queue for every editor's open/change/close, so an old close can't race a new open of the same file.
let leanQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const result = leanQueue.catch(() => {}).then(operation);
	leanQueue = result.catch(() => {});
	return result;
}

const section = "px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground";
const tool = "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** A goal as Lean prints it: hypotheses, then the target after `⊢`, which is what to prove. */
function GoalCard({ goal, n, of }: { goal: string; n: number; of: number }) {
	const lines = goal.split("\n");
	const at = lines.findIndex((l) => l.startsWith("⊢"));
	const hyps = at < 0 ? lines : lines.slice(0, at);
	const target = at < 0 ? [] : lines.slice(at);
	return (
		<div className="mx-2 mb-2 overflow-hidden rounded-lg border bg-card">
			{of > 1 ? <p className="border-b px-2.5 py-1 text-[10px] text-muted-foreground">Goal {n} of {of}</p> : null}
			<pre className="overflow-x-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11.5px] leading-5">
				{hyps.length ? <span className="block text-muted-foreground">{hyps.join("\n")}</span> : null}
				{target.length ? <span className="block font-medium text-foreground">{target.join("\n")}</span> : null}
			</pre>
		</div>
	);
}

/**
 * A Lean file in Code (the Mac app): an editor whose buffer goes to the project's `lake serve`, and beside it what Lean
 * says at the cursor, as its Infoview does: the goals, the file's messages, and the Solidity the theorem there is about.
 */
export function ProofWorkspace({ folder, path, invoke, onOpenFile, initialLine = 1, formal }: { folder: string; path: string; invoke: Bridge["invoke"]; onOpenFile: (path: string, line?: number) => void; initialLine?: number; /** The last Solidity file's coverage: which of its functions the theorem at the cursor names. */ formal?: Formal | null }) {
	const [opened, setOpened] = useState<Opened | null>(null);
	const [text, setText] = useState("");
	const [original, setOriginal] = useState("");
	const [synced, setSynced] = useState<{ text: string; version: number } | null>(null);
	const [state, setState] = useState<State | null>(null);
	const [goal, setGoal] = useState<Goal | null>(null);
	const [position, setPosition] = useState<Position>({ line: Math.max(0, initialLine - 1), character: 0 });
	const [error, setError] = useState<string | null>(null);
	const [goalError, setGoalError] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState(0);
	const [specs, setSpecs] = useState<Spec[]>([]);
	const [specCode, setSpecCode] = useState<string | null>(null);
	const [symbols, setSymbols] = useState<Symbol[]>([]);
	const editor = useRef<HTMLTextAreaElement>(null);
	const layer = useRef<HTMLPreElement>(null);
	const highlighted = useHighlightedCode(text, "lean");
	const jumpTo = useRef<Position | null>({ line: Math.max(0, initialLine - 1), character: 0 });
	const dirty = opened !== null && text !== original;
	const current = synced?.text === text && state?.version === synced.version && state.diagnosticsVersion === synced.version;
	const checking = !current || state?.processing === null || (state?.processing?.length ?? 0) > 0;
	const diagnostics = useMemo(() => (current ? (state?.diagnostics ?? []) : []), [current, state]);
	const errors = diagnostics.filter((d) => d.severity === 1).length;
	const warnings = diagnostics.filter((d) => d.severity === 2).length;

	useEffect(() => {
		let active = true;
		void invoke<Spec[]>("proof_specs", { folder }).then(
			(s) => active && setSpecs(s.filter((x) => x.lean.path === path)),
			() => active && setSpecs([]),
		);
		return () => {
			active = false;
		};
	}, [folder, path, invoke]);
	useEffect(() => {
		let active = true;
		setOpened(null);
		setSynced(null);
		setState(null);
		setGoal(null);
		setError(null);
		setSymbols([]);
		void enqueue(() => invoke<Opened>("lean_open", { folder, path })).then(
			(data) => {
				if (!active) return;
				const draft = readDraft(key(folder, path));
				setOpened(data);
				setText(draft?.text ?? data.text);
				setOriginal(draft?.original ?? data.text);
				setSynced({ text: data.text, version: data.version });
			},
			(e) => active && setError(String(e)),
		);
		return () => {
			active = false;
			void enqueue(() => invoke("lean_close", { folder, path })).catch(() => {});
		};
	}, [folder, path, invoke, generation]);
	// Edits go to Lean a moment after typing stops, each as the next version of the document.
	useEffect(() => {
		if (!opened || synced?.text === text) return;
		let active = true;
		setGoal(null);
		const timer = setTimeout(() => {
			void enqueue(() => invoke<number>("lean_sync", { folder, path, text })).then(
				(version) => {
					if (active) {
						setSynced({ text, version });
						setError(null);
					}
				},
				(e) => active && setError(String(e)),
			);
		}, 250);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [folder, path, text, opened, synced, invoke]);
	useEffect(() => {
		if (!opened) return;
		let active = true;
		let outstanding = false;
		const poll = async () => {
			if (outstanding) return;
			outstanding = true;
			try {
				const value = await invoke<State>("lean_state", { folder, path });
				if (active) setState(value);
			} catch (e) {
				if (active) setError(String(e));
			} finally {
				outstanding = false;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 700);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [folder, path, opened, invoke]);
	useEffect(() => {
		if (!synced || synced.text !== text || !opened) return;
		let active = true;
		setGoalError(null);
		const timer = setTimeout(() => {
			void invoke<Goal>("lean_goal", { folder, path, ...position, version: synced.version }).then(
				(g) => active && setGoal(g),
				(e) => active && setGoalError(String(e)),
			);
		}, 200);
		return () => {
			active = false;
			clearTimeout(timer);
		};
		// The goals are asked again when the cursor moves (its line or column) or checking finishes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder, path, position.line, position.character, synced, text, opened, invoke, checking]);
	useEffect(() => {
		if (!opened || !synced || checking) return;
		let active = true;
		void invoke<Symbol[]>("lean_symbols", { folder, path, version: synced.version }).then(
			(s) => active && setSymbols(s),
			() => {},
		);
		return () => {
			active = false;
		};
	}, [folder, path, opened, synced, checking, invoke]);
	useEffect(() => {
		if (opened && jumpTo.current && editor.current) {
			jump(jumpTo.current);
			jumpTo.current = null;
		}
	}, [opened]);

	function jump(p: Position) {
		setPosition(p);
		const el = editor.current;
		if (!el) return;
		const offset = positionOffset(el.value, p);
		el.focus();
		el.setSelectionRange(offset, offset);
		const lineHeight = 24;
		el.scrollTop = Math.max(0, p.line * lineHeight - el.clientHeight / 3);
	}
	async function save() {
		setSaving(true);
		setError(null);
		const snapshot = text;
		try {
			await enqueue(() => invoke("lean_save", { folder, path, text: snapshot, expected: original }));
			setOriginal(snapshot);
			writeDraft(key(folder, path), null);
			setSavedAt(Date.now());
		} catch (e) {
			setError(String(e));
		} finally {
			setSaving(false);
		}
	}
	function revert() {
		writeDraft(key(folder, path), null);
		setGeneration((g) => g + 1);
	}
	async function restart() {
		try {
			await enqueue(() => invoke("lean_restart", { folder, path }));
			setGeneration((g) => g + 1);
		} catch (e) {
			setError(String(e));
		}
	}

	// The theorem the cursor is in (the last one starting at or above it), and the Solidity functions it names.
	const here = useMemo(() => {
		if (!formal) return null;
		const at = formal.theorems.map((t, i) => ({ t, i })).filter(({ t }) => t.file === path && t.line - 1 <= position.line).sort((a, b) => b.t.line - a.t.line)[0];
		if (!at) return null;
		return { theorem: at.t, functions: formal.functions.filter((f) => f.theorems.includes(at.i)) };
	}, [formal, path, position.line]);
	const byLine = useMemo(() => {
		const m = new Map<number, Diagnostic[]>();
		for (const d of diagnostics) m.set(d.range.start.line, [...(m.get(d.range.start.line) ?? []), d]);
		return m;
	}, [diagnostics]);
	const lines = text.split("\n");
	const goals = goal?.goals?.goals ?? null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11px]" aria-live="polite">
				{error || state?.error ? (
					<span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400">
						<span className="size-1.5 rounded-full bg-red-500" />
						Lean isn't running
					</span>
				) : !opened ? (
					<span className="inline-flex items-center gap-1.5 text-muted-foreground">
						<Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
						Starting Lean
					</span>
				) : checking ? (
					<span className="inline-flex items-center gap-1.5 text-muted-foreground">
						<Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
						Checking
					</span>
				) : errors ? (
					<span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400">
						<span className="size-1.5 rounded-full bg-red-500" />
						{errors} error{errors === 1 ? "" : "s"}
					</span>
				) : (
					<span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
						<Check className="size-3" />
						Checks
					</span>
				)}
				{warnings && !checking ? <span className="text-amber-700 dark:text-amber-400">{warnings} warning{warnings === 1 ? "" : "s"}</span> : null}
				{dirty ? (
					<span className="inline-flex items-center gap-1 text-muted-foreground">
						<span className="size-1.5 rounded-full bg-foreground/60" />
						Unsaved
					</span>
				) : Date.now() - savedAt < 4000 ? (
					<span className="text-muted-foreground">Saved</span>
				) : null}
				<span className="font-mono text-muted-foreground/70">
					Ln {position.line + 1}, Col {position.character + 1}
				</span>
				<span className="ml-auto flex items-center gap-0.5">
					{symbols.length ? (
						<DropdownMenu>
							<DropdownMenuTrigger className={tool} title="Go to a declaration">
								Declarations
								<ChevronDown className="size-3" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
								{symbols.map((s, i) => (
									<DropdownMenuItem
										key={i}
										className="font-mono text-[11px]"
										onSelect={() => {
											const p = s.selectionRange?.start ?? s.range?.start;
											if (p) jump(p);
										}}
									>
										{s.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					<button type="button" className={tool} disabled={!dirty || saving} onClick={() => void save()} title="Save (⌘S)">
						<Save className="size-3" />
						{saving ? "Saving" : "Save"}
					</button>
					<button type="button" className={tool} disabled={!dirty || saving} onClick={revert} title="Discard the draft and read the file again">
						<Undo2 className="size-3" />
						Revert
					</button>
					<button type="button" className={tool} disabled={saving} onClick={() => void restart()} title={`Restart Lean${opened?.toolchain ? ` (${opened.toolchain.replace("leanprover/lean4:", "Lean ")})` : ""}`}>
						<RotateCw className="size-3" />
					</button>
				</span>
			</div>
			<div className="flex min-h-0 flex-1">
				{/* The editor: a textarea over the highlighted text, both on FileView's metrics (24px lines, numbers in 3rem). */}
				<div className="relative min-w-0 flex-1 overflow-hidden">
					<pre ref={layer} aria-hidden className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre py-2 font-mono text-[12.5px] leading-6" style={{ tabSize: 4 }}>
						{lines.map((_, i) => (
							<span key={i} className={`relative block pr-3 ${i === position.line ? "bg-muted/60" : ""}`}>
								<span className={`mr-3 inline-block w-9 select-none text-right ${byLine.has(i) ? (byLine.get(i)!.some((d) => d.severity === 1) ? "text-red-600" : "text-amber-600") : "text-muted-foreground/60"}`}>{i + 1}</span>
								<span>{highlighted[i] || " "}</span>
								{byLine.get(i)?.map((d, k) => {
									const end = d.range.end.line === i ? d.range.end.character : lines[i].length;
									return <span key={k} className={`absolute top-[calc(1lh-3px)] h-[3px] ${d.severity === 1 ? "fm-squiggle-error" : "fm-squiggle-warning"}`} style={{ left: `calc(3rem + ${d.range.start.character}ch)`, width: `${Math.max(1, end - d.range.start.character)}ch` }} />;
								})}
							</span>
						))}
					</pre>
					<textarea
						ref={editor}
						aria-label={`Edit ${path}`}
						disabled={!opened || saving}
						value={text}
						spellCheck={false}
						wrap="off"
						className="absolute inset-0 h-full w-full resize-none bg-transparent py-2 pl-12 pr-3 font-mono text-[12.5px] leading-6 text-transparent caret-foreground outline-none selection:bg-sky-500/25"
						style={{ tabSize: 4 }}
						autoCapitalize="off"
						autoCorrect="off"
						onScroll={(e) => {
							if (layer.current) {
								layer.current.scrollTop = e.currentTarget.scrollTop;
								layer.current.scrollLeft = e.currentTarget.scrollLeft;
							}
						}}
						onChange={(e) => {
							setText(e.target.value);
							writeDraft(key(folder, path), e.target.value === original ? null : { text: e.target.value, original });
							setPosition(cursorPosition(e.target.value, e.target.selectionStart));
						}}
						onSelect={(e) => setPosition(cursorPosition(e.currentTarget.value, e.currentTarget.selectionStart))}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "s") {
								e.preventDefault();
								if (!saving && dirty) void save();
							}
						}}
					/>
					{!opened && !error ? <p className="absolute inset-x-0 top-10 text-center text-[12px] text-muted-foreground">Starting the project's Lean server and loading its imports…</p> : null}
				</div>
				<aside aria-label="Lean infoview" className="flex w-[min(26rem,42%)] shrink-0 flex-col overflow-y-auto border-l bg-background pb-3 text-[12px]">
					{error || state?.error ? (
						<div className="m-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
							<pre className="whitespace-pre-wrap font-mono text-[11px] leading-4 text-red-700 dark:text-red-400">{error || state?.error}</pre>
							<p className="mt-1.5 text-[11px] text-muted-foreground">Lean runs from the nearest folder with a lakefile, on its lean-toolchain. Build the project's imports once with lake build.</p>
						</div>
					) : null}
					{here?.functions.length ? (
						<>
							<p className={section}>Proves · {here.theorem.name}</p>
							{here.functions.map((f) => {
								const st = fnStatus(f, formal!.theorems);
								return (
									<button key={`${f.name}${f.line}`} type="button" onClick={() => f.file && onOpenFile(f.file, f.line)} className="mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] hover:bg-muted">
										<span className={`size-2 shrink-0 rounded-full ${st.dot}`} />
										<span className="truncate">{f.name}</span>
										<span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
											{f.file?.split("/").pop()}:{f.line}
											<SquareArrowOutUpRight className="size-3" />
										</span>
									</button>
								);
							})}
						</>
					) : null}
					<p className={section}>{goals ? `Goals · ${goals.length}` : goal?.term ? "Expected type" : "Goals"}</p>
					{goalError ? <p className="px-3 text-[11px] text-muted-foreground">{goalError}</p> : null}
					{goals ? goals.length ? goals.map((g, i) => <GoalCard key={i} goal={g} n={i + 1} of={goals.length} />) : <p className="px-3 text-emerald-700 dark:text-emerald-400">No goals left here.</p> : null}
					{!goals && goal?.term ? <GoalCard goal={goal.term.goal} n={1} of={1} /> : null}
					{!goals && !goal?.term && !goalError ? <p className="px-3 text-muted-foreground">{opened ? "Put the cursor inside a proof to see its goals." : "Waiting for Lean."}</p> : null}
					<p className={section}>Messages · {checking ? "…" : diagnostics.length}</p>
					{!checking && !diagnostics.length && opened ? <p className="px-3 text-muted-foreground">None for this version of the file.</p> : null}
					{diagnostics.map((d, i) => (
						<button key={i} type="button" onClick={() => jump(d.range.start)} className="mx-2 mb-1 block w-[calc(100%-1rem)] rounded-md px-2 py-1.5 text-left hover:bg-muted">
							<span className={`inline-flex items-center gap-1.5 text-[11px] ${d.severity === 1 ? "text-red-700 dark:text-red-400" : d.severity === 2 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
								<span className={`size-1.5 rounded-full ${d.severity === 1 ? "bg-red-500" : d.severity === 2 ? "bg-amber-500" : "bg-muted-foreground"}`} />
								{d.severity === 1 ? "Error" : d.severity === 2 ? "Warning" : "Info"}
								<span className="font-mono text-muted-foreground">
									{d.range.start.line + 1}:{d.range.start.character + 1}
								</span>
							</span>
							<pre className="mt-0.5 max-h-40 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-4">{d.message}</pre>
						</button>
					))}
					{specs.length ? (
						<>
							<p className={section}>Specifications in .formal/proof-specs.json</p>
							{specs.map((s) => (
								<div key={s.id} className="mx-2 mb-2 rounded-lg border p-2.5">
									<button type="button" onClick={() => jump({ line: s.lean.line - 1, character: 0 })} className="text-left font-medium hover:underline">
										{s.title}
									</button>
									<p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{s.signature}</p>
									{s.assumptions.length ? <p className="mt-1 text-[11px] text-muted-foreground">Assumes: {s.assumptions.join("; ")}</p> : null}
									<div className="mt-1.5 flex gap-1">
										<button type="button" onClick={() => onOpenFile(s.solidity.path, s.solidity.line)} className={tool}>
											<SquareArrowOutUpRight className="size-3" />
											{s.solidity.path.split("/").pop()}:{s.solidity.line}
										</button>
										<button type="button" onClick={() => setSpecCode((v) => (v === s.id ? null : s.id))} className={tool} aria-expanded={specCode === s.id}>
											Relevant code
										</button>
									</div>
									{specCode === s.id ? <SpecificationCode folder={folder} specId={s.id} invoke={invoke} onOpenFile={onOpenFile} /> : null}
								</div>
							))}
						</>
					) : null}
					<p className="mx-3 mt-auto pt-4 text-[11px] leading-4 text-muted-foreground">Lean checks the proofs in this file against its Lean model. That the model matches the Solidity is a separate question.</p>
				</aside>
			</div>
		</div>
	);
}
