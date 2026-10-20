import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play, Trash2, X } from "lucide-react";
import { reportError } from "@/lib/report-error";

/** A chain the scripts know (script/config/chains.json), or forge's local chain. */
type Chain = { key: string; name: string; chainId: number; rpcUrlEnv: string | null };
type Fork = { name: string; folder: string; chain_id: number; port: number; rpc_env: string; alive: boolean };
export type ScriptTarget = { chainId: number; fork: string | null };

const LOCAL: Chain = { key: "local", name: "Local", chainId: 31337, rpcUrlEnv: null };

function readChains(text: string): Chain[] {
	try {
		const cfg = JSON.parse(text) as { chains?: Record<string, { name?: string; chainId?: number; rpcUrlEnv?: string }> };
		return Object.entries(cfg.chains ?? {})
			.filter(([, c]) => typeof c.chainId === "number")
			.map(([key, c]) => ({ key, name: c.name ?? key, chainId: c.chainId!, rpcUrlEnv: c.rpcUrlEnv ?? "RPC_URL" }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/**
 * Before a script runs in Debug: which chain, and whether on an Anvil fork of it (scripts read that chain's
 * deployments and call what's deployed there). Forks are reused while they run and keep their state between
 * starts; Clean stops one and deletes its state. The choice is remembered per folder.
 */
export function ScriptRunDialog({ folder, file, fn, onRun, onClose }: { folder: string; file: string; fn: string; onRun: (t: ScriptTarget) => void; onClose: () => void }) {
	const remembered = `fm:script-run:${folder}`;
	const [chains, setChains] = useState<Chain[]>([LOCAL]);
	const [key, setKey] = useState<string>(() => {
		try {
			return JSON.parse(localStorage.getItem(remembered) ?? "{}").key ?? "local";
		} catch {
			return "local";
		}
	});
	const [forks, setForks] = useState<Fork[]>([]);
	const [rpcKnown, setRpcKnown] = useState<boolean | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const chain = chains.find((c) => c.key === key) ?? LOCAL;
	const fork = forks.find((f) => f.folder === folder && f.chain_id === chain.chainId);

	const refresh = () => void invoke<Fork[]>("anvil_list").then(setForks, () => setForks([]));
	useEffect(() => {
		void invoke<string>("folder_read", { folder, path: "script/config/chains.json" }).then(
			(t) => setChains([LOCAL, ...readChains(t)]),
			() => setChains([LOCAL]),
		);
		refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [folder]);
	useEffect(() => {
		setRpcKnown(null);
		if (!chain.rpcUrlEnv) return;
		void invoke<boolean>("anvil_rpc_known", { folder, rpcEnv: chain.rpcUrlEnv }).then(setRpcKnown, () => setRpcKnown(false));
	}, [folder, chain.rpcUrlEnv]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const remember = () => {
		try {
			localStorage.setItem(remembered, JSON.stringify({ key }));
		} catch {
			/* not kept */
		}
	};
	const fail = (e: unknown) => {
		setError(String(e));
		reportError("Anvil", e);
	};
	const run = (target: ScriptTarget) => {
		remember();
		onRun(target);
	};
	const startAndRun = async () => {
		if (!chain.rpcUrlEnv) return;
		setBusy("start");
		setError(null);
		try {
			const f = await invoke<Fork>("anvil_start", { folder, chainId: chain.chainId, rpcEnv: chain.rpcUrlEnv });
			run({ chainId: f.chain_id, fork: `http://127.0.0.1:${f.port}` });
		} catch (e) {
			fail(e);
		} finally {
			setBusy(null);
		}
	};
	const clean = async () => {
		if (!fork) return;
		setBusy("clean");
		try {
			await invoke("anvil_stop", { name: fork.name, clean: true });
			refresh();
		} catch (e) {
			fail(e);
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="fixed inset-0 z-[100] grid place-items-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div role="dialog" aria-label={`Run ${file}`} className="w-[min(28rem,100%)] rounded-2xl border bg-muted p-1.5 shadow-pop">
				<div className="flex h-8 items-center gap-2 px-2.5">
					<Play className="size-3.5 fill-current text-emerald-600" />
					<span className="min-w-0 truncate font-mono text-[12px]">
						{file.split("/").pop()} · {fn}()
					</span>
					<button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
						<X className="size-3.5" />
					</button>
				</div>
				<div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
					<label className="flex items-center justify-between gap-3">
						<span className="font-medium">Chain</span>
						<select value={key} onChange={(e) => setKey(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm">
							{chains.map((c) => (
								<option key={c.key} value={c.key}>
									{c.name} ({c.chainId})
								</option>
							))}
						</select>
					</label>

					{chain.key === "local" ? (
						<p className="text-xs text-muted-foreground">An empty local chain, as `forge script` without an RPC: anything the script reads from deployments must be deployed first in the same run.</p>
					) : (
						<div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs">
							<p className="font-medium text-foreground">Anvil fork of {chain.name}</p>
							{fork ? (
								<div className="flex items-center gap-2">
									<span className={`size-2 rounded-full ${fork.alive ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
									<span className="text-muted-foreground">
										{fork.alive ? `Running on :${fork.port}` : "Stopped · its state is saved"}
									</span>
									<button type="button" onClick={() => void clean()} disabled={Boolean(busy)} title="Stop it and delete its saved state" className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-background hover:text-red-600 disabled:opacity-50">
										{busy === "clean" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
										Clean
									</button>
								</div>
							) : (
								<p className="text-muted-foreground">No fork yet.</p>
							)}
							<p className="text-muted-foreground">
								RPC from <code className="rounded bg-muted px-1 font-mono">{chain.rpcUrlEnv}</code>{" "}
								{rpcKnown === null ? "…" : rpcKnown ? <span className="text-emerald-700 dark:text-emerald-400">found</span> : <span className="text-amber-700 dark:text-amber-400">not set: add it to .env.deploy or .env</span>}
							</p>
						</div>
					)}

					{error ? <p className="whitespace-pre-wrap rounded-lg bg-red-500/10 p-2 font-mono text-[11px] text-red-700 dark:text-red-400">{error}</p> : null}

					<div className="flex flex-wrap justify-end gap-2 pt-1">
						{chain.key !== "local" ? (
							<button type="button" onClick={() => run({ chainId: chain.chainId, fork: null })} disabled={Boolean(busy)} title="Only block.chainid changes; nothing is forked" className="btn-soft h-8 px-3 text-sm disabled:opacity-50">
								Without a fork
							</button>
						) : null}
						{chain.key === "local" ? (
							<button type="button" onClick={() => run({ chainId: 31337, fork: null })} className="btn-dark h-8 px-3 text-sm">
								Run
							</button>
						) : fork?.alive ? (
							<button type="button" onClick={() => run({ chainId: fork.chain_id, fork: `http://127.0.0.1:${fork.port}` })} className="btn-dark h-8 px-3 text-sm">
								Run on the fork
							</button>
						) : (
							<button type="button" onClick={() => void startAndRun()} disabled={Boolean(busy) || rpcKnown === false} className="btn-dark inline-flex h-8 items-center gap-1.5 px-3 text-sm disabled:opacity-50">
								{busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : null}
								{fork ? "Start the fork and run" : "Start an Anvil fork and run"}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
