import { useEffect, useRef, useState } from "react";
import type { Bridge } from "./swarm-panel";
import type { Scan } from "./local";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
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
function key(folder: string, path: string) { return `fm:proof-draft:${folder}:${path}`; }
function readDraft(id: string): Draft | null {
	try { return drafts.get(id) ?? JSON.parse(sessionStorage.getItem(id) ?? "null"); } catch { return drafts.get(id) ?? null; }
}
function writeDraft(id: string, draft: Draft | null) {
	if (draft) drafts.set(id, draft); else drafts.delete(id);
	try { if (draft) sessionStorage.setItem(id, JSON.stringify(draft)); else sessionStorage.removeItem(id); } catch { /* Memory retains the draft for this app session. */ }
}
export function cursorPosition(text: string, offset: number): Position {
	const prefix = text.slice(0, offset);
	const last = prefix.lastIndexOf("\n");
	return { line: prefix.split("\n").length - 1, character: prefix.length - last - 1 };
}
export function positionOffset(text: string, p: Position): number {
	const lines = text.split("\n");
	return lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + Math.min(p.character, (lines[p.line] ?? "").length);
}

// One mutation queue across workspace mounts prevents an old didClose/change racing a new open.
let leanQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const result = leanQueue.catch(() => {}).then(operation);
	leanQueue = result.catch(() => {});
	return result;
}

export function ProofWorkspace({ folder, scan, invoke, onOpenFile, initialPath = "", initialSpecId = "", initialLine = 1, onNavigate }: { initialPath?: string; initialSpecId?: string; initialLine?: number; onNavigate?: (path: string, specId?: string) => void; folder: string; scan: Scan | null; invoke: Bridge["invoke"]; onOpenFile: (path: string, line?: number) => void }) {
	const files = scan?.lean ?? [];
	const [path, setPath] = useState(initialPath);
	const [loaded, setOpened] = useState<(Opened & { path: string }) | null>(null);
	const opened = loaded?.path === path ? loaded : null;
	const [text, setText] = useState("");
	const [original, setOriginal] = useState("");
	const [synced, setSynced] = useState<{ text: string; version: number } | null>(null);
	const [state, setState] = useState<State | null>(null);
	const [goal, setGoal] = useState<Goal | null>(null);
	const [position, setPosition] = useState<Position>({ line: 0, character: 0 });
	const [error, setError] = useState<string | null>(null);
	const [goalError, setGoalError] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);
	const [saving, setSaving] = useState(false);
	const [specs, setSpecs] = useState<Spec[]>([]);
	const [specError, setSpecError] = useState<string | null>(null);
	const [specId, setSpecId] = useState(initialSpecId);
	const [showCode, setShowCode] = useState(false);
	const [symbols, setSymbols] = useState<Symbol[]>([]);
	const editor = useRef<HTMLTextAreaElement>(null);
	const highlighting = useRef<HTMLPreElement>(null);
	const highlightedLines = useHighlightedCode(text, "lean");
	const jumpTo = useRef<Position | null>({ line: Math.max(0, initialLine - 1), character: 0 });
	const dirty = opened !== null && text !== original;
	const current = synced?.text === text && state?.version === synced.version && state.diagnosticsVersion === synced.version;
	const checking = !current || state?.processing === null || (state?.processing?.length ?? 0) > 0;
	const diagnostics = current ? state?.diagnostics ?? [] : [];
	const selectedSpec = specs.find(s => s.id === specId && s.lean.path === path);
	useEffect(() => {
		if (!path && files.length) setPath(files.find(f => /Refinement\//.test(f)) ?? files[0]);
	}, [path, files]);
	useEffect(() => {
		let active = true;
		void invoke<Spec[]>("proof_specs", { folder }).then(s => { if (active) { setSpecs(s); setSpecError(null); const selected = s.find(spec => spec.id === initialSpecId && (!initialPath || spec.lean.path === initialPath)); if (selected) { jumpTo.current = { line: selected.lean.line - 1, character: 0 }; setPosition(jumpTo.current); } } }, e => { if (active) setSpecError(String(e)); });
		return () => { active = false; };
	}, [folder, invoke, initialSpecId, initialPath]);
	useEffect(() => {
		if (!path) return;
		let active = true;
		setOpened(null); setSynced(null); setState(null); setGoal(null); setError(null); setSymbols([]);
		void enqueue(() => invoke<Opened>("lean_open", { folder, path })).then(async data => {
			if (!active) return;
			const draft = readDraft(key(folder, path));
			setOpened({ ...data, path }); setText(draft?.text ?? data.text); setOriginal(draft?.original ?? data.text);
			setSynced({ text: data.text, version: data.version });
			setPosition(jumpTo.current ?? { line: 0, character: 0 });
		}, e => { if (active) setError(String(e)); });
		return () => {
			active = false;
			void enqueue(() => invoke("lean_close", { folder, path })).catch(() => {});
		};
		// The mutation queue is module-scoped and stable across view changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder, path, invoke, generation]);

	useEffect(() => {
		if (!opened || synced?.text === text) return;
		let active = true;
		setGoal(null); setState(null);
		const timer = setTimeout(() => {
			void enqueue(() => invoke<number>("lean_sync", { folder, path, text })).then(version => {
				if (active) { setSynced({ text, version }); setError(null); }
			}, e => { if (active) setError(String(e)); });
		}, 250);
		return () => { active = false; clearTimeout(timer); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder, path, text, opened, synced, invoke]);
	useEffect(() => {
		if (!opened) return;
		let active = true;
		let outstanding = false;
		const poll = async () => {
			if (outstanding) return;
			outstanding = true;
			try { const value = await invoke<State>("lean_state", { folder, path }); if (active) setState(value); }
			catch (e) { if (active) setError(String(e)); }
			finally { outstanding = false; }
		};
		void poll(); const timer = setInterval(() => void poll(), 700);
		return () => { active = false; clearInterval(timer); };
	}, [folder, path, opened, invoke]);
	useEffect(() => {
		if (!synced || synced.text !== text || !opened) return;
		let active = true;
		setGoal(null); setGoalError(null);
		const timer = setTimeout(() => {
			void invoke<Goal>("lean_goal", { folder, path, ...position, version: synced.version }).then(g => {
				if (active) setGoal(g);
			}, e => { if (active) setGoalError(String(e)); });
		}, 200);
		return () => { active = false; clearTimeout(timer); };
	}, [folder, path, position.line, position.character, synced, text, opened, invoke, checking]);
	useEffect(() => {
		if (!opened || !synced || checking) return;
		let active = true;
		void invoke<Symbol[]>("lean_symbols", { folder, path, version: synced.version }).then(s => { if (active) setSymbols(s); }, () => {});
		return () => { active = false; };
	}, [folder, path, opened, synced, checking, invoke]);
	useEffect(() => {
		if (opened && jumpTo.current && editor.current) { jump(jumpTo.current); jumpTo.current = null; }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [opened, specs]);
	function jump(p: Position) {
		setPosition(p);
		const offset = positionOffset(editor.current?.value ?? text, p);
		editor.current?.focus(); editor.current?.setSelectionRange(offset, offset);
		if (editor.current) editor.current.scrollTop = Math.max(0, p.line * 20 - 80);
	}
	async function save() {
		setSaving(true); setError(null);
		const snapshot = text;
		try { await enqueue(() => invoke("lean_save", { folder, path, text: snapshot, expected: original })); setOriginal(snapshot); writeDraft(key(folder, path), null); }
		catch (e) { setError(String(e)); }
		finally { setSaving(false); }
	}
	function reload() {
		writeDraft(key(folder, path), null);
		setGeneration(g => g + 1);
	}
	async function restart() {
		try { await enqueue(() => invoke("lean_restart", { folder, path })); setGeneration(g => g + 1); }
		catch (e) { setError(String(e)); }
	}
	return <div className="flex min-h-0 flex-1 flex-col gap-1 bg-muted/80 p-1">
		<div className="flex flex-wrap items-center gap-2 text-xs">
			<label className="flex min-w-0 flex-1 items-center gap-2">Lean file<select aria-label="Lean file" disabled={saving} className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 font-mono" value={path} onChange={e => { if (onNavigate) onNavigate(e.target.value); else { setPath(e.target.value); setSpecId(""); } }}>{!files.length && <option value="">No Lean files</option>}{files.map(f => <option key={f}>{f}</option>)}</select></label>
			<button className="rounded border px-2 py-1.5 disabled:opacity-50" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
			<button className="rounded border px-2 py-1.5 disabled:opacity-50" disabled={!path || saving} onClick={reload}>{dirty ? "Discard draft and reload" : "Reload"}</button>
			<button className="rounded border px-2 py-1.5 disabled:opacity-50" disabled={!path || saving} onClick={() => void restart()}>Restart Lean</button>
		</div>
		{specs.length > 0 && <div className="space-y-1 text-xs"><label>Specification <select className="rounded border bg-background px-2 py-1" value={specId} disabled={saving} onChange={e => {
			setShowCode(false); setSpecId(e.target.value); const s = specs.find(s => s.id === e.target.value); if (!s) return;
			if (onNavigate && path !== s.lean.path) { onNavigate(s.lean.path, s.id); return; }
			const p = { line: s.lean.line - 1, character: 0 }; if (path === s.lean.path) jump(p); else { jumpTo.current = p; setPath(s.lean.path); }
		}}><option value="">Choose a specification</option>{specs.map(s => <option key={s.id} value={s.id}>{s.signature} — {s.title}</option>)}</select></label>
		{selectedSpec && <><button className="rounded border px-2 py-1.5" aria-expanded={showCode} onClick={() => setShowCode(v => !v)}>{showCode ? "Hide relevant code" : "Show code relevant to this specification"}</button><p>{selectedSpec.title} · <button className="underline" onClick={() => onOpenFile(selectedSpec.solidity.path, selectedSpec.solidity.line)}>Open Solidity source ({selectedSpec.solidity.path}:{selectedSpec.solidity.line})</button></p><p>Assumptions: {selectedSpec.assumptions.length ? selectedSpec.assumptions.join("; ") : "None recorded in the manifest"}</p></>}</div>}
		{selectedSpec && showCode && <SpecificationCode key={selectedSpec.id} folder={folder} specId={selectedSpec.id} invoke={invoke} onOpenFile={onOpenFile} />}
		{!specs.length && !specError && <p className="text-xs text-muted-foreground">Open a Solidity file in Code to browse its generated Lean mappings and linked theorems.</p>}
		{specError && <p role="alert" className="text-xs text-red-600">Specification manifest: {specError}</p>}
		{(error || state?.error) && <p role="alert" className="whitespace-pre-wrap text-xs text-red-600">{error || state?.error}</p>}
		{!files.length && <p className="p-4 text-sm text-muted-foreground">This folder has no Lean files. Open a Lake project containing your specifications and proofs. The Solidity coverage and execution experiment are available in the other tabs.</p>}
		{path && !opened && !error && <section role="status" className="rounded-xl border bg-card p-3 text-[12px]"><p className="font-medium">Starting Lean</p><p className="mt-1 text-muted-foreground">Loading the project toolchain and imports…</p></section>}
		{opened && <>
			<div className="flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground" aria-live="polite"><span>{state?.error || error ? "Check unavailable" : checking ? "Checking buffer…" : diagnostics.some(d => d.severity === 1) ? "Lean errors" : diagnostics.length ? "Lean messages" : "No Lean diagnostics"}{dirty ? " · Unsaved draft" : " · Saved"}</span><span>{opened.toolchain || "Project toolchain"} · buffer v{synced?.version ?? "…"} · Ln {position.line + 1}, Col {position.character + 1}</span></div>
			<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(260px,2fr)] gap-2">
				<div className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
					<div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs"><span className="truncate font-mono">{path}</span>{symbols.length > 0 && <select aria-label="Go to declaration" className="ml-auto max-w-[50%] bg-background" value="" onChange={e => { const s = symbols[Number(e.target.value)]; const p = s?.selectionRange?.start ?? s?.range?.start; if (p) jump(p); }}><option value="">Declarations</option>{symbols.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select>}</div>
					<div className="relative min-h-0 flex-1">
						<pre ref={highlighting} aria-hidden="true" className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre p-3 font-mono text-xs leading-5" style={{ tabSize: 4 }}>{highlightedLines.map((line, i) => <span key={i} className="block min-h-5">{line || " "}</span>)}{text.endsWith("\n") && <span className="block min-h-5"> </span>}</pre>
					<textarea ref={editor} aria-label="Lean proof editor" disabled={saving} value={text} spellCheck={false} wrap="off" className="absolute inset-0 h-full w-full resize-none bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" style={{ tabSize: 4 }} autoCapitalize="off" autoCorrect="off" onScroll={e => { if (highlighting.current) { highlighting.current.scrollTop = e.currentTarget.scrollTop; highlighting.current.scrollLeft = e.currentTarget.scrollLeft; } }} onChange={e => { setText(e.target.value); writeDraft(key(folder, path), e.target.value === original ? null : { text: e.target.value, original }); setPosition(cursorPosition(e.target.value, e.target.selectionStart)); }} onSelect={e => setPosition(cursorPosition(e.currentTarget.value, e.currentTarget.selectionStart))} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (!saving && dirty) void save(); } }} />
					</div>
				</div>
				<div className="flex min-h-0 flex-col gap-2 overflow-auto">
					<section role="status" className="rounded-xl border bg-card p-3"><h3 className="mb-2 text-xs font-medium">{checking ? "Checking proof" : "Lean check complete"}</h3><p className="text-xs text-muted-foreground">{checking ? "Building imports and checking this buffer…" : "Feedback below applies to the current buffer."}</p></section><section className="rounded-xl border bg-card p-3"><h3 className="mb-2 text-xs font-medium">Goals at cursor</h3><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{goalError ?? (goal?.goals ? goal.goals.goals.length ? goal.goals.goals.join("\n\n") : "No remaining goals at this position." : goal?.term?.goal ?? (goal ? "Place the cursor inside a proof to inspect its goals." : "Loading goals…"))}</pre></section>
					<section className="rounded-xl border bg-card p-3"><h3 className="mb-2 text-xs font-medium">Diagnostics</h3>{checking && <p className="text-xs text-muted-foreground">Waiting for diagnostics for this buffer version.</p>}{diagnostics.map((d, i) => <button key={i} className="mb-2 block w-full rounded border p-2 text-left text-xs hover:bg-muted" onClick={() => jump(d.range.start)}><span className={d.severity === 1 ? "text-red-600" : "text-amber-600"}>{d.severity === 1 ? "Error" : d.severity === 2 ? "Warning" : "Info"} · {d.range.start.line + 1}:{d.range.start.character + 1}</span><pre className="mt-1 whitespace-pre-wrap break-words font-mono">{d.message}</pre></button>)}{!checking && !diagnostics.length && <p className="text-xs text-muted-foreground">No diagnostics for this buffer.</p>}</section>
				</div>
			</div>
			<p className="text-[11px] text-muted-foreground">Lean feedback applies to this file and buffer version. It does not certify the Solidity translation, assumptions, or deployed bytecode. Drafts stay separate from disk until saved.</p>
		</>}
	</div>;
}
