import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { FileView } from "./swarm-panel";
import type { Bridge, Formal } from "./swarm-panel";
import { mappedSources } from "./proof-mapping";

export function CodeProofPanel({ folder, path, invoke, onOpenFile, onOpenProof }: {
	folder: string; path: string; invoke: Bridge["invoke"];
	onOpenFile: (path: string, line?: number) => void;
	onOpenProof: (path: string, specId: string, line?: number) => void;
}) {
	const [data, setData] = useState<Formal | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [theorem, setTheorem] = useState<number | null>(null);
	const [showCode, setShowCode] = useState(false);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let active = true;
		setData(null); setError(null); setSelected(0); setTheorem(null);
		void invoke<Formal>("ast_formal", { folder, entry: path }).then(value => { if (active) setData(value); }, e => { if (active) setError(String(e)); });
		return () => { active = false; };
	}, [folder, path, invoke, revision]);
	const functions = data?.functions.filter(f => f.file === path) ?? [];
	const fn = functions[selected];
	const theoremIndex = theorem !== null && fn?.theorems.includes(theorem) ? theorem : fn?.theorems[0];
	const spec = theoremIndex === undefined ? null : data?.theorems[theoremIndex];
	return <aside aria-label="Specifications for this file" className="flex min-h-0 w-[min(28rem,45%)] shrink-0 flex-col gap-1 overflow-auto border-l bg-muted/80 p-1 text-[12px]">
		<div className="flex h-8 shrink-0 items-center justify-between px-2"><h3 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lean mappings</h3><button className="rounded-md px-2 py-1 text-[11px] hover:bg-background" onClick={() => setRevision(r => r + 1)}>Refresh</button></div>
		{!data && !error && <section role="status" className="rounded-xl border bg-card p-3 shadow-card"><div className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /><span className="font-medium">Building Lean mappings</span></div><p className="mt-1 text-muted-foreground">Reading the Solidity AST, generated definitions, and theorem locations…</p></section>}
		{error && <section role="alert" className="rounded-xl border bg-card p-3"><p className="font-medium">Mapping build failed</p><pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-red-600">{error}</pre></section>}
		{data && <section className="rounded-xl border bg-card px-3 py-2"><span className="font-medium">{data.contract}</span><span className="text-muted-foreground"> · {functions.length} functions · {data.theorems.length} theorems</span></section>}
		{data && !fn && <section className="rounded-xl border bg-card p-3 text-muted-foreground">No function mappings for this source file.</section>}
		{fn && <>
			<section className="space-y-2 rounded-xl border bg-card p-3">
				<select aria-label="Solidity function" className="w-full rounded-md border bg-background px-2 py-1 font-mono text-[11px]" value={selected} onChange={e => { setSelected(Number(e.target.value)); setTheorem(null); setShowCode(false); }}>{functions.map((f, i) => <option key={i} value={i}>{f.name}</option>)}</select>
				<button className="font-mono text-[11px] underline" onClick={() => onOpenFile(path, fn.line)}>{path}:{fn.line}</button>
				<p className="break-words font-mono text-[11px]">{fn.lean || "No Lean definition"}</p>
				{fn.why && <p className="text-amber-700 dark:text-amber-400">Not modeled: {fn.why}</p>}
				{!fn.theorems.length && <p className="text-muted-foreground">No theorem references this definition in the current mapping.</p>}
				{fn.theorems.length > 0 && <select aria-label="Mapped theorem" className="w-full rounded-md border bg-background px-2 py-1 font-mono text-[11px]" value={theoremIndex} onChange={e => setTheorem(Number(e.target.value))}>{fn.theorems.map(i => data?.theorems[i] && <option key={i} value={i}>{data.theorems[i].name}</option>)}</select>}
			</section>
			{spec && <section className="space-y-2 rounded-xl border bg-card p-3">
				<div className="flex items-center justify-between gap-2"><span className="font-mono text-[11px]">{spec.name}</span>{spec.sorry && <span className="text-amber-700 dark:text-amber-400">Contains sorry</span>}</div>
				<button className="break-all font-mono text-[11px] underline" onClick={() => onOpenProof(spec.file, "", spec.line)}>{spec.file}:{spec.line}</button>
				<div className="max-h-48 overflow-auto"><FileView path={spec.file} text={spec.text} start={spec.line} /></div>
				<button className="rounded-md border px-2 py-1 hover:bg-muted" aria-expanded={showCode} onClick={() => setShowCode(v => !v)}>{showCode ? "Hide relevant code" : "Show code relevant to this specification"}</button>
				<p className="text-[11px] text-muted-foreground">Linked by the existing definition-reference mapping. Open the proof for live Lean feedback; this link does not certify Solidity correctness.</p>
			</section>}
			{showCode && data && theoremIndex !== undefined && <section className="space-y-2 rounded-xl border bg-card p-3"><h3 className="font-medium">Relevant code</h3><p className="text-[11px] text-muted-foreground">Functions referenced by this theorem in the generated JSON. This is not a complete dependency slice.</p>{mappedSources(data, theoremIndex).map((f, i) => <div key={i} className="space-y-1 border-t pt-2"><button className="break-all font-mono text-[11px] underline" onClick={() => f.file && onOpenFile(f.file, f.line)}>{f.file}:{f.line}–{f.endLine}</button><div className="overflow-auto"><FileView path={f.file ?? path} text={f.solidity} start={f.line} /></div></div>)}</section>}
		</>}
	</aside>;
}
