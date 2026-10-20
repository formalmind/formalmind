import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { Bug, ChevronRight, FileCode2, FlaskConical, Loader2, Play } from "lucide-react";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import type { Scan } from "./local";

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

const KEYS = "j/k op · n/N line · s/S into · f/F out · c/C continue · g/G ends · /search ;, · :b line · :w var · :pc n · :step n";
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const isTest = (f: string) => f.endsWith(".t.sol");

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
		<Pane title="Opcodes" meta={`pc ${view.pc}`} scrollRef={ref}>
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
		<Pane title="Stack" className="flex-[0.7]" meta={view.result ? `result ${view.result.short}` : `${view.stack.length}`}>
			<ul className="py-1">
				{view.stack.map((w, i) => (
					<li key={i} title={w.full} className="flex gap-2 px-2">
						<span className="w-5 shrink-0 text-right text-muted-foreground">{i}</span>
						<span className="truncate">{w.short}</span>
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
		<Pane title="Memory" meta={`${view.memory_size} bytes`} className="flex-[1.3]" scrollRef={ref}>
			<ul className="py-1">
				{view.memory.map((m) => (
					<li key={m.offset} data-current={m.fresh || undefined} className={`flex gap-2 px-2 ${m.fresh ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : ""}`}>
						<span className="w-10 shrink-0 text-right text-muted-foreground">{m.offset.toString(16)}{m.offset === 0x40 ? "·fp" : ""}</span>
						<span className="break-all">{m.hex}</span>
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
function Debugger({ id, run, onView }: { id: number; run: RunView; onView: (v: StepView) => void }) {
	const view = run.view;
	const [files, setFiles] = useState<Record<number, { name: string; text: string }>>({});
	const [input, setInput] = useState<string | null>(null);
	const [search, setSearch] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const busy = useRef(false);
	const file = view.place?.file;
	useEffect(() => {
		if (file === undefined || files[file]) return;
		void invoke<{ name: string; text: string }>("debug_file", { id, file }).then((f) => setFiles((all) => ({ ...all, [file]: f })), (e) => setError(String(e)));
	}, [id, file, files]);

	const call = useCallback(
		async (cmd: string, args: Record<string, unknown>) => {
			if (busy.current) return;
			busy.current = true;
			try {
				onView(await invoke<StepView>(cmd, { id, ...args }));
				setError(null);
			} catch (e) {
				setError(String(e));
			} finally {
				busy.current = false;
			}
		},
		[id, onView],
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
			if (e.metaKey || e.ctrlKey || e.altKey) return;
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
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[13px]">
				<span className="font-medium">{run.title}</span>
				<span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${run.success ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-red-500/15 text-red-700 dark:text-red-400"}`}>{run.success ? "pass" : run.verdict}</span>
				<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
					step {view.step}/{view.total - 1} · depth {view.depth} · pc {view.pc} · {view.op} · gas {view.gas.toLocaleString()}
				</span>
				{run.missing.length ? <span className="text-[11px] text-amber-600">unsupported cheatcodes: {run.missing.join(", ")}</span> : null}
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
			{files.length === 0 ? <li className="p-2 font-sans text-[13px] text-muted-foreground">No Foundry tests (*.t.sol) in this folder.</li> : null}
			{dirs.map(([dir, list]) => (
				<li key={dir}>
					<p className="px-1.5 pb-0.5 text-muted-foreground">{dir}/</p>
					<ul>
						{list.map((f) => (
							<li key={f}>
								<button type="button" onClick={() => onFile(f)} className={`flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-muted ${selected === f ? "bg-muted font-medium" : ""}`} title={f}>
									<ChevronRight className={`size-3 shrink-0 text-muted-foreground transition-transform ${selected === f ? "rotate-90" : ""}`} />
									<FileCode2 className="size-3 shrink-0 text-sky-500" />
									<span className="truncate">{name(f)}</span>
								</button>
								{selected === f ? (
									<ul className="ml-4 border-l pl-1">
										{opening ? <li className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground"><Loader2 className="size-3 animate-spin" />Compiling with solc…</li> : null}
										{tests?.length === 0 ? <li className="px-1.5 py-1 text-muted-foreground">No test…() functions</li> : null}
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

/** /debug?path=<folder>&file=<test file>&test=<Contract::test>: pick a test file, pick a test, debug it. */
export function DebugPage() {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const folder = params.get("path") ?? "";
	const file = params.get("file");
	const wanted = params.get("test");
	const [scan, setScan] = useState<Scan | null>(null);
	const [session, setSession] = useState<{ id: number; file: string; tests: TestFn[] } | null>(null);
	const [opening, setOpening] = useState(false);
	const [running, setRunning] = useState<string | null>(null);
	const [run, setRun] = useState<(RunView & { key: string }) | null>(null);
	const [error, setError] = useState<string | null>(null);

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

	const start = useCallback(
		async (t: TestFn) => {
			if (!session) return;
			const key = `${t.contract}::${t.test}`;
			setRunning(key);
			setError(null);
			try {
				const r = await invoke<RunView>("debug_run", { id: session.id, contract: t.contract, test: t.test });
				setRun({ ...r, key });
			} catch (e) {
				setError(String(e));
			} finally {
				setRunning(null);
			}
		},
		[session],
	);
	// A test named in the URL (`&test=Contract::test`) runs as soon as its file has compiled.
	useEffect(() => {
		const t = session?.tests.find((x) => `${x.name}::${x.test}` === wanted || x.test === wanted);
		if (t && !run && !running) void start(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session]);

	const tests = useMemo(() => (scan?.solidity ?? []).filter(isTest), [scan]);
	const pick = (f: string) => navigate(`/debug?path=${encodeURIComponent(folder)}&file=${encodeURIComponent(f)}`, { replace: true });
	const onView = useCallback((v: StepView) => setRun((r) => (r ? { ...r, view: v } : r)), []);

	return (
		<div className="flex h-full min-h-0 flex-1 gap-2 p-2">
			<aside className="flex w-60 shrink-0 flex-col rounded-2xl border bg-muted/80 p-1">
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
			</aside>
			<main className="flex min-h-0 min-w-0 flex-1 flex-col">
				{error ? <p className="mb-2 whitespace-pre-wrap rounded-xl border border-red-500/30 bg-red-50/80 p-3 font-mono text-[11px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{error}</p> : null}
				{run && session ? (
					<Debugger key={run.key + run.title} id={session.id} run={run} onView={onView} />
				) : (
					<div className="grid flex-1 place-items-center">
						<div className="max-w-sm space-y-2 text-center text-[13px] text-muted-foreground">
							<Bug className="mx-auto size-6" />
							<p className="font-medium text-foreground">{running ? "Running the test…" : file ? "Pick a test to debug" : "Pick a test file"}</p>
							<p>The test runs in an embedded EVM after solc compiles it (no forge). Every opcode is mapped to its line and AST node, and storage is named by the layout. Step with vim keys: {KEYS}.</p>
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
