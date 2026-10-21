/**
 * The Proofs tab's AST commands (ast_units, ast_slice, ast_formal, ast_scripts) for an imported repository, run in
 * the browser instead of the Mac app: lib/ast/worker.ts runs formal-ast (wasm) and solc-js on the browser's git copy.
 * Loaded only when the Proofs tab asks, so the rest of the site never ships it.
 */

import { cachedCommit, cachedSnapshot, type RepoSnapshot } from "@/lib/browser-git";
import type { Command } from "@/lib/ast/run";

/** What formal-ast and solc read: Solidity, Lean (theorems), and how the project compiles. */
const want = (path: string) => /\.(sol|lean)$/.test(path) || /(^|\/)(foundry\.toml|remappings\.txt|\.gitmodules)$/.test(path);

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL("./ast/worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
			const w = waiting.get(e.data.id);
			waiting.delete(e.data.id);
			if (e.data.error !== undefined) w?.reject(e.data.error);
			else w?.resolve(e.data.result);
		};
		worker.onerror = (e) => {
			// The worker itself failed (it didn't load): everything waiting fails, and the next request starts a new one.
			for (const w of waiting.values()) w.reject(e.message || "The Proofs worker stopped.");
			waiting.clear();
			worker?.terminate();
			worker = null;
		};
	}
	return worker;
}

/** One snapshot per repository and commit: the files are read from IndexedDB once, not for every command. */
const snapshots = new Map<string, Promise<RepoSnapshot | null>>();
/** The same command for the same commit runs once while it's in progress. */
const inflight = new Map<string, Promise<unknown>>();

export async function runAst(repo: string, command: Command): Promise<unknown> {
	const commit = await cachedCommit(repo);
	if (!commit) throw `${repo} isn't in the browser yet.`;
	const key = `${repo}@${commit}`;
	if (!snapshots.has(key)) {
		snapshots.set(key, cachedSnapshot(repo, want));
		for (const k of snapshots.keys()) if (k.startsWith(`${repo}@`) && k !== key) snapshots.delete(k);
	}
	const job = `${key}:${JSON.stringify(command)}`;
	let p = inflight.get(job);
	if (!p) {
		p = (async () => {
			const snap = await snapshots.get(key)!;
			if (!snap) throw `${repo} isn't in the browser yet.`;
			const id = next++;
			return new Promise((resolve, reject) => {
				waiting.set(id, { resolve, reject });
				getWorker().postMessage({ id, snapshot: { repo, ...snap }, command });
			});
		})().finally(() => inflight.delete(job));
		inflight.set(job, p);
	}
	return p;
}
