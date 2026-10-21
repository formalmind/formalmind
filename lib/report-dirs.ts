import { useState } from "react";

/** Where a project's audit reports are looked for when none are set, relative to the project. */
export const DEFAULT_REPORT_DIRS = ["audit", "audits", "reports"];

const keyOf = (folder: string) => `fm:report-dirs:${folder}`;

/** The folders a project's audit reports are read from (set in Settings → Audit folders). */
export function readReportDirs(folder: string): string[] {
	try {
		const saved = JSON.parse(localStorage.getItem(keyOf(folder)) ?? "null");
		return Array.isArray(saved) && saved.length ? saved : DEFAULT_REPORT_DIRS;
	} catch {
		return DEFAULT_REPORT_DIRS;
	}
}

/** "audit, reports/ , ./x" → ["audit", "reports", "x"]; nothing left means the defaults. */
export function saveReportDirs(folder: string, text: string): string[] {
	const next = text.split(",").map((d) => d.trim().replace(/^\.?\/+|\/+$/g, "")).filter(Boolean);
	try {
		localStorage.setItem(keyOf(folder), JSON.stringify(next.length ? next : DEFAULT_REPORT_DIRS));
	} catch {
		/* not kept */
	}
	return next.length ? next : DEFAULT_REPORT_DIRS;
}

export function useReportDirs(folder: string) {
	const [dirs] = useState(() => readReportDirs(folder));
	return dirs;
}
