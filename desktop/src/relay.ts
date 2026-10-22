import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RelayCommandRow, RelayEvent, RelayFolder, RelayPublish } from "@/lib/relay";
import { apiBase } from "./api";

/**
 * This Mac's side of the swarm relay (lib/relay.ts): every swarm event goes to formal.team as it happens, with the
 * added folders and their sessions, and commands from the phone (a message, Start, Stop, a session's history) come
 * back and run here, as if typed in the app. Off when Settings → Phone is turned off (`fm:relay` = "0").
 */

export const relayOn = () => {
	try {
		return localStorage.getItem("fm:relay") !== "0";
	} catch {
		return true;
	}
};

const post = (body: RelayPublish) =>
	fetch("/api/relay/mac", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.ok);

type Session = { run: string; title: string; outcome: string; spent: number };

/** The added folders and their sessions, newest first, with the ones running now marked. */
async function readState(): Promise<RelayFolder[]> {
	const { folders } = await invoke<{ folders: string[] }>("config_get");
	return Promise.all(
		folders.map(async (path) => {
			const [sessions, running, repo] = await Promise.all([
				invoke<Session[]>("swarm_sessions", { folder: path }).catch((): Session[] => []),
				invoke<string[]>("swarm_running", { folder: path }).catch((): string[] => []),
				invoke<string | null>("folder_repo", { path }).catch(() => null),
			]);
			const listed = sessions.slice(0, 12).map((s) => ({ ...s, running: running.includes(s.run) }));
			// A session that just started may have no log yet.
			for (const run of running) if (!listed.some((s) => s.run === run)) listed.unshift({ run, title: "", outcome: "", spent: 0, running: true });
			return { path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, repo, sessions: listed };
		}),
	);
}

const store = {
	get: (k: string) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	},
};

/** What the phone asked for, done the way the folder page does it (its settings: provider, model, the folder's cap). */
async function run(cmd: RelayCommandRow) {
	switch (cmd.type) {
		case "say":
			return invoke("swarm_say", { folder: cmd.folder, run: cmd.run, text: cmd.text });
		case "stop":
			return invoke("swarm_stop", { folder: cmd.folder, run: cmd.run });
		case "start": {
			const p = store.get("fm:provider");
			const provider = p === "anthropic" || p === "openai" ? p : "formal";
			const budget = cmd.budget ?? (Number(store.get(`fm:budget:${cmd.folder}`)) || 5);
			const model = store.get("fm:model") ?? undefined;
			return invoke("swarm_start", { request: { folder: cmd.folder, goal: cmd.goal?.trim() || null, budget_usd: budget, api_base: apiBase(), provider, model, session: cmd.run ?? "swarm", only_queued: false } });
		}
		case "history": {
			const events = await invoke<RelayEvent[]>("swarm_history", { folder: cmd.folder, run: cmd.run });
			return post({ history: { folder: cmd.folder, run: cmd.run, events: events.slice(-600).map((e) => ({ ...e, folder: cmd.folder, run: cmd.run })) } });
		}
	}
}

/** Starts the relay; the returned function stops it. */
export function startRelay(): () => void {
	let stopped = false;
	let queue: RelayEvent[] = [];
	let flushing: ReturnType<typeof setTimeout> | null = null;
	let stateDue: ReturnType<typeof setTimeout> | null = null;

	const flush = () => {
		flushing = null;
		const events = queue;
		queue = [];
		if (events.length) void post({ events }).catch(() => {});
	};
	const publishState = () => {
		stateDue = null;
		void readState()
			.then(async (folders) => post({ state: { folders, at: Date.now(), name: (await invoke<string | null>("machine_name").catch(() => null)) ?? undefined } }))
			.catch(() => {});
	};
	const stateSoon = () => (stateDue ??= setTimeout(publishState, 300));

	const off = listen<RelayEvent>("swarm", ({ payload }) => {
		queue.push(payload);
		flushing ??= setTimeout(flush, 400);
		if (payload.kind === "start" || payload.kind === "done") stateSoon();
	});
	publishState();
	const every = setInterval(publishState, 60_000);

	// Commands: one waiting request at a time; asking with `after` acknowledges what was done.
	void (async () => {
		let after = 0;
		let failures = 0;
		while (!stopped) {
			const res = await fetch(`/api/relay/mac?after=${after}&wait=1`).catch(() => null);
			if (!res?.ok) {
				failures++;
				await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * failures)));
				continue;
			}
			failures = 0;
			const body = (await res.json()) as { commands: RelayCommandRow[]; last: number };
			for (const cmd of body.commands) {
				if (stopped) return;
				try {
					await run(cmd);
				} catch (e) {
					// Said in the session, so the phone sees why nothing happened.
					queue.push({ folder: cmd.folder, run: "run" in cmd && cmd.run ? cmd.run : "swarm", kind: "error", role: "swarm", item: "", text: String(e), spent: 0 });
					flush();
				}
				if (cmd.type === "start" || cmd.type === "stop") stateSoon();
			}
			after = body.last;
		}
	})();

	return () => {
		stopped = true;
		clearInterval(every);
		if (flushing) clearTimeout(flushing);
		if (stateDue) clearTimeout(stateDue);
		flush();
		void off.then((f) => f());
	};
}
