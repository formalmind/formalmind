import { Fragment, useEffect, useState } from "react";
import { ChevronRight, FlaskConical, Loader2, Play } from "lucide-react";
import type { Bridge } from "./swarm-panel";
import { FileView } from "./swarm-panel";

type Check = { code: number; seconds: number; output: string };
type Variant = {
	name: string;
	source: string;
	sourceSha256: string;
	import: Check;
	execution?: Check;
	evm?: Check;
	proof?: Check;
	parity?: boolean;
	permissionMatches?: boolean;
	proofPassed?: boolean;
};
type Report = { scope: string; proofScope: string; proofSource: string; proofSha256: string; revision: string; toolchain: string; variants: Variant[] };
type Status = { running: boolean; directory: string | null; error: string | null; report: Report | null };

/** The four edits the experiment makes to setExecutor, and what each is for. */
const EDITS: Record<string, { label: string; what: string }> = {
	baseline: { label: "Original", what: "setExecutor as AsyncSwap has it" },
	reordered: { label: "Move the event", what: "emit before the write: same behaviour" },
	guarded: { label: "Reject zero address", what: "a new require: one more revert" },
	broken: { label: "Invert permission", what: "a bug on purpose: the spec must catch it" },
};

type Tone = "ok" | "bad" | "warn" | "none";
const TONE: Record<Tone, string> = {
	ok: "text-emerald-700 dark:text-emerald-400 [&>i]:bg-emerald-500",
	bad: "text-red-700 dark:text-red-400 [&>i]:bg-red-500",
	warn: "text-amber-700 dark:text-amber-400 [&>i]:bg-amber-500",
	none: "text-muted-foreground [&>i]:bg-muted-foreground/40",
};
function Cell({ tone, children }: { tone: Tone; children: React.ReactNode }) {
	return (
		<span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] ${TONE[tone]}`}>
			<i className="size-1.5 rounded-full" />
			{children}
		</span>
	);
}

const input = "h-7 w-full rounded-md border bg-background px-2 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const store = { get: (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not kept */ } } };

/**
 * Proofs across Solidity edits (Mac app, experimental): a reduced `setExecutor` run through Paradigm's SolidCore and
 * through the EVM, edited four ways, with one Lean assertion rechecked after each edit. It answers whether a proof can
 * survive a code change; it never counts toward the folder's coverage.
 */
export function SemanticsPanel({ invoke }: { invoke: Bridge["invoke"] }) {
	const [solidcore, setSolidcore] = useState(() => store.get("fm:solidcore"));
	const [solc, setSolc] = useState(() => store.get("fm:semantics-solc"));
	const [status, setStatus] = useState<Status | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		const refresh = () => void invoke<Status>("semantics_status").then((s) => active && setStatus(s), () => {});
		refresh();
		const timer = setInterval(refresh, 2000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [invoke]);
	const busy = pending || status?.running;
	const report = status?.report ?? null;
	async function run() {
		setPending(true);
		setError(null);
		store.set("fm:solidcore", solidcore);
		store.set("fm:semantics-solc", solc);
		try {
			setStatus(await invoke<Status>("semantics_run", { solidcore, solc }));
		} catch (e) {
			setError(String(e));
		} finally {
			setPending(false);
		}
	}
	const unproved = report?.variants.filter((v) => v.name !== "broken" && !v.proofPassed).length ?? 0;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
			<section className="shrink-0 rounded-xl border bg-card p-4 text-[12px]">
				<div className="flex items-center gap-2">
					<FlaskConical className="size-3.5 text-muted-foreground" />
					<h2 className="text-[13px] font-medium">Proofs across Solidity edits</h2>
					<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Experimental</span>
				</div>
				<p className="mt-1.5 max-w-2xl leading-5 text-muted-foreground">
					A reduced <code className="font-mono text-[11px]">AsyncSwap.setExecutor</code> is edited four ways. Each version runs through Paradigm's SolidCore (a Lean semantics of Solidity) and through the EVM, and the same Lean assertion is checked again. A proof that survives the harmless edits and fails the broken one is a proof tied to behaviour, not to the code's text.
				</p>
				<div className="mt-3 grid max-w-3xl grid-cols-[1fr_1fr_auto] items-end gap-2 max-sm:grid-cols-1">
					<label className="text-[11px] text-muted-foreground">
						SolidCore checkout (built)
						<input className={`${input} mt-1`} value={solidcore} onChange={(e) => setSolidcore(e.target.value)} placeholder="~/developer/asyncswap/references/solidity-lean" disabled={!!busy} />
					</label>
					<label className="text-[11px] text-muted-foreground">
						solc 0.8.35
						<input className={`${input} mt-1`} value={solc} onChange={(e) => setSolc(e.target.value)} placeholder="~/.solc-bin/solc-0.8.35" disabled={!!busy} />
					</label>
					<button type="button" onClick={() => void run()} disabled={!!busy || !solidcore.trim() || !solc.trim()} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground px-3 text-[12px] font-medium text-background hover:bg-foreground/90 disabled:opacity-40">
						{busy ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> : <Play className="size-3" />}
						{busy ? "Running" : "Run"}
					</button>
				</div>
				<p className="mt-2 text-[11px] text-muted-foreground">Needs Python 3, Lake and Foundry. About 20 seconds a version; results fill in as each finishes.</p>
				{error || status?.error ? <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 font-mono text-[11px] leading-4 text-red-700 dark:text-red-400">{error || status?.error}</pre> : null}
			</section>
			{report ? (
				<section className="shrink-0 overflow-hidden rounded-xl border bg-card text-[12px]">
					<header className="flex h-8 items-center gap-2 border-b px-3">
						<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Results</span>
						<span className="truncate text-[11px] text-muted-foreground">{report.scope}</span>
					</header>
					{unproved ? (
						<p className="border-b bg-amber-500/5 px-3 py-2 leading-5 text-amber-800 dark:text-amber-300">
							The Lean assertion doesn't check yet on {unproved} of {report.variants.filter((v) => v.name !== "broken").length} versions, so proof survival isn't shown. Execution is still evidence: compare SolidCore with the EVM below.
						</p>
					) : null}
					<table className="w-full text-left">
						<thead>
							<tr className="border-b font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
								<th className="py-1.5 pl-3 font-normal">Edit</th>
								<th className="font-normal">Imported</th>
								<th className="font-normal">SolidCore = EVM</th>
								<th className="font-normal">Matches the spec</th>
								<th className="pr-3 font-normal">Lean proof</th>
							</tr>
						</thead>
						<tbody>
							{report.variants.map((v) => {
								const edit = EDITS[v.name] ?? { label: v.name, what: "" };
								const negative = v.name === "broken";
								const expanded = open === v.name;
								return (
									<Fragment key={v.name}>
										<tr onClick={() => setOpen(expanded ? null : v.name)} className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40">
											<td className="py-2 pl-3">
												<span className="flex items-center gap-1.5">
													<ChevronRight className={`size-3 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
													<span className="font-medium">{edit.label}</span>
												</span>
												<span className="block pl-[18px] text-[11px] text-muted-foreground">{edit.what}</span>
											</td>
											<td>{v.import.code === 0 ? <Cell tone="ok">Yes</Cell> : <Cell tone="bad">Failed</Cell>}</td>
											<td>{v.parity ? <Cell tone="ok">3 of 3 calls</Cell> : v.evm ? <Cell tone="bad">Differs</Cell> : <Cell tone="none">Not run</Cell>}</td>
											<td>{!v.parity ? <Cell tone="none">—</Cell> : v.permissionMatches ? <Cell tone="ok">Yes</Cell> : negative ? <Cell tone="ok">No, as it should</Cell> : <Cell tone="bad">No</Cell>}</td>
											<td className="pr-3">{v.proofPassed ? <Cell tone={negative ? "bad" : "ok"}>{negative ? "Checks (wrong)" : "Checks"}</Cell> : v.proof ? <Cell tone={negative ? "ok" : "warn"}>{negative ? "Fails, as it should" : "Doesn't check"}</Cell> : <Cell tone="none">Not run</Cell>}</td>
										</tr>
										{expanded ? (
											<tr className="border-b bg-muted/20">
												<td colSpan={5} className="p-2">
													<div className="grid gap-2 xl:grid-cols-2">
														<div className="overflow-hidden rounded-lg border bg-card">
															<p className="border-b px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Solidity · {v.sourceSha256.slice(0, 8)}</p>
															<div className="max-h-72 overflow-auto">
																<FileView path="v.sol" text={v.source.trimEnd()} />
															</div>
														</div>
														<div className="space-y-1">
															{(["import", "execution", "evm", "proof"] as const).map((k) => {
																const c = v[k];
																if (!c) return null;
																return (
																	<details key={k} className="overflow-hidden rounded-lg border bg-card">
																		<summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[11px]">
																			<Cell tone={c.code === 0 ? "ok" : "bad"}>{{ import: "Import from solc's AST", execution: "Run in SolidCore", evm: "Run on the EVM (Foundry)", proof: "Check the Lean assertion" }[k]}</Cell>
																			<span className="ml-auto font-mono text-muted-foreground">{c.seconds}s · exit {c.code}</span>
																		</summary>
																		<pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t bg-muted/30 p-2.5 font-mono text-[11px] leading-4">{c.output || "No output."}</pre>
																	</details>
																);
															})}
														</div>
													</div>
												</td>
											</tr>
										) : null}
									</Fragment>
								);
							})}
						</tbody>
					</table>
					<details className="border-t">
						<summary className="cursor-pointer px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground">The Lean assertion (the same for every edit) · {report.proofScope}</summary>
						<div className="max-h-72 overflow-auto border-t">
							<FileView path="p.lean" text={report.proofSource.trimEnd()} />
						</div>
					</details>
					<p className="break-all border-t px-3 py-2 font-mono text-[10px] text-muted-foreground">
						SolidCore {report.revision.slice(0, 7)} · {report.toolchain.replace("leanprover/lean4:", "Lean ")} · {status?.directory}
					</p>
				</section>
			) : null}
		</div>
	);
}
