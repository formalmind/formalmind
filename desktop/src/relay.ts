import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MAC_OPS, type MacOp } from "@/lib/mac-ops";
import type { RelayCommandRow, RelayEvent, RelayFolder, RelayPublish } from "@/lib/relay";
import { apiBase } from "./api";

/**
 * This Mac's side of the swarm relay (lib/relay.ts): every swarm event goes to formal.team as it happens, with the
 * added folders and their sessions, and commands from the phone (a message, Start, Stop, a session's history) and
 * agents' calls through the MCP (lib/mac-ops.ts: everything the folder page does) come back and run here, as
 * if done in the app. Off when Settings → Phone is turned off (`fm:relay` = "0").
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

/** The model route, model and a folder's cap, as the folder page picks them. */
const route = (folder: string) => {
	const p = store.get("fm:provider");
	return {
		provider: p === "anthropic" || p === "openai" || p === "claude-code" ? p : "formal",
		model: store.get("fm:model") ?? undefined,
		budget: Number(store.get(`fm:budget:${folder}`)) || 5,
	};
};

const swarmStart = (folder: string, o: { goal?: string | null; budget?: number; session?: string; onlyQueued?: boolean; hunt?: string }) => {
	const r = route(folder);
	return invoke<string>("swarm_start", {
		request: { folder, goal: o.goal?.trim() || null, budget_usd: o.budget ?? r.budget, api_base: apiBase(), provider: r.provider, model: r.model, session: o.session ?? "swarm", only_queued: o.onlyQueued ?? false, ...(o.hunt !== undefined ? { hunt: o.hunt } : {}) },
	});
};

/** A statement or report queued: a stopped swarm starts just for that work and stops after, as the folder page does. */
const workQueued = async (folder: string) => {
	const running = await invoke<string[]>("swarm_running", { folder });
	return running.length ? running : [await swarmStart(folder, { onlyQueued: true })];
};

/** One of MAC_OPS (lib/mac-ops.ts), for an agent through the MCP; the result goes back as the call's reply. */
async function call(op: MacOp, folder: string, a: Record<string, unknown>): Promise<unknown> {
	const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
	const need = (k: string) => s(k) || Promise.reject(`${op} needs ${k}`);
	const run = () => need("run");
	const usd = (k: string) => (typeof a[k] === "number" && (a[k] as number) > 0 ? (a[k] as number) : undefined);
	if (op === "folders") return readState();
	if (op === "status") {
		const [claudeCode, anthropicKey, openaiKey] = await Promise.all([
			invoke<string>("claude_code_status").catch((e) => `unavailable: ${e}`),
			invoke<boolean>("anthropic_key_status").catch(() => false),
			invoke<boolean>("openai_key_status").catch(() => false),
		]);
		const r = route("");
		return { claudeCode, anthropicKey, openaiKey, provider: r.provider, model: r.model ?? null };
	}
	if (op === "add_folder") return invoke("folder_add", { path: await need("path") });
	const { folders } = await invoke<{ folders: string[] }>("config_get");
	if (op === "remove_folder") {
		const path = await need("path");
		if (!folders.includes(path)) throw `${path} isn't one of the added folders`;
		return invoke("folder_remove", { path });
	}
	if (!folders.includes(folder)) throw `${folder || "folder"} isn't one of the added folders: ${folders.join(", ") || "none"}`;
	switch (op) {
		case "files":
			return invoke("folder_tree", { path: folder });
		case "scan":
			return invoke("folder_scan", { path: folder });
		case "git":
			return invoke("folder_git_graph", { path: folder });
		case "read_file":
			return invoke("folder_read", { folder, path: await need("path") });
		case "plan":
			return invoke("swarm_plan", { folder });
		case "statements":
			return invoke("swarm_statements", { folder });
		case "bugs":
			return invoke("swarm_bugs", { folder });
		case "proofs":
			return invoke("swarm_proofs", { folder });
		case "queue":
			return invoke("swarm_queue", { folder });
		case "sessions":
			return invoke("swarm_sessions", { folder });
		case "running":
			return invoke("swarm_running", { folder });
		case "history":
			return (await invoke<unknown[]>("swarm_history", { folder, run: await run() })).slice(-300);
		case "scripts":
			return invoke("ast_scripts", { folder });
		case "units":
			return invoke("ast_units", { folder, entry: await need("entry") });
		case "coverage":
			return invoke("ast_formal", { folder, entry: await need("entry") });
		case "slice":
			return invoke("ast_slice", { folder, entry: await need("entry"), function: await need("function") });
		case "reach":
			return invoke("reach_map", { folder, entry: await need("entry") });
		case "report_quote":
			return invoke("report_quote", { folder, apiBase: apiBase() });
		case "start":
			return { run: await swarmStart(folder, { goal: s("goal"), budget: usd("budget"), session: s("run") || undefined }) };
		case "hunt":
			return { run: await swarmStart(folder, { budget: usd("budget"), session: s("run") || `hunt-${Date.now().toString(16)}`, onlyQueued: true, hunt: s("focus") }) };
		case "stop":
			return invoke("swarm_stop", { folder, run: await run() });
		case "say":
			return invoke("swarm_say", { folder, run: await run(), text: await need("text") });
		case "set_budget": {
			const amount = usd("usd");
			if (!amount) throw "set_budget needs usd";
			return invoke("swarm_set_budget", { folder, run: await run(), usd: amount });
		}
		case "add_statement": {
			const statement = await invoke("swarm_add_statement", { folder, text: await need("text") });
			return { statement, running: await workQueued(folder) };
		}
		case "confirm_statement":
			return { statements: await invoke("swarm_confirm_statement", { folder, id: await need("id") }), running: await workQueued(folder) };
		case "correct_statement":
			return { statements: await invoke("swarm_correct_statement", { folder, id: await need("id"), text: s("text") }), running: await workQueued(folder) };
		case "mark_statement":
			return { statements: await invoke("swarm_statement_mark", { folder, id: await need("id"), mark: await need("mark") }), running: await workQueued(folder) };
		case "remove_statement":
			return invoke("swarm_remove_statement", { folder, id: await need("id") });
		case "triage": {
			await invoke("swarm_triage", { folder, path: await need("path"), session: s("run") || "swarm" });
			return { running: await workQueued(folder) };
		}
		case "reach_run":
			return { started: await invoke<number>("reach_run", { folder, tool: await need("tool"), target: s("target") || null }) };
		case "report": {
			const dirs = Array.isArray(a.dirs) ? a.dirs.map(String) : ["audit", "audits", "reports"];
			return invoke("report_generate", { folder, dirs, apiBase: apiBase() });
		}
	}
	throw `unknown op ${op}`;
}

/** What the phone asked for, done the way the folder page does it (its settings: provider, model, the folder's cap). */
async function run(cmd: RelayCommandRow) {
	switch (cmd.type) {
		case "call": {
			const reply = await call(cmd.op, cmd.folder, cmd.args).then(
				(result) => ({ id: cmd.id, ok: true, result: result ?? null }),
				(e) => ({ id: cmd.id, ok: false, error: String(e) }),
			);
			await post({ replies: [reply] });
			return;
		}
		case "say":
			return invoke("swarm_say", { folder: cmd.folder, run: cmd.run, text: cmd.text });
		case "stop":
			return invoke("swarm_stop", { folder: cmd.folder, run: cmd.run });
		case "start":
			return swarmStart(cmd.folder, { goal: cmd.goal, budget: cmd.budget, session: cmd.run });
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
				if (cmd.type === "start" || cmd.type === "stop" || (cmd.type === "call" && MAC_OPS[cmd.op].write)) stateSoon();
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
