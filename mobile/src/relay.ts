import { useSyncExternalStore } from "react";
import type { RelayCommand, RelayEvent, RelayRead, RelayRow, RelayState } from "@/lib/relay";
import { notify } from "@/lib/notifications";

/**
 * The phone's side of the swarm relay (lib/relay.ts): one waiting read at a time for the events your Mac publishes,
 * kept per session, with the Mac's folders and sessions; and the commands that go back to it. The swarm events that
 * matter (a proof done, a bug filed, the budget reached) become notifications.
 */

export type MacState = { state: RelayState | null; macSeenAt: number | null; connected: boolean; loaded: boolean };

const sessionKey = (folder: string, run: string) => `${folder}\n${run}`;
const KEEP = 1000;

let mac: MacState = { state: null, macSeenAt: null, connected: false, loaded: false };
const sessions = new Map<string, RelayEvent[]>();
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
	version++;
	listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

/** The Mac is online when it asked for commands lately (it asks at least every 25 s while the app runs). */
/** The Mac's own name (its Computer Name), or "Your Mac" until it sends one. */
export const macName = (m: MacState) => m.state?.name?.trim() || "Your Mac";

export const macOnline = (m: MacState) => !!m.macSeenAt && Date.now() - m.macSeenAt < 60_000;

export function useMac(): MacState {
	return useSyncExternalStore(subscribe, () => mac);
}

/** One session's events, oldest first; `[]` until some arrive. */
export function useSession(folder: string, run: string): RelayEvent[] {
	useSyncExternalStore(subscribe, () => version);
	return sessions.get(sessionKey(folder, run)) ?? [];
}

export const hasHistory = (folder: string, run: string) => sessions.get(sessionKey(folder, run))?.some((e) => (e as { history?: boolean }).history) ?? false;

const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/** The notifications you can turn off in Settings. */
export const NOTICES = [
	{ id: "proof", label: "Proof done", sub: "An item is proven and reviewed" },
	{ id: "bug", label: "Bug filed", sub: "A finding with its proof of concept" },
	{ id: "budget", label: "Budget reached", sub: "A session spent its cap and stopped" },
] as const;
export type NoticeId = (typeof NOTICES)[number]["id"];

export const noticeOn = (id: NoticeId) => {
	try {
		return localStorage.getItem(`fm:notify:${id}`) !== "0";
	} catch {
		return true;
	}
};

export const setNotice = (id: NoticeId, on: boolean) => {
	try {
		localStorage.setItem(`fm:notify:${id}`, on ? "1" : "0");
	} catch {
		/* this visit only */
	}
};

/** What a new event tells you, if it is one of the ones worth a notification. */
function notice(e: RelayEvent) {
	const where = folderName(e.folder);
	const id = `${e.folder}:${e.run}:${e.kind}:${e.item}:${e.text.slice(0, 40)}`;
	// Opens the session it came from (./notifications.tsx); 0 keeps it out of the toasts, the bell counts it.
	const opts = { id, duration: 0, copy: `${e.text}\n\n${where} · ${e.role}${e.item ? ` · item ${e.item}` : ""} · ${e.run}`, action: { label: "Open", event: `fm:go:/mac/session?${new URLSearchParams({ folder: e.folder, run: e.run })}` } };
	if (e.kind === "bug" && noticeOn("bug")) notify.error(`Bug filed in ${where}`, { ...opts, description: e.text.split(" — ")[0] });
	else if (e.kind === "plan" && / proven$/.test(e.text) && noticeOn("proof")) notify.success(`Proof done in ${where}`, { ...opts, description: e.text });
	else if (e.kind === "done" && /budget reached/.test(e.text) && noticeOn("budget")) notify.warning(`Budget reached in ${where}`, { ...opts, description: e.text });
	else if (e.kind === "error") notify.error(`Your Mac couldn't do that`, { ...opts, description: e.text });
}

function take(rows: RelayRow[], live: boolean) {
	for (const row of rows) {
		const key = sessionKey(row.folder, row.run);
		if (row.kind === "history") {
			let past: RelayEvent[] = [];
			try {
				past = (JSON.parse(row.text) as RelayEvent[]).map((e) => ({ ...e, folder: row.folder, run: row.run }));
			} catch {
				/* a history that didn't parse leaves the session as it was */
			}
			// What came in live after the history was read stays after it.
			const later = (sessions.get(key) ?? []).filter((e) => !(e as { history?: boolean }).history && !past.some((p) => p.kind === e.kind && p.text === e.text && p.item === e.item));
			sessions.set(key, [...past.map((e) => ({ ...e, history: true })), ...later].slice(-KEEP));
			continue;
		}
		const list = sessions.get(key) ?? [];
		list.push(row);
		sessions.set(key, list.slice(-KEEP));
		if (live) notice(row);
	}
}

let running: Promise<void> | null = null;
let stopped = false;

/** Starts following the relay (once); the returned function stops it. */
export function followRelay(): () => void {
	stopped = false;
	running ??= (async () => {
		let after = 0;
		let failures = 0;
		while (!stopped) {
			const res = await fetch(`/api/relay/client?after=${after}&wait=${after ? 1 : 0}`).catch(() => null);
			if (!res?.ok) {
				failures++;
				mac = { ...mac, connected: false, loaded: true };
				changed();
				await new Promise((r) => setTimeout(r, Math.min(30_000, 1500 * failures)));
				continue;
			}
			failures = 0;
			const body = (await res.json()) as RelayRead;
			take(body.events, after > 0);
			after = body.last;
			mac = { state: body.state, macSeenAt: body.macSeenAt, connected: true, loaded: true };
			changed();
		}
	})().finally(() => (running = null));
	return () => {
		stopped = true;
	};
}

/** Sends your Mac a command; it runs there as if done in the app. */
export async function send(command: RelayCommand) {
	const res = await fetch("/api/relay/client", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
	if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Couldn't reach your Mac (${res.status}).`);
}

/** The spending cap a Start from the phone asks for (picked during setup); the Mac's own cap when unset. */
export const startBudget = (): number | undefined => {
	try {
		return Number(localStorage.getItem("fm:start-budget")) || undefined;
	} catch {
		return undefined;
	}
};

export const setStartBudget = (usd: number) => {
	try {
		localStorage.setItem("fm:start-budget", String(usd));
	} catch {
		/* the Mac's own cap applies */
	}
};

// Dev: the follow loop holds this module's store, so a hot update of it reloads the page instead of swapping it.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
