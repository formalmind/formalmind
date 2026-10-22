import { useEffect, useState } from "react";
import type { Bridge } from "./swarm-panel";

type Check = { code: number; seconds: number; output: string };
type Variant = {
	name: string; source: string; sourceSha256: string;
	import: Check; execution?: Check; evm?: Check; proof?: Check;
	parity?: boolean; permissionMatches?: boolean; proofPassed?: boolean;
};
type Report = { scope: string; proofScope: string; proofSource: string; proofSha256: string; revision: string; toolchain: string; variants: Variant[] };
type Status = { running: boolean; directory: string | null; error: string | null; report: Report | null };
const names: Record<string, string> = { baseline: "Original", reordered: "Move the event", guarded: "Reject zero address", broken: "Invert permission" };

export function SemanticsPanel({ invoke }: { invoke: Bridge["invoke"] }) {
	const [expanded, setExpanded] = useState(false);
	const [solidcore, setSolidcore] = useState(() => localStorage.getItem("fm:solidcore") ?? "");
	const [solc, setSolc] = useState(() => localStorage.getItem("fm:semantics-solc") ?? "");
	const [status, setStatus] = useState<Status | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!expanded) return;
		let active = true;
		const refresh = () => void invoke<Status>("semantics_status").then(s => { if (active) setStatus(s); }, e => { if (active) setError(String(e)); });
		refresh();
		const timer = setInterval(refresh, 2000);
		return () => { active = false; clearInterval(timer); };
	}, [expanded, invoke]);
	const busy = pending || status?.running;
	async function run() {
		setPending(true); setError(null); setStatus(null);
		localStorage.setItem("fm:solidcore", solidcore);
		localStorage.setItem("fm:semantics-solc", solc);
		try { setStatus(await invoke<Status>("semantics_run", { solidcore, solc })); }
		catch (e) { setError(String(e)); }
		finally { setPending(false); }
	}
	return <section className="mx-1.5 mb-2 shrink-0 rounded-lg border bg-background text-xs">
		<button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
			<span>Proofs across Solidity edits <span className="ml-2 text-muted-foreground">Experiment</span></span><span>{expanded ? "−" : "+"}</span>
		</button>
		{expanded && <div className="max-h-[60vh] space-y-3 overflow-auto border-t p-3">
			<p>Run a reduced Async Swap <code>setExecutor</code> fixture through SolidCore and the EVM, then recheck the same Lean assertion after each edit.</p>
			<p className="text-muted-foreground">This experiment is separate from this folder’s coverage. Execution matches are test evidence. Proof preservation requires a successful Lean check.</p>
			<div className="flex flex-wrap items-end gap-2">
				<label className="min-w-64 flex-1">Built SolidCore checkout<input className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={solidcore} onChange={e => setSolidcore(e.target.value)} placeholder="/path/to/solidity-lean" disabled={busy} /></label>
				<label className="min-w-64 flex-1">solc 0.8.35 executable<input className="mt-1 w-full rounded border bg-background px-2 py-1.5" value={solc} onChange={e => setSolc(e.target.value)} placeholder="/path/to/solc-0.8.35" disabled={busy} /></label>
				<button className="rounded border px-3 py-1.5 hover:bg-muted disabled:opacity-50" disabled={busy || !solidcore.trim() || !solc.trim()} onClick={() => void run()}>{busy ? "Running checks…" : "Run experiment"}</button>
			</div>
			<p className="text-muted-foreground">Requires Python 3, Lake and Foundry. Each check has a timeout; results appear as each variant finishes.</p>
			{(error || status?.error) && <p role="alert" className="whitespace-pre-wrap text-red-600">{error || status?.error}</p>}
			{status?.report && <>
				<p>{status.report.scope}. {status.report.proofScope}.</p>
				<table className="w-full text-left"><thead><tr className="border-b"><th className="py-2">Solidity edit</th><th>Import</th><th>EVM comparison</th><th>Permission examples</th><th>Lean proof</th></tr></thead>
					<tbody>{status.report.variants.map(v => <tr key={v.name} className="border-b"><td className="py-2">{names[v.name]}</td><td>{v.import.code === 0 ? "Passed" : "Failed"}</td><td>{v.parity ? "3 calls match" : v.evm ? "Failed" : "Not run"}</td><td>{v.permissionMatches ? "Match" : v.parity ? v.name === "broken" ? "Change detected" : "Mismatch" : "Not established"}</td><td>{v.proofPassed ? "Passed" : v.proof ? "Not proved" : "Not run"}</td></tr>)}</tbody>
				</table>
				{status.report.variants.some(v => v.name !== "broken" && !v.proofPassed) && <p className="text-amber-700 dark:text-amber-400">Proof preservation has not been established. Inspect the Lean diagnostics below.</p>}
				<details><summary className="cursor-pointer">Unchanged Lean assertion</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{status.report.proofSource}</pre></details>
				{status.report.variants.map(v => <details key={v.name}><summary className="cursor-pointer">{names[v.name]} — source and diagnostics</summary><pre className="my-2 overflow-auto rounded bg-muted p-2">{v.source}</pre>{(["import", "execution", "evm", "proof"] as const).map(key => v[key] && <details key={key}><summary className="cursor-pointer py-1">{key} · {v[key]!.seconds}s · exit {v[key]!.code}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-muted p-2">{v[key]!.output}</pre></details>)}</details>)}
				<p className="break-all text-muted-foreground">SolidCore {status.report.revision} · {status.report.toolchain}<br />Saved evidence: {status.directory}</p>
			</>}
		</div>}
	</section>;
}
