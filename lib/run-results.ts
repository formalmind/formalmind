import { useEffect, useState } from "react";

/**
 * The last result of each script and test function debugged in a folder (`file::Contract::fn` → pass/fail), kept in
 * this browser, so the file tree can show what has run and passed.
 */
export type RunResult = "pass" | "fail";
const key = (folder: string) => `fm:runs:${folder}`;
const EVENT = "fm:runs";

function read(folder: string): Record<string, RunResult> {
	try {
		return JSON.parse(localStorage.getItem(key(folder)) ?? "{}") as Record<string, RunResult>;
	} catch {
		return {};
	}
}

export function recordRun(folder: string, file: string, contract: string, fn: string, pass: boolean) {
	const all = read(folder);
	all[`${file}::${contract}::${fn}`] = pass ? "pass" : "fail";
	try {
		localStorage.setItem(key(folder), JSON.stringify(all));
	} catch {
		/* not kept */
	}
	window.dispatchEvent(new Event(EVENT));
}

export function useRunResults(folder: string) {
	const [results, setResults] = useState(() => read(folder));
	useEffect(() => {
		const sync = () => setResults(read(folder));
		sync();
		window.addEventListener(EVENT, sync);
		return () => window.removeEventListener(EVENT, sync);
	}, [folder]);
	return results;
}

/** A file's state from its functions' results: fail if any failed, pass if any ran and none failed. */
export function fileResult(results: Record<string, RunResult>, file: string): RunResult | undefined {
	const mine = Object.entries(results).filter(([k]) => k.startsWith(`${file}::`));
	if (!mine.length) return undefined;
	return mine.some(([, v]) => v === "fail") ? "fail" : "pass";
}
