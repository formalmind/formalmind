import { useEffect, useState } from "react";
import type { Bridge } from "./swarm-panel";

type SourceRange = { path: string; startLine: number; endLine: number; reason: string; text: string; stale: boolean; available: boolean };

/** Explicit source evidence; does not infer or certify dependency completeness. */
export function SpecificationCode({ folder, specId, invoke, onOpenFile }: { folder: string; specId: string; invoke: Bridge["invoke"]; onOpenFile: (path: string, line?: number) => void }) {
	const [ranges, setRanges] = useState<SourceRange[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		let active = true;
		setRanges(null); setError(null);
		void invoke<SourceRange[]>("proof_relevant_code", { folder, specId }).then(value => { if (active) setRanges(value); }, e => { if (active) setError(String(e)); });
		return () => { active = false; };
	}, [folder, specId, invoke, revision]);
	return <section aria-label="Code relevant to specification" className="max-h-72 shrink-0 space-y-2 overflow-auto rounded-lg border bg-background p-3 text-xs">
		<div className="flex items-center justify-between gap-2"><h3 className="font-medium">Code relevant to this specification</h3><button className="rounded border px-2 py-1" onClick={() => setRevision(r => r + 1)}>Refresh source</button></div>
		<p className="text-muted-foreground">Recorded source links · completeness not checked. Calls, storage aliases, and other dependencies may be missing. Source is read from saved files.</p>
		{error && <p role="alert" className="text-red-600">{error}</p>}
		{!error && ranges === null && <p role="status">Loading source…</p>}
		{ranges?.length === 0 && <p>No source ranges recorded for this specification.</p>}
		{ranges?.map((range, i) => <article key={i} className="space-y-1 rounded border p-2">
			<div className="flex flex-wrap justify-between gap-2"><button className="font-mono underline" onClick={() => onOpenFile(range.path, range.startLine)}>{range.path}:{range.startLine}–{range.endLine}</button><span className={range.stale ? "text-amber-600" : "text-muted-foreground"}>{range.stale ? "Source link needs review" : "Matches recorded text"}</span></div>
			<p>{range.reason}</p>
			{range.stale && <p role="status" className="text-amber-600">{range.available ? "The source at this location has changed. Review the range and its relevance before updating the manifest." : "This range no longer exists. Update its location in the manifest."}</p>}
			{range.available && <pre className="overflow-x-auto font-mono text-xs leading-5" aria-label={`Source from ${range.path}`}>{range.text.split("\n").map((line, n) => <div key={n}><span aria-hidden="true" className="mr-3 inline-block w-8 select-none text-right text-muted-foreground">{range.startLine + n}</span>{line || " "}</div>)}</pre>}
		</article>)}
	</section>;
}
