import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, FileCode2 } from "lucide-react";
import { ShelvesSkeleton } from "./bar";
import { readEntryPoints, setMainEntryPoint } from "@/lib/entry-points";
import { FileView, fnStatus, type Bridge, type Formal, type FormalFn, type FormalTheorem } from "@/desktop/src/swarm-panel";

const support = (f: string) => /(^|\/)(libraries|interfaces|types|utils)\//.test(f) || /\/I[A-Z]\w*\.sol$/.test(f);
const short = (name: string) => name.split(".").pop() ?? name;
const fnKey = (f: FormalFn) => `${f.name}@${f.file ?? ""}:${f.line}`;

/** A horizontal row of cards under a label, the way iOS shelves scroll: snapping, with the next card peeking in. */
function Shelf({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
	if (!count) return null;
	return (
		<section className="space-y-2">
			<header className="flex items-baseline gap-2 px-4">
				<h2 className="text-[20px] font-semibold tracking-tight">{label}</h2>
				<span className="font-mono text-[12px] text-muted-foreground">{count}</span>
			</header>
			<div className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>
		</section>
	);
}

const TONE: Record<string, string> = {
	proved: "text-emerald-600 dark:text-emerald-400",
	sorry: "text-sky-600 dark:text-sky-400",
	modeled: "text-violet-600 dark:text-violet-400",
	opaque: "text-amber-600 dark:text-amber-400",
};

/** A contract's coverage: how much is proved, as the Proofs explorer opens with it (and the introduction shows). */
export function CoverageCard({ contract, theorems, proved, notYet, opaque, className = "" }: { contract: string; theorems: number; proved: number; notYet: number; opaque: number; className?: string }) {
	const total = proved + notYet + opaque;
	const pct = total ? Math.round((proved / total) * 1000) / 10 : 0;
	return (
		<section className={`rounded-2xl border bg-muted/60 p-1.5 ${className}`}>
			<p className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
				{contract}
				<span className="ml-auto normal-case tracking-normal">{theorems} theorems</span>
			</p>
			<div className="shadow-card rounded-xl border bg-card p-4">
				<div className="flex items-end justify-between">
					<span className="font-display text-[44px] leading-none">{pct}%</span>
					<span className="pb-1 text-[13px] text-muted-foreground">proved</span>
				</div>
				<div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
					<div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
				</div>
				<div className="mt-3 grid grid-cols-3 text-center">
					{[
						[proved, "proved", TONE.proved],
						[notYet, "not yet", TONE.modeled],
						[opaque, "not modeled", TONE.opaque],
					].map(([n, l, tone]) => (
						<span key={l as string}>
							<span className={`block font-mono text-[18px] font-medium ${tone}`}>{n}</span>
							<span className="text-[11px] text-muted-foreground">{l}</span>
						</span>
					))}
				</div>
			</div>
		</section>
	);
}

/** A function as a card: its name, where it stands, its kind, its theorems, and the first lines of its Solidity. */
/** A theorem: checked or not, where it lives, and its first lines (`full`: all of it, wrapped). */
export function TheoremCard({ t, onOpen, full = false, className = "w-[78%] max-w-[300px] shrink-0 snap-start" }: { t: FormalTheorem; onOpen?: () => void; full?: boolean; className?: string }) {
	return (
		<button type="button" onClick={onOpen} className={`flex flex-col rounded-2xl border bg-card p-3.5 text-left shadow-card active:bg-muted/40 ${className}`}>
			<span className={`text-[12px] font-medium ${t.sorry ? TONE.sorry : TONE.proved}`}>{t.sorry ? "Has sorry" : "Checked"}</span>
			<span className="mt-1 truncate font-mono text-[14px] font-medium">{t.name}</span>
			<span className="truncate font-mono text-[11px] text-muted-foreground">{t.file.split("/").pop()}:{t.line}</span>
			<pre className={`mt-3 overflow-hidden rounded-lg bg-muted/60 px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-muted-foreground ${full ? "whitespace-pre-wrap break-words" : "h-[60px]"}`}>
				{full ? t.text.trimEnd() : t.text.split("\n").slice(0, 4).join("\n")}
			</pre>
		</button>
	);
}

export function FnCard({ f, theorems, onOpen, className = "w-[78%] max-w-[300px] shrink-0 snap-start" }: { f: FormalFn; theorems: FormalTheorem[]; onOpen: () => void; className?: string }) {
	const st = fnStatus(f, theorems);
	return (
		<button type="button" onClick={onOpen} className={`flex flex-col rounded-2xl border bg-card p-3.5 text-left shadow-card active:scale-[0.98] active:bg-muted/40 ${className}`}>
			<span className={`text-[12px] font-medium ${TONE[st.key]}`}>{st.label}</span>
			<span className="mt-1 truncate font-mono text-[15px] font-medium">{short(f.name)}</span>
			<span className="truncate text-[12px] text-muted-foreground">
				{[f.name.split(".").slice(0, -1).join("."), f.mutability || f.kind].filter(Boolean).join(" · ")}
			</span>
			<pre className="mt-3 h-[60px] overflow-hidden rounded-lg bg-muted/60 px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-muted-foreground">{f.solidity.split("\n").slice(0, 4).join("\n")}</pre>
			<span className="mt-2.5 text-[12px] text-muted-foreground">{f.theorems.length ? `${f.theorems.length} theorem${f.theorems.length === 1 ? "" : "s"}` : f.why ? "Kept opaque" : "No theorem yet"}</span>
		</button>
	);
}

/** One function in full: its Solidity, its Lean spec (or why it isn't modeled), and the theorems that name it. */
function FnDetail({ f, data, onBack, onOpenFile }: { f: FormalFn; data: Formal; onBack: () => void; onOpenFile: (path: string) => void }) {
	const st = fnStatus(f, data.theorems);
	const section = "rounded-2xl border bg-muted/60 p-1.5";
	const label = "flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
	return (
		<div className="fixed inset-0 z-40 overflow-y-auto bg-background">
			<header className="fm-safe-top sticky top-0 z-10 border-b bg-background/85 backdrop-blur-xl">
				<div className="flex h-12 items-center gap-1 px-2">
					<button type="button" onClick={onBack} aria-label="Back" className="grid size-10 place-items-center rounded-full active:bg-muted">
						<ChevronLeft className="size-6" />
					</button>
					<div className="min-w-0 flex-1">
						<h1 className="truncate font-mono text-[15px] font-semibold">{short(f.name)}</h1>
						<p className={`truncate text-[12px] ${TONE[st.key]}`}>{st.label}</p>
					</div>
				</div>
			</header>
			<main className="fm-safe-bottom space-y-4 px-4 py-4">
				<section className={section}>
					<p className={label}>
						Solidity
						{f.file ? (
							<button type="button" onClick={() => onOpenFile(f.file!)} className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal active:text-foreground">
								<FileCode2 className="size-3.5" />
								{f.file.split("/").pop()}:{f.line}
							</button>
						) : null}
					</p>
					<div className="shadow-card overflow-hidden rounded-xl border bg-card">
						<FileView path="f.sol" text={f.solidity} start={f.line} />
					</div>
				</section>
				<section className={section}>
					<p className={label}>Lean spec{f.def ? ` · ${f.lean}` : ""}</p>
					<div className="shadow-card overflow-hidden rounded-xl border bg-card">
						{f.def ? (
							<FileView path="f.lean" text={f.def.trimEnd()} />
						) : (
							<p className="p-3 text-[13px] leading-5">
								<span className="font-medium text-amber-700 dark:text-amber-400">Not translated: {f.why}</span>
								<span className="mt-1 block text-muted-foreground">The model keeps it as ext.{f.lean}, so every theorem holds for any behaviour of it.</span>
							</p>
						)}
					</div>
				</section>
				<section className={section}>
					<p className={label}>Proofs · {f.theorems.length}</p>
					{f.theorems.length ? (
						<div className="space-y-2">
							{f.theorems.map((i) => {
								const t = data.theorems[i];
								return (
									<div key={i} className="shadow-card overflow-hidden rounded-xl border bg-card">
										<p className="flex items-center gap-2 border-b px-3 py-1.5 text-[12px]">
											<span className={`font-mono font-medium ${t.sorry ? "text-sky-600 dark:text-sky-400" : "text-emerald-600 dark:text-emerald-400"}`}>{t.name}</span>
											{t.sorry ? <span className="text-sky-600 dark:text-sky-400">sorry</span> : null}
										</p>
										<FileView path="f.lean" text={t.text} start={t.line} />
									</div>
								);
							})}
						</div>
					) : (
						<p className="shadow-card rounded-xl border bg-card p-3 text-[13px] text-muted-foreground">No proof in this repository names it yet.</p>
					)}
				</section>
			</main>
		</div>
	);
}

/**
 * Proofs on the phone, as an explorer: the contracts across the top, the coverage, then shelves of cards (entry
 * points, proved, not proved yet, not modeled, theorems) to scroll sideways; a card opens the function in full.
 * The data is the Proofs tab's (formal-ast and solc-js in the webview, through the bridge).
 */
export function ProofsExplorer({ repo, sources, invoke, onOpenFile }: { repo: string; sources: string[] | null; invoke: Bridge["invoke"]; onOpenFile: (path: string) => void }) {
	const contracts = useMemo(() => (sources ?? []).filter((f) => !f.endsWith(".t.sol") && !f.endsWith(".s.sol") && !support(f)), [sources]);
	const [noModel, setNoModel] = useState<string[]>([]);
	const shown = contracts.filter((f) => !noModel.includes(f));
	const preferred = readEntryPoints(repo).find((f) => shown.includes(f)) ?? shown.find((f) => f.startsWith("src/")) ?? shown[0] ?? null;
	const [entry, setEntry] = useState<string | null>(null);
	const current = entry ?? preferred;
	const [data, setData] = useState<Formal | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<FormalFn | null>(null);
	useEffect(() => {
		if (!current) return;
		let live = true;
		setData(null);
		setError(null);
		invoke<Formal>("ast_formal", { folder: repo, entry: current }).then(
			(d) => live && setData(d),
			(e) => {
				if (!live) return;
				const msg = String(e);
				if (/no contract|no deployable|libraries, interfaces and types/i.test(msg)) setNoModel((n) => [...n, current]);
				else setError(msg);
			},
		);
		return () => {
			live = false;
		};
	}, [repo, current, invoke]);

	const fns = data?.functions ?? [];
	const by = (key: string) => fns.filter((f) => data && fnStatus(f, data.theorems).key === key);
	const proved = by("proved");
	const notProved = [...by("modeled"), ...by("sorry")];
	const opaque = by("opaque");
	const pct = fns.length ? Math.round((proved.length / fns.length) * 1000) / 10 : 0;
	const card = (f: FormalFn) => <FnCard key={fnKey(f)} f={f} theorems={data!.theorems} onOpen={() => setOpen(f)} />;

	return (
		<div className="fm-under-tabs min-h-0 flex-1 space-y-6 overflow-y-auto pb-4 pt-3">
			{/* The contracts, as chips to scroll sideways; picking one makes it this repository's main entry point. */}
			<div className="flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{shown.map((f) => (
					<button
						key={f}
						type="button"
						onClick={() => {
							setEntry(f);
							setMainEntryPoint(repo, f);
						}}
						className={`h-9 shrink-0 rounded-full border px-3.5 font-mono text-[13px] ${f === current ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground"}`}
					>
						{f.split("/").pop()?.replace(/\.sol$/, "")}
					</button>
				))}
			</div>

			{!data && !error ? <ShelvesSkeleton /> : null}
			{error ? <p className="mx-4 whitespace-pre-wrap rounded-2xl border bg-card p-3 font-mono text-[12px] text-red-600">{error}</p> : null}

			{data ? (
				<>
					<CoverageCard contract={data.contract} theorems={data.theorems.length} proved={proved.length} notYet={notProved.length} opaque={opaque.length} className="mx-4" />
					<Shelf label="Entry points" count={fns.filter((f) => f.entry).length}>{fns.filter((f) => f.entry).map(card)}</Shelf>
					<Shelf label="Not proved yet" count={notProved.length}>{notProved.map(card)}</Shelf>
					<Shelf label="Proved" count={proved.length}>{proved.map(card)}</Shelf>
					<Shelf label="Not modeled" count={opaque.length}>{opaque.map(card)}</Shelf>
					<Shelf label="Theorems" count={data.theorems.length}>
						{data.theorems.map((t, i) => (
							<TheoremCard key={i} t={t} onOpen={() => onOpenFile(t.file)} />
						))}
					</Shelf>
				</>
			) : null}
			{open && data ? <FnDetail f={open} data={data} onBack={() => setOpen(null)} onOpenFile={(p) => (setOpen(null), onOpenFile(p))} /> : null}
		</div>
	);
}
