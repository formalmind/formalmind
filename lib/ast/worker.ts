/// <reference lib="webworker" />
/**
 * The Web Worker the website's Proofs tab runs the AST in (lib/ast/run.ts): formal-ast's wasm and solc-js, off the
 * page's thread. Submodule listings and files, and every result, are kept in IndexedDB, per repository and commit.
 */

import init, * as wasm from "@/lib/formal-ast-wasm/formal_ast_wasm.js";
import wasmUrl from "@/lib/formal-ast-wasm/formal_ast_wasm_bg.wasm?url";
import { type Command, type Kv, makeRunner, type Snapshot } from "./run";

const ready = init({ module_or_path: wasmUrl });

let db: Promise<IDBDatabase | null> | null = null;
const open = () =>
	(db ??= new Promise((resolve) => {
		const req = indexedDB.open("fm-ast", 1);
		req.onupgradeneeded = () => req.result.createObjectStore("kv");
		req.onsuccess = () => resolve(req.result);
		// Without IndexedDB (a private window can refuse it) everything still runs, it just isn't kept.
		req.onerror = () => resolve(null);
	}));

const kv: Kv = {
	get: async <T,>(key: string) => {
		const d = await open();
		if (!d) return undefined;
		return new Promise<T | undefined>((resolve) => {
			const req = d.transaction("kv").objectStore("kv").get(key);
			req.onsuccess = () => resolve(req.result as T | undefined);
			req.onerror = () => resolve(undefined);
		});
	},
	set: async (key, value) => {
		const d = await open();
		if (!d) return;
		await new Promise<void>((resolve) => {
			const tx = d.transaction("kv", "readwrite");
			tx.objectStore("kv").put(value, key);
			tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
		});
	},
};

const run = makeRunner(wasm, kv);

self.onmessage = async (e: MessageEvent<{ id: number; snapshot: Snapshot; command: Command }>) => {
	const { id, snapshot, command } = e.data;
	try {
		await ready;
		self.postMessage({ id, result: await run(snapshot, command) });
	} catch (err) {
		self.postMessage({ id, error: String(err) });
	}
};
