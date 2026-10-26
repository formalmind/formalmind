import { useState } from "react";

/** Where a project's audit reports are always looked for, relative to the project. */
export const DEFAULT_REPORT_DIRS = ["audit", "audits", "reports"];

const keyOf = (folder: string) => `fm:report-dirs:${folder}`;

/** The folders a project adds to the defaults (set in Settings → Audit reports). */
export function readExtraReportDirs(folder: string): string[] {
	try {
		const saved = JSON.parse(localStorage.getItem(keyOf(folder)) ?? "null");
		return Array.isArray(saved) ? saved.filter((d) => typeof d === "string" && !DEFAULT_REPORT_DIRS.includes(d)) : [];
	} catch {
		return [];
	}
}

/** The folders a project's audit reports are read from: the defaults, then the ones it adds. */
export function readReportDirs(folder: string): string[] {
	return [...DEFAULT_REPORT_DIRS, ...readExtraReportDirs(folder)];
}

/** "docs/audits, ./x/" → ["docs/audits", "x"], kept as the project's added folders (the defaults are always read). */
export function saveReportDirs(folder: string, text: string): string[] {
	const next = [...new Set(text.split(",").map((d) => d.trim().replace(/^\.?\/+|\/+$/g, "")).filter((d) => d && !DEFAULT_REPORT_DIRS.includes(d)))];
	try {
		localStorage.setItem(keyOf(folder), JSON.stringify(next));
	} catch {
		/* not kept */
	}
	return next;
}

export function useReportDirs(folder: string) {
	const [dirs] = useState(() => readReportDirs(folder));
	return dirs;
}
