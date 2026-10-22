import { useEffect, useState } from "react";
import { ChevronRight, FileCode2, Loader2, RotateCw, SquareArrowOutUpRight } from "lucide-react";
import { FileView, fnStatus } from "./swarm-panel";
import type { Bridge, Formal, FormalFn, GutterMark } from "./swarm-panel";
import { mappedSources } from "./proof-mapping";

/** A function's identity: several share a name (overloads, or the same library compiled twice), so add where it is. */
export const fnKey = (f: FormalFn) => `${f.name}@${f.file ?? ""}:${f.line}`;

/**
 * The Lean coverage of the Solidity file open in Code: `ast_formal` with the file as the entry (the same reading the
 * Proofs tab does), and the file's own functions. A library, interface or types file has no model of its own.
 */
export function useFileProofs(folder: string, path: string | null, invoke: Bridge["invoke"]) {
	const [data, setData] = useState<Formal | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (!path) return;
		let active = true;
		setData(null);
		setError(null);
		void invoke<Formal>("ast_formal", { folder, entry: path }).then(
			(v) => active && setData(v),
			(e) => active && setError(String(e)),
		);
		return () => {
			active = false;
		};
	}, [folder, path, invoke, revision]);
	const functions = (data?.functions ?? []).filter((f) => f.file === path);
	return { data, error, functions, loading: !!path && !data && !error, refresh: () => setRevision((r) => r + 1) };
}

/** The gutter marks for a file's functions: each first line's number, coloured by its proof status. */
export function proofGutter(data: Formal | null, functions: FormalFn[], onPick: (f: FormalFn) => void): Map<number, GutterMark> {
	const marks = new Map<number, GutterMark>();
	if (!data) return marks;
	for (const f of functions) {
		const st = fnStatus(f, data.theorems);
		const n = f.theorems.length;
		marks.set(f.line - 1, { text: st.text, title: `${f.name.split(".").pop()}: ${st.label}${n ? ` · ${n} theorem${n === 1 ? "" : "s"}` : ""}`, onClick: () => onPick(f) });
	}
	return marks;
}

const section = "px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground";

/**
 * The Proofs rail beside a Solidity file: the file's functions with their status (the same dots as the gutter), and
 * for the one picked, its Lean model and the theorems that name it. Opening a theorem takes Code to the Lean file at
 * that line (the Mac app opens it in the Lean editor, with live goals).
 */
export function ProofRail({ proofs, selected, onSelect, onOpenFile }: { proofs: ReturnType<typeof useFileProofs>; selected: string | null; onSelect: (f: FormalFn) => void; onOpenFile: (path: string, line?: number) => void }) {
	const { data, error, functions, loading, refresh } = proofs;
	const fn = functions.find((f) => fnKey(f) === selected) ?? functions[0] ?? null;
	const [showModel, setShowModel] = useState(false);
	const [allTheorems, setAllTheorems] = useState(false);
	useEffect(() => {
		setShowModel(false);
		setAllTheorems(false);
	}, [selected]);
	const counts = data ? functions.map((f) => fnStatus(f, data.theorems).key) : [];
	const proved = counts.filter((k) => k === "proved").length;
	const opaque = counts.filter((k) => k === "opaque").length;
	const status = fn && data ? fnStatus(fn, data.theorems) : null;
	const theorems = fn && data ? fn.theorems.map((i) => ({ i, t: data.theorems[i] })) : [];
	const shown = allTheorems ? theorems : theorems.slice(0, 3);
	return (
		<aside aria-label="Proofs for this file" className="flex min-h-0 w-[min(26rem,42%)] shrink-0 flex-col border-l bg-background text-[12px]">
			<header className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Proofs</span>
				{data ? <span className="truncate text-[11px] text-muted-foreground">{data.contract}</span> : null}
				<button type="button" onClick={refresh} title="Read the AST and the Lean files again" className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
					<RotateCw className={`size-3 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />
				</button>
			</header>
			{loading ? (
				<p className="flex items-center gap-2 px-3 py-3 text-muted-foreground">
					<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
					Building the Lean model from the AST…
				</p>
			) : null}
			{error ? (
				/no contract|no deployable|libraries, interfaces and types/i.test(error) ? (
					<p className="px-3 py-3 leading-5 text-muted-foreground">No contract to model in this file. Its functions show under the contracts that use them: open one of those, or the Proofs tab.</p>
				) : (
					<div className="m-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
						<p className="font-medium text-red-700 dark:text-red-400">The AST didn't build</p>
						<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground">{error}</pre>
					</div>
				)
			) : null}
			{data && !functions.length ? <p className="px-3 py-3 text-muted-foreground">None of {data.contract}'s functions are written in this file.</p> : null}
			{data && functions.length ? (
				<>
					<div className="flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-[11px]">
						<span>
							<span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">{proved}</span>
							<span className="text-muted-foreground">/{functions.length} proved</span>
						</span>
						{opaque ? (
							<span>
								<span className="font-mono font-medium text-amber-700 dark:text-amber-400">{opaque}</span>
								<span className="text-muted-foreground"> not modeled</span>
							</span>
						) : null}
						<span className="ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-muted" title={`${proved} of ${functions.length} proved`}>
							<span className="block h-full rounded-full bg-emerald-500" style={{ width: `${(proved / functions.length) * 100}%` }} />
						</span>
					</div>
					<nav className="max-h-[38%] shrink-0 overflow-y-auto border-b p-1">
						{functions.map((f) => {
							const st = fnStatus(f, data.theorems);
							const on = fn && fnKey(f) === fnKey(fn);
							return (
								<button key={fnKey(f)} type="button" onClick={() => onSelect(f)} title={st.label} className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px] ${on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
									<span className={`size-2 shrink-0 rounded-full ${st.dot}`} />
									<span className="truncate">{f.name.split(".").pop()}</span>
									<span className="ml-auto shrink-0 text-[10px]">{f.theorems.length || ""}</span>
									<span className="w-9 shrink-0 text-right text-[10px] text-muted-foreground/60">{f.line}</span>
								</button>
							);
						})}
					</nav>
				</>
			) : null}
			{fn && status && data ? (
				<div className="min-h-0 flex-1 overflow-y-auto pb-3">
					<div className="flex flex-wrap items-center gap-2 px-3 pt-3">
						<span className="font-mono text-[13px] font-medium">{fn.name}</span>
						<span className={`inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] ${status.text}`}>
							<span className={`size-1.5 rounded-full ${status.dot}`} />
							{status.label}
						</span>
					</div>
					<p className="px-3 pt-1 text-[11px] text-muted-foreground">
						{fn.visibility} {fn.mutability} · lines {fn.line}–{fn.endLine}
					</p>
					{fn.why ? (
						<div className="mx-3 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 leading-5">
							<p className="font-medium text-amber-800 dark:text-amber-300">Not translated: {fn.why}</p>
							<p className="mt-1 text-muted-foreground">
								The model keeps it as <code className="rounded bg-muted px-1 font-mono text-[11px]">ext.{fn.lean}</code>, so every theorem holds for any behaviour of it.
							</p>
						</div>
					) : (
						<>
							<button type="button" onClick={() => setShowModel((v) => !v)} aria-expanded={showModel} className={`${section} flex w-full items-center gap-1 text-left hover:text-foreground`}>
								<ChevronRight className={`size-3 transition-transform ${showModel ? "rotate-90" : ""}`} />
								Lean model <span className="normal-case tracking-normal">· {fn.lean}</span>
							</button>
							{showModel && fn.def ? (
								<div className="mx-2 max-h-72 overflow-auto rounded-lg border bg-muted/30">
									<FileView path="f.lean" text={fn.def.trimEnd()} />
								</div>
							) : null}
						</>
					)}
					<p className={section}>Theorems · {theorems.length}</p>
					{theorems.length === 0 ? (
						<p className="px-3 leading-5 text-muted-foreground">{fn.why ? "Nothing to prove about it until it's modeled." : <>No theorem in this folder names <code className="font-mono text-[11px]">{fn.lean}</code> yet.</>}</p>
					) : null}
					{shown.map(({ i, t }) => {
						const others = mappedSources(data, i).filter((g) => fnKey(g) !== fnKey(fn));
						return (
							<div key={i} className={`mx-2 mb-2 overflow-hidden rounded-lg border ${t.sorry ? "border-sky-500/30 bg-sky-500/[0.06]" : "border-emerald-500/30 bg-emerald-500/10"}`}>
								<div className={`flex items-center gap-2 border-b px-2.5 py-1 text-[11px] ${t.sorry ? "border-sky-500/20" : "border-emerald-500/20"}`}>
									<span className={`size-1.5 shrink-0 rounded-full ${t.sorry ? "bg-sky-500" : "bg-emerald-500"}`} />
									<span className="truncate font-mono font-medium">{t.name}</span>
									{t.sorry ? <span className="text-sky-700 dark:text-sky-400">sorry</span> : null}
									<button type="button" onClick={() => onOpenFile(t.file, t.line)} title={`Open ${t.file}:${t.line}`} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 text-muted-foreground hover:bg-background/60 hover:text-foreground">
										<SquareArrowOutUpRight className="size-3" />
										Open
									</button>
								</div>
								<div className="max-h-56 overflow-auto">
									<FileView path="f.lean" text={t.text} start={t.line} />
								</div>
								{others.length ? (
									<p className="flex flex-wrap items-center gap-1 border-t border-inherit px-2.5 py-1 text-[11px] text-muted-foreground">
										Also names
										{others.slice(0, 6).map((g) => (
											<button key={fnKey(g)} type="button" onClick={() => (g.file && functions.some((h) => fnKey(h) === fnKey(g)) ? onSelect(g) : g.file && onOpenFile(g.file, g.line))} className="rounded bg-background/70 px-1 font-mono hover:text-foreground">
												{g.name.split(".").pop()}
											</button>
										))}
										{others.length > 6 ? <span>+{others.length - 6}</span> : null}
									</p>
								) : null}
							</div>
						);
					})}
					{theorems.length > 3 ? (
						<button type="button" onClick={() => setAllTheorems((v) => !v)} className="mx-3 text-[11px] text-muted-foreground hover:text-foreground">
							{allTheorems ? "Show fewer" : `Show all ${theorems.length}`}
						</button>
					) : null}
					<p className="mx-3 mt-3 flex gap-1.5 text-[11px] leading-4 text-muted-foreground">
						<FileCode2 className="mt-px size-3 shrink-0" />
						Proved means a finished theorem names this function's Lean model. Lean checks the theorem; it doesn't check the model against the bytecode.
					</p>
				</div>
			) : null}
		</aside>
	);
}
