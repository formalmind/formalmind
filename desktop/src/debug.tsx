import { recordRun } from "@/lib/run-results";
import { reportError } from "@/lib/report-error";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { Bug, ChevronDown, ChevronRight, Columns2, FileCode2, FlaskConical, FolderPlus, Link2, Loader2, Play, Unlink2, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { useFolders, type Scan } from "./local";

/**
 * Debug mode: a local folder's Foundry test, one EVM step at a time, on the sol-debug engine (src-tauri/src/debug.rs).
 * The panes and keys are the terminal UI's (crates/sol-debug/src/tui.rs): source with the current AST node lit, calls,
 * opcodes, stack, memory and storage named by the layout. Rust keeps the trace; each move returns one step's view.
 */

type TestFn = { contract: string; name: string; test: string };
type Call = { depth: number; kind: string; who: string; call: string; ok: boolean | null; first_step: number };
type Place = { file: number; name: string; line: number; scope: string; node_type: string; from: number; to: number; exact: boolean };
type Op = { pc: number; name: string; imm: string; jump: "" | "in" | "out"; current: boolean; node: boolean };
type Word = { short: string; full: string };
type Access = { step: number; write: boolean; who: string; text: string; full: string };
type StepView = {
	step: number;
	total: number;
	depth: number;
	pc: number;
	op: string;
	gas: number;
	place: Place | null;
	frame: number;
	open: number[];
	ops: Op[];
	stack: Word[];
	result: Word | null;
	memory_size: number;
	memory: { offset: number; hex: string; fresh: boolean }[];
	storage: Access[];
	breakpoints: [number, number][];
	watches: string[];
	status: string;
};
type RunView = { title: string; success: boolean; verdict: string; gas: number; calls: Call[]; missing: string[]; view: StepView };
type Divergence = { what: string; index: number; a: string | null; b: string | null; a_step: number | null; b_step: number | null };
type Section = { name: string; matched: number; total_a: number; total_b: number; divergence: Divergence | null };
/** Two runs of one test, in this folder (a) and another (b), and where they disagree (crates/sol-debug/src/diff.rs). */
type Compared = { label_a: string; label_b: string; a: RunView; b: RunView; sections: Section[]; uncompared: [string, number, number][]; first: Divergence | null };

const KEYS = "j/k op · n/N line · s/S into · f/F out · c/C continue · g/G ends · /search ;, · :b line · :w var · :pc n · :step n";
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const isTest = (f: string) => f.endsWith(".t.sol");
const isScript = (f: string) => f.endsWith(".s.sol");

/** A card in the app's floating style: a muted frame, a mono caption, the white content inside. */
function Pane({ title, meta, className = "", children, scrollRef }: { title: string; meta?: string; className?: string; children: React.ReactNode; scrollRef?: React.Ref<HTMLDivElement> }) {
	return (
		<section className={`flex min-h-0 min-w-0 basis-0 flex-col rounded-2xl border bg-muted/80 p-1 ${className || "flex-1"}`}>
			<div className="flex h-7 shrink-0 items-center gap-2 px-2.5">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
				{meta ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{meta}</span> : null}
			</div>
			<div ref={scrollRef} className="shadow-card relative min-h-0 flex-1 overflow-auto rounded-xl border bg-card font-mono text-[11px] leading-5">
				{children}
			</div>
		</section>
	);
}

/** Visual columns of a UTF-16 offset in a line whose tabs are 4 wide. */
function column(text: string, at: number) {
	let col = 0;
	for (let i = 0; i < Math.min(at, text.length); i++) col = text[i] === "\t" ? col + 4 - (col % 4) : col + 1;
	return col;
}

const SourceLine = memo(function SourceLine({ n, node, text, current, exact, from, to, bp, onToggle }: { n: number; node: React.ReactNode; text: string; current: boolean; exact: boolean; from: number; to: number; bp: boolean; onToggle: (n: number) => void }) {
	const a = current ? column(text, from) : 0;
	const b = current ? Math.max(column(text, Math.min(to, text.length)), a + 1) : 0;
	return (
		<div data-line={n} className={`flex ${current ? "bg-amber-500/10" : ""}`}>
			<button type="button" onClick={() => onToggle(n)} title={bp ? "Remove the breakpoint" : "Break here"} className="group flex w-14 shrink-0 select-none items-center justify-end gap-1 pr-3 text-right tabular-nums">
				<span className={`size-2 rounded-full ${bp ? "bg-red-500" : "bg-transparent group-hover:bg-red-500/30"}`} />
				<span className={current ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground/60"}>{n}</span>
			</button>
			<span className="relative whitespace-pre pr-4" style={{ tabSize: 4 }}>
				{current ? (
					<span
						aria-hidden
						className={`pointer-events-none absolute inset-y-0 rounded-sm ${exact ? "bg-amber-400/30 ring-1 ring-amber-500/50" : "bg-muted-foreground/15"}`}
						style={{ left: `${a}ch`, width: `${b - a}ch` }}
					/>
				) : null}
				<span className="relative">{node}</span>
			</span>
		</div>
	);
});

/** The file at the current step, highlighted as Solidity, the current node's `src` lit on its line. */
function Source({ text, fileName, place, breakpoints, onToggle }: { text: string; fileName: string; place: Place | null; breakpoints: [number, number][]; onToggle: (line: number) => void }) {
	const lines = useHighlightedCode(text, "solidity");
	const raw = useMemo(() => text.split("\n"), [text]);
	const box = useRef<HTMLDivElement>(null);
	const line = place?.line ?? 0;
	useEffect(() => {
		const el = box.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
		const c = box.current;
		if (!el || !c) return;
		// Keep the current line in the middle third; recenter only when it leaves it.
		const top = el.offsetTop - c.scrollTop;
		if (top < c.clientHeight / 3 || top > (c.clientHeight * 2) / 3) c.scrollTop = el.offsetTop - c.clientHeight / 2;
	}, [line, text]);
	const bps = new Set(breakpoints.filter(([f]) => f === place?.file).map(([, l]) => l));
	return (
		<Pane title="Source" meta={place ? `${fileName}:${place.line} · ${place.scope} · ${place.node_type}${place.exact ? "" : " · no source for this step"}` : "no source for this step"} className="flex-[3]" scrollRef={box}>
			<div className="min-w-fit py-1">
				{lines.map((node, i) => (
					<SourceLine key={i} n={i + 1} node={node} text={raw[i] ?? ""} current={i + 1 === line} exact={Boolean(place?.exact)} from={place?.from ?? 0} to={place?.to ?? 0} bp={bps.has(i + 1)} onToggle={onToggle} />
				))}
			</div>
		</Pane>
	);
}

function useScrollTo(dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Center the current row in the pane itself (scrollIntoView would scroll the page too).
		const c = ref.current;
		const el = c?.querySelector<HTMLElement>("[data-current]");
		if (c && el) c.scrollTop = el.offsetTop - c.clientHeight / 2;
	}, [dep]);
	return ref;
}

function Calls({ calls, view, go }: { calls: Call[]; view: StepView; go: (step: number) => void }) {
	const ref = useScrollTo(view.frame);
	return (
		<Pane title="Calls" meta={`${calls.length} frames`} className="flex-[2]" scrollRef={ref}>
			<ul className="py-1">
				{calls.map((c, i) => {
					const current = i === view.frame;
					const open = view.open.includes(i);
					return (
						<li key={i} data-current={current || undefined}>
							<button type="button" onClick={() => go(c.first_step)} title={`${c.kind} ${c.who} ${c.call}`} className={`block w-full truncate px-2 text-left hover:bg-muted ${current ? "bg-amber-500/15 font-semibold text-foreground" : open ? "text-foreground" : "text-muted-foreground/70"}`} style={{ paddingLeft: `${0.5 + c.depth}rem` }}>
								<span className="text-muted-foreground">{c.kind === "DELEGATECALL" ? "DCALL" : c.kind === "STATICCALL" ? "SCALL" : c.kind}</span> {c.who} <span className="text-sky-700 dark:text-sky-400">{c.call}</span>
								{c.ok === false ? <span className="text-red-600"> ✗</span> : c.ok === null ? " …" : null}
							</button>
						</li>
					);
				})}
			</ul>
		</Pane>
	);
}

function Opcodes({ view }: { view: StepView }) {
	const ref = useScrollTo(view.step);
	return (
		<Pane title="Opcodes" meta={`pc ${view.pc}`} scrollRef={ref} className="w-[13.5rem] flex-none !basis-auto">
			{view.ops.length === 0 ? <p className="p-2 text-muted-foreground">Code not from this compile</p> : null}
			<ul className="py-1">
				{view.ops.map((o) => (
					<li key={o.pc} data-current={o.current || undefined} className={`flex gap-2 whitespace-nowrap px-2 ${o.current ? "bg-amber-400/40 font-semibold" : o.node ? "bg-amber-500/10" : ""}`}>
						<span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{o.pc}</span>
						<span className={o.name.startsWith("JUMP") || o.name.includes("CALL") ? "text-violet-700 dark:text-violet-400" : o.name.startsWith("S") && /LOAD|STORE/.test(o.name) ? "text-pink-700 dark:text-pink-400" : ""}>{o.name}</span>
						{o.imm ? <span className="truncate text-muted-foreground">{o.imm}</span> : null}
						{o.jump ? <span className="text-muted-foreground">{o.jump === "in" ? "↘" : "↗"}</span> : null}
					</li>
				))}
			</ul>
		</Pane>
	);
}

function Stack({ view }: { view: StepView }) {
	return (
		<Pane title="Stack" className="min-w-[13rem] flex-1" meta={view.result ? `result ${view.result.short}` : `${view.stack.length}`}>
			<ul className="py-1">
				{view.stack.map((w, i) => (
					<li key={i} className="flex gap-2 whitespace-nowrap px-2">
						<span className="w-5 shrink-0 text-right text-muted-foreground">{i}</span>
						{/* Never cut: small numbers as they are, anything longer as its full hex (leading zeros dropped). */}
						<button
							type="button"
							title="Copy the full word"
							onClick={() => void navigator.clipboard?.writeText(w.full)}
							className="rounded px-0.5 text-left hover:bg-muted active:bg-emerald-500/20"
						>
							{w.short.includes("…") ? w.full : w.short}
						</button>
					</li>
				))}
				{view.stack.length === 0 ? <li className="px-2 text-muted-foreground">empty</li> : null}
			</ul>
		</Pane>
	);
}

function Memory({ view }: { view: StepView }) {
	const ref = useScrollTo(view.step);
	return (
		<Pane title="Memory" meta={`${view.memory_size} bytes`} className="min-w-[16rem] flex-[1.6]" scrollRef={ref}>
			<ul className="py-1">
				{view.memory.map((m) => (
					<li key={m.offset} data-current={m.fresh || undefined} className={`flex w-max min-w-full gap-2 whitespace-nowrap px-2 ${m.fresh ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : ""}`}>
						<span className="w-10 shrink-0 text-right text-muted-foreground">{m.offset.toString(16)}{m.offset === 0x40 ? "·fp" : ""}</span>
						{/* 32 bytes as two halves of 16, so a word reads at a glance. */}
						<span>
							{m.hex.slice(0, 32)}
							<span className="ml-2">{m.hex.slice(32)}</span>
						</span>
					</li>
				))}
				{view.memory.length === 0 ? <li className="px-2 text-muted-foreground">empty</li> : null}
			</ul>
		</Pane>
	);
}

function Storage({ view, go }: { view: StepView; go: (step: number) => void }) {
	return (
		<Pane title="Storage" meta={view.watches.length ? `watching ${view.watches.join(", ")}` : "newest first"} className="flex-[1.6]">
			<ul className="py-1">
				{view.storage.map((a) => (
					<li key={a.step}>
						<button type="button" onClick={() => go(a.step)} title={`step ${a.step}: ${a.who}: ${a.full}`} className={`block w-full truncate px-2 text-left hover:bg-muted ${a.write ? "text-violet-700 dark:text-violet-400" : "text-muted-foreground"} ${a.step === view.step ? "bg-amber-500/15 font-semibold" : ""}`}>
							<span className="text-muted-foreground">{a.who}:</span> {a.text}
						</button>
					</li>
				))}
				{view.storage.length === 0 ? <li className="px-2 text-muted-foreground">No storage touched yet</li> : null}
			</ul>
		</Pane>
	);
}

/** The debugger for one run: the panes, the vim keys and the `:` / `/` line. */
function Debugger({ id, run, onView, side = false, focused = true, label, typing, onFocus, onMoved, actions }: {
	id: number;
	run: RunView;
	onView: (v: StepView) => void;
	/** The compared folder's run (`b` in the commands). */
	side?: boolean;
	/** Which of two debuggers the keys move. */
	focused?: boolean;
	label?: string;
	/** Set while the `:` / `/` line is open, so the page's own keys (Tab, =) wait. */
	typing?: React.MutableRefObject<boolean>;
	onFocus?: () => void;
	/** After a move (not a breakpoint or watch): the page keeps the other side in step. */
	onMoved?: () => void;
	actions?: React.ReactNode;
}) {
	const view = run.view;
	const [files, setFiles] = useState<Record<number, { name: string; text: string }>>({});
	const [input, setInput] = useState<string | null>(null);
	const [search, setSearch] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const busy = useRef(false);
	const file = view.place?.file;
	useEffect(() => {
		if (file === undefined || files[file]) return;
		void invoke<{ name: string; text: string }>("debug_file", { id, file, b: side }).then((f) => setFiles((all) => ({ ...all, [file]: f })), (e) => setError(String(e)));
	}, [id, file, files, side]);
	useEffect(() => {
		if (typing && focused) typing.current = input !== null;
	}, [typing, focused, input]);

	const call = useCallback(
		async (cmd: string, args: Record<string, unknown>) => {
			if (busy.current) return;
			busy.current = true;
			try {
				onView(await invoke<StepView>(cmd, { id, b: side, ...args }));
				setError(null);
				if (cmd === "debug_nav") onMoved?.();
			} catch (e) {
				setError(String(e));
			} finally {
				busy.current = false;
			}
		},
		[id, onView, side, onMoved],
	);
	const move = useCallback((to: string, back = false, arg?: string) => call("debug_nav", { to, back, arg: arg ?? null }), [call]);
	const go = useCallback((step: number) => void move("step", false, String(step)), [move]);
	const toggle = useCallback((line: number) => void call("debug_break", { line, file: file ?? null, name: null }), [call, file]);

	const command = (line: string) => {
		if (line.startsWith("/")) {
			const text = line.slice(1);
			if (!text) return;
			setSearch(text);
			return void move("search", false, text);
		}
		const [verb, ...rest] = line.slice(1).trim().split(/\s+/);
		const arg = rest.join(" ");
		if (verb === "b" || verb === "break") {
			const m = /^(?:(.+):)?(\d+)$/.exec(arg);
			if (!m) return setError("usage: :b 58  or  :b File.sol:58");
			return void call("debug_break", { line: Number(m[2]), file: m[1] ? null : (file ?? null), name: m[1] ?? null });
		}
		if ((verb === "w" || verb === "watch") && arg) return void call("debug_watch", { text: arg, on: true });
		if ((verb === "unw" || verb === "unwatch") && arg) return void call("debug_watch", { text: arg, on: false });
		if (verb === "step" || verb === "pc") return void move(verb, false, arg);
		setError(`unknown command ${JSON.stringify(line)}`);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!focused || e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
			// The `:` / `/` line takes every key until Enter or Escape, as in the terminal UI.
			if (input !== null) {
				e.preventDefault();
				if (e.key === "Escape") setInput(null);
				else if (e.key === "Backspace") setInput(input.length > 1 ? input.slice(0, -1) : null);
				else if (e.key === "Enter") {
					setInput(null);
					command(input);
				} else if (e.key.length === 1) setInput(input + e.key);
				return;
			}
			const keys: Record<string, () => void> = {
				j: () => void move("op"),
				ArrowDown: () => void move("op"),
				k: () => void move("op", true),
				ArrowUp: () => void move("op", true),
				s: () => void move("into"),
				S: () => void move("into", true),
				n: () => void move("over"),
				l: () => void move("over"),
				ArrowRight: () => void move("over"),
				N: () => void move("over", true),
				h: () => void move("over", true),
				ArrowLeft: () => void move("over", true),
				f: () => void move("out"),
				F: () => void move("out", true),
				c: () => void move("continue"),
				C: () => void move("continue", true),
				g: () => void move("first"),
				Home: () => void move("first"),
				G: () => void move("last"),
				End: () => void move("last"),
				";": () => void (search && move("search", false, search)),
				",": () => void (search && move("search", true, search)),
				":": () => setInput(":"),
				"/": () => setInput("/"),
			};
			const act = keys[e.key];
			if (!act) return;
			e.preventDefault();
			act();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const f = file !== undefined ? files[file] : undefined;
	return (
		<div onMouseDown={onFocus} className={`flex min-h-0 flex-1 flex-col gap-2 ${label ? `rounded-2xl p-1.5 ring-1 transition-shadow ${focused ? "ring-amber-500/60" : "ring-transparent"}` : ""}`}>
			<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[13px]">
				{label ? <span className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium ${focused ? "bg-amber-500/20 text-amber-800 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}>{label}</span> : null}
				<span className="font-medium">{run.title}</span>
				<span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${run.success ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-red-500/15 text-red-700 dark:text-red-400"}`}>{run.success ? "pass" : run.verdict}</span>
				<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
					step {view.step}/{view.total - 1} · depth {view.depth} · pc {view.pc} · {view.op} · gas {view.gas.toLocaleString()}
				</span>
				{run.missing.length ? <span className="text-[11px] text-amber-600">unsupported cheatcodes: {run.missing.join(", ")}</span> : null}
				{actions ? <span className="ml-auto flex items-center gap-1.5">{actions}</span> : null}
			</header>
			<div className="flex min-h-0 flex-[11] gap-2">
				{f ? <Source text={f.text} fileName={f.name} place={view.place} breakpoints={view.breakpoints} onToggle={toggle} /> : <Pane title="Source" className="flex-[3]"><p className="p-3 text-muted-foreground">{view.place ? "Loading the file…" : "No source for this step"}</p></Pane>}
				<Calls calls={run.calls} view={view} go={go} />
			</div>
			<div className="flex min-h-0 flex-[9] gap-2">
				<Opcodes view={view} />
				<Stack view={view} />
				<Memory view={view} />
				<Storage view={view} go={go} />
			</div>
			<footer className="flex h-8 shrink-0 items-center gap-3 rounded-xl border bg-muted/60 px-3 font-mono text-[11px]">
				{input !== null ? (
					<span className="min-w-0 flex-1 truncate font-semibold">
						{input}
						<span className="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground/70" />
					</span>
				) : (
					<>
						<span className={`min-w-0 flex-1 truncate ${error ? "text-red-600" : "text-sky-700 dark:text-sky-400"}`}>{error ?? view.status}</span>
						<span className="hidden shrink-0 truncate text-muted-foreground lg:inline">{KEYS}</span>
					</>
				)}
			</footer>
		</div>
	);
}

/** The test files of a folder as a tree of directories, the selected file's tests under it. */
function TestTree({ files, selected, tests, opening, running, current, onFile, onTest }: { files: string[]; selected: string | null; tests: TestFn[] | null; opening: boolean; running: string | null; current: string | null; onFile: (f: string) => void; onTest: (t: TestFn) => void }) {
	const dirs = useMemo(() => {
		const out = new Map<string, string[]>();
		for (const f of files) {
			const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
			out.set(dir, [...(out.get(dir) ?? []), f]);
		}
		return [...out.entries()];
	}, [files]);
	return (
		<ul className="space-y-2 p-2 font-mono text-[11px]">
			{files.length === 0 ? <li className="p-2 font-sans text-[13px] text-muted-foreground">No Foundry scripts (*.s.sol) or tests (*.t.sol) in this folder.</li> : null}
			{dirs.map(([dir, list]) => (
				<li key={dir}>
					<p className="px-1.5 pb-0.5 text-muted-foreground">{dir}/</p>
					<ul>
						{list.map((f) => (
							<li key={f}>
								<button type="button" onClick={() => onFile(f)} className={`flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-muted ${selected === f ? "bg-muted font-medium" : ""}`} title={f}>
									<ChevronRight className={`size-3 shrink-0 text-muted-foreground transition-transform ${selected === f ? "rotate-90" : ""}`} />
									<FileCode2 className={`size-3 shrink-0 ${isScript(f) ? "text-amber-500" : "text-sky-500"}`} />
									<span className="truncate">{name(f)}</span>
								</button>
								{selected === f ? (
									<ul className="ml-4 border-l pl-1">
										{opening ? <li className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />Compiling with solc…</li> : null}
										{tests?.length === 0 ? <li className="px-1.5 py-1 text-muted-foreground">{isScript(f) ? "No run…() function without arguments" : "No test…() functions"}</li> : null}
										{tests?.map((t) => {
											const key = `${t.contract}::${t.test}`;
											return (
												<li key={key}>
													<button type="button" onClick={() => onTest(t)} disabled={Boolean(running)} title={`${t.name}::${t.test}`} className={`flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left enabled:hover:bg-muted ${current === key ? "bg-amber-500/15 font-medium" : ""}`}>
														{running === key ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <Play className="size-3 shrink-0 text-emerald-600" />}
														<span className="truncate">{t.test}</span>
													</button>
												</li>
											);
										})}
									</ul>
								) : null}
							</li>
						))}
					</ul>
				</li>
			))}
		</ul>
	);
}

/** "Compare with…": the other added folders (a port of the protocol, a fork), or add one. */
function CompareMenu({ folder, busy, onPick }: { folder: string; busy: boolean; onPick: (other: string) => void }) {
	const { folders, add } = useFolders();
	const others = folders.filter((f) => f !== folder);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger disabled={busy} title="Run this test in another folder too and show where the two runs differ" className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-foreground outline-none hover:bg-muted disabled:opacity-50">
				{busy ? <Loader2 className="size-3 animate-spin" /> : <Columns2 className="size-3" />}
				{busy ? "Comparing…" : "Compare with…"}
				<ChevronDown className="size-3 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-56">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Run the same test in</DropdownMenuLabel>
				{others.map((f) => (
					<DropdownMenuItem key={f} onSelect={() => onPick(f)} title={f} className="text-[13px]">
						{name(f)}
					</DropdownMenuItem>
				))}
				{others.length ? <DropdownMenuSeparator /> : null}
				<DropdownMenuItem
					className="text-[13px]"
					onSelect={() =>
						void add().then((path) => {
							if (path && path !== folder) onPick(path);
						})
					}
				>
					<FolderPlus className="size-3.5" />
					Add a folder…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** What the comparison found: each kind of observation matched or not, and the first divergence on both sides. */
function Report({ cmp, linked, slotMap, onLink, onHome, onGo, onSlotMap, onClose }: { cmp: Compared; linked: boolean; slotMap: string; onLink: () => void; onHome: () => void; onGo: (b: boolean, step: number) => void; onSlotMap: (path: string) => void; onClose: () => void }) {
	const d = cmp.first;
	const [map, setMap] = useState(slotMap);
	const btn = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-foreground hover:bg-muted";
	return (
		<section className="mb-2 shrink-0 rounded-2xl border bg-muted/80 p-1">
			<div className="flex h-8 items-center gap-2 px-2">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Compare</span>
				<span className="min-w-0 truncate text-[12px]">
					<span className="font-medium">{cmp.label_a}</span> vs <span className="font-medium">{cmp.label_b}</span>
				</span>
				<span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${d ? "bg-red-500/15 text-red-700 dark:text-red-400" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"}`}>{d ? `${d.what} #${d.index} differs` : "no divergence"}</span>
				<span className="ml-auto" />
				{d ? <button type="button" onClick={onHome} title="Both sides back to the first divergence (=)" className={btn}>= Divergence</button> : null}
				<button type="button" onClick={onLink} title="Moving one side moves the other to the same external call" className={`${btn} ${linked ? "border-amber-500/50 bg-amber-500/10" : ""}`}>
					{linked ? <Link2 className="size-3" /> : <Unlink2 className="size-3" />}
					{linked ? "In step" : "Apart"}
				</button>
				<button type="button" onClick={onClose} title="Back to one run" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
					<X className="size-3.5" />
				</button>
			</div>
			<div className="shadow-card space-y-1.5 rounded-xl border bg-card p-2 font-mono text-[11px]">
				<div className="flex flex-wrap gap-1.5">
					{cmp.sections.map((x) => (
						<span key={x.name} title={`${cmp.label_a} ${x.total_a}, ${cmp.label_b} ${x.total_b}`} className={`rounded-md px-1.5 py-0.5 ${x.divergence ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"}`}>
							{x.divergence ? "✗" : "✓"} {x.name} {x.matched}/{Math.max(x.total_a, x.total_b)}
						</span>
					))}
					{cmp.uncompared.map(([n, a, b]) => (
						<span key={n} title="The two layouts differ: a slot map names the other side's slots" className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
							· storage {n} not compared ({a} / {b} writes)
						</span>
					))}
				</div>
				{d ? (
					<div className="space-y-0.5">
						{([[false, cmp.label_a, d.a_step, d.a], [true, cmp.label_b, d.b_step, d.b]] as const).map(([b, l, step, text]) => (
							<button key={String(b)} type="button" disabled={step === null} onClick={() => step !== null && onGo(b, step)} className="flex w-full gap-2 truncate rounded px-1 text-left enabled:hover:bg-muted" title={text ?? "(nothing)"}>
								<span className="w-20 shrink-0 truncate text-muted-foreground">{l}</span>
								<span className="w-16 shrink-0 tabular-nums text-muted-foreground">{step ?? "-"}</span>
								<span className="truncate">{text ?? "(nothing)"}</span>
							</button>
						))}
					</div>
				) : null}
				{cmp.uncompared.length || slotMap ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							onSlotMap(map.trim());
						}}
					>
						<span className="shrink-0 text-muted-foreground">slot map in {cmp.label_b}</span>
						<input value={map} onChange={(e) => setMap(e.target.value)} placeholder="storage-layout.json (solc storageLayout per contract name)" className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 outline-none focus:border-ring" />
						<button type="submit" className="h-6 rounded border bg-background px-2 hover:bg-muted">Compare again</button>
					</form>
				) : null}
			</div>
		</section>
	);
}

/** /debug?path=<folder>&file=<test file>&test=<Contract::test>: pick a test file, pick a test, debug it. */
/** The debugger on its own page (/debug?path=…&file=…&test=…). */
export function DebugPage() {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const folder = params.get("path") ?? "";
	return <DebugView folder={folder} file={params.get("file")} test={params.get("test")} onPick={(f) => navigate(`/debug?path=${encodeURIComponent(folder)}&file=${encodeURIComponent(f)}`, { replace: true })} />;
}

/** A folder's Foundry tests: pick a file, run a test, step through it (also Debug mode of a folder's page). */
export function DebugView({ folder, file, test: wanted, onPick, embedded }: { folder: string; file: string | null; test?: string | null; onPick: (file: string) => void; embedded?: boolean }) {
	const [scan, setScan] = useState<Scan | null>(null);
	const [session, setSession] = useState<{ id: number; file: string; tests: TestFn[] } | null>(null);
	const [opening, setOpening] = useState(false);
	const [running, setRunning] = useState<string | null>(null);
	const [run, setRun] = useState<(RunView & { key: string }) | null>(null);
	const [error, setError] = useState<string | null>(null);
	// "Compare with…": both runs, which one the keys move, and whether moving one moves the other.
	const [cmp, setCmp] = useState<(Compared & { key: string; other: string; slotMap: string }) | null>(null);
	const [comparing, setComparing] = useState(false);
	const [focusB, setFocusB] = useState(false);
	const [linked, setLinked] = useState(true);
	const typing = useRef(false);
	// Reported when the error changes (not when the file does), named after the file it came from.
	const where = useRef("");
	where.current = `Debug · ${file ?? name(folder)}`;
	useEffect(() => {
		if (error) reportError(where.current, error);
	}, [error]);

	useEffect(() => {
		setScan(null);
		invoke<Scan>("folder_scan", { path: folder }).then(setScan, (e) => setError(String(e)));
	}, [folder]);

	// Compile the picked file; a session lives until another file is picked or the page closes.
	useEffect(() => {
		if (!file) return;
		let id: number | null = null;
		let gone = false;
		setSession(null);
		setRun(null);
		setCmp(null);
		setError(null);
		setOpening(true);
		invoke<{ id: number; tests: TestFn[] }>("debug_open", { folder, file })
			.then((s) => {
				id = s.id;
				if (gone) void invoke("debug_close", { id });
				else setSession({ ...s, file });
			}, (e) => !gone && setError(String(e)))
			.finally(() => !gone && setOpening(false));
		return () => {
			gone = true;
			if (id !== null) void invoke("debug_close", { id });
		};
	}, [folder, file]);

	// The chain id runs use (scripts read deployments/<chainId>/ by it), kept per folder; the ones the folder has
	// deployments for are offered.
	const chainKey = `fm:chain:${folder}`;
	const [chain, setChainState] = useState(() => {
		try {
			return Number(localStorage.getItem(chainKey)) || 31337;
		} catch {
			return 31337;
		}
	});
	const setChain = (id: number) => {
		setChainState(id);
		try {
			localStorage.setItem(chainKey, String(id));
		} catch {
			/* not kept */
		}
	};
	const [chains, setChains] = useState<number[]>([]);
	// From a script's run prompt: the chain, and the Anvil fork to run on (a local URL).
	const [urlParams] = useSearchParams();
	const fork = urlParams.get("fork");
	const urlChain = Number(urlParams.get("chain")) || null;
	useEffect(() => {
		if (urlChain && urlChain !== chain) setChainState(urlChain);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [urlChain]);
	useEffect(() => {
		void invoke<{ files: string[] }>("folder_tree", { path: folder }).then(
			(t) => setChains([...new Set(t.files.map((f) => f.match(/^deployments\/(\d+)\//)?.[1]).filter(Boolean).map(Number))].sort((a, b) => a - b)),
			() => setChains([]),
		);
	}, [folder]);

	const start = useCallback(
		async (t: TestFn) => {
			if (!session) return;
			const key = `${t.contract}::${t.test}`;
			setRunning(key);
			setError(null);
			try {
				const r = await invoke<RunView>("debug_run", { id: session.id, contract: t.contract, test: t.test, chainId: chain, forkUrl: fork });
				setRun({ ...r, key });
				recordRun(folder, session.file, t.name, t.test, r.success);
				setCmp(null);
			} catch (e) {
				setError(String(e));
				// It couldn't run (setUp reverted, a cheatcode is missing…): that counts as failed.
				recordRun(folder, session.file, t.name, t.test, false);
			} finally {
				setRunning(null);
			}
		},
		[session, folder, chain, fork],
	);
	// A test named in the URL (`&test=Contract::test`) runs once its file has compiled, and again when it changes.
	useEffect(() => {
		const t = session?.tests.find((x) => `${x.name}::${x.test}` === wanted || x.test === wanted);
		if (t && run?.key !== `${t.contract}::${t.test}` && !running) void start(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session, wanted]);

	// A new chain runs the current one again.
	useEffect(() => {
		const t = session?.tests.find((x) => run && `${x.contract}::${x.test}` === run.key);
		if (t && !running) void start(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chain]);

	// Scripts first (what production runs), then tests.
	const tests = useMemo(() => {
		const all = scan?.solidity ?? [];
		return [...all.filter(isScript).sort(), ...all.filter(isTest)];
	}, [scan]);
	const pick = onPick;
	const onView = useCallback((v: StepView) => setRun((r) => (r ? { ...r, view: v } : r)), []);

	const compare = useCallback(
		async (other: string, slotMap = "") => {
			const t = session?.tests.find((x) => run && `${x.contract}::${x.test}` === run.key);
			if (!session || !t || !run) return;
			setComparing(true);
			setError(null);
			try {
				const c = await invoke<Compared>("debug_compare", { id: session.id, other, contract: t.contract, test: t.test, slotMap: slotMap || null });
				setCmp({ ...c, key: `${run.key}@${other}#${Date.now()}`, other, slotMap });
				setRun((r) => (r ? { ...r, ...c.a } : r));
				setFocusB(false);
			} catch (e) {
				setError(String(e));
			} finally {
				setComparing(false);
			}
		},
		[session, run],
	);
	const setSide = useCallback((b: boolean, v: StepView) => setCmp((c) => (c ? { ...c, [b ? "b" : "a"]: { ...c[b ? "b" : "a"], view: v } } : c)), []);
	const onViewA = useCallback((v: StepView) => setSide(false, v), [setSide]);
	const onViewB = useCallback((v: StepView) => setSide(true, v), [setSide]);
	// In step: the other side goes to the start of the same external call.
	const follow = useCallback(
		(b: boolean) => {
			if (!linked || !session) return;
			void invoke<StepView>("debug_sync", { id: session.id, b }).then((v) => setSide(!b, v), () => {});
		},
		[linked, session, setSide],
	);
	const onMovedA = useCallback(() => follow(false), [follow]);
	const onMovedB = useCallback(() => follow(true), [follow]);
	const home = useCallback(() => {
		const d = cmp?.first;
		if (!d || !session) return;
		for (const [b, step] of [[false, d.a_step], [true, d.b_step]] as const) {
			if (step !== null) void invoke<StepView>("debug_nav", { id: session.id, to: "step", back: false, arg: String(step), b }).then((v) => setSide(b, v), () => {});
		}
	}, [cmp, session, setSide]);
	const goSide = useCallback(
		(b: boolean, step: number) => {
			if (!session) return;
			setFocusB(b);
			void invoke<StepView>("debug_nav", { id: session.id, to: "step", back: false, arg: String(step), b }).then((v) => setSide(b, v), () => {});
		},
		[session, setSide],
	);
	// Tab switches the side the keys move; = puts both back at the divergence (the TUI's split view).
	useEffect(() => {
		if (!cmp) return;
		const onKey = (e: KeyboardEvent) => {
			if (typing.current || e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
			if (e.key === "Tab") {
				e.preventDefault();
				setFocusB((f) => !f);
			} else if (e.key === "=") {
				e.preventDefault();
				home();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [cmp, home]);

	return (
		<div className="flex h-full min-h-0 flex-1 gap-2 p-2">
			{/* In a folder's Debug mode the sidebar's file tree lists the scripts and tests instead. */}
			{embedded ? null : <aside className="flex w-60 shrink-0 flex-col rounded-2xl border bg-muted/80 p-1">
				<div className="flex h-7 shrink-0 items-center gap-2 px-2.5">
					<FlaskConical className="size-3.5 text-muted-foreground" />
					<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tests</span>
					<span className="min-w-0 truncate text-[11px] text-muted-foreground" title={folder}>{name(folder)}</span>
				</div>
				<div className="shadow-card min-h-0 flex-1 overflow-y-auto rounded-xl border bg-card">
					{scan === null ? <p className="p-3 text-[13px] text-muted-foreground">Reading the folder…</p> : (
						<TestTree files={tests} selected={file} tests={session?.file === file ? session.tests : null} opening={opening} running={running} current={run?.key ?? null} onFile={pick} onTest={(t) => void start(t)} />
					)}
				</div>
			</aside>}
			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="mb-2 flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
					{fork ? (
						<span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-emerald-800 dark:text-emerald-300" title={`State read from the Anvil fork at ${fork}`}>
							<span className="size-1.5 rounded-full bg-emerald-500" />
							fork {fork.replace(/^https?:\/\/(127\.0\.0\.1|localhost)/, "")} · chain {chain}
						</span>
					) : null}
					<label className={`items-center gap-1.5 ${fork ? "hidden" : "inline-flex"}`} title="What block.chainid reads. Scripts read deployments/<chainId>/ by it; forge's local chain is 31337.">
						<span className="font-mono uppercase tracking-wider">Chain</span>
						<select
							value={chain}
							onChange={(e) => setChain(Number(e.target.value))}
							className="h-6 rounded-md border bg-background px-1.5 font-mono text-[11px] text-foreground"
						>
							{[...new Set([31337, ...chains, chain])].map((id) => (
								<option key={id} value={id}>
									{id}
									{id === 31337 ? " · local" : chains.includes(id) ? " · deployments" : ""}
								</option>
							))}
						</select>
					</label>
				</div>
				{error ? <p className="mb-2 whitespace-pre-wrap rounded-xl border border-red-500/30 bg-red-50/80 p-3 font-mono text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{error}</p> : null}
				{cmp && session ? (
					<>
						<Report key={cmp.key} cmp={cmp} linked={linked} slotMap={cmp.slotMap} onLink={() => setLinked((l) => !l)} onHome={home} onGo={goSide} onSlotMap={(m) => void compare(cmp.other, m)} onClose={() => {
							// Back to one run, where side a is now.
							setRun((r) => (r ? { ...r, ...cmp.a } : r));
							setCmp(null);
						}} />
						<div className="flex min-h-0 flex-1 flex-col gap-2">
							<Debugger key={`a${cmp.key}`} id={session.id} run={cmp.a} onView={onViewA} label={cmp.label_a} focused={!focusB} typing={typing} onFocus={() => setFocusB(false)} onMoved={onMovedA} />
							<Debugger key={`b${cmp.key}`} id={session.id} run={cmp.b} onView={onViewB} side label={cmp.label_b} focused={focusB} typing={typing} onFocus={() => setFocusB(true)} onMoved={onMovedB} />
						</div>
					</>
				) : run && session ? (
					<Debugger key={run.key + run.title} id={session.id} run={run} onView={onView} actions={<CompareMenu folder={folder} busy={comparing} onPick={(o) => void compare(o)} />} />
				) : (
					<div className="grid flex-1 place-items-center">
						<div className="max-w-sm space-y-2 text-center text-[13px] text-muted-foreground">
							<Bug className="mx-auto size-6" />
							<p className="font-medium text-foreground">{running || opening ? "Compiling and running…" : embedded ? "Pick a script or test in the sidebar" : file ? "Pick a test to debug" : "Pick a test file"}</p>
							{embedded ? <p>Open the ›  beside a file under script/ or test/ to list its run…() and test…() functions; click one to debug it.</p> : null}
							<p>It runs in an embedded EVM after solc compiles it (no forge). Every opcode is mapped to its line and AST node, and storage is named by the layout. Step with vim keys: {KEYS}.</p>
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
