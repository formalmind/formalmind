import { currentRequest } from "@/worker/context";

/**
 * The swarm relay: the Mac app publishes its swarm sessions' events through formal.team and takes messages back, so
 * the phone (or any signed-in client) can follow and steer a swarm that runs on the Mac. One Durable Object per
 * person (worker/relay-do.ts) holds the recent events, the Mac's folders and sessions, and the commands waiting for
 * the Mac. The work itself stays on the Mac: nothing here runs an agent or reads a file.
 */

/** One swarm event, as the Mac app emits it (desktop/src-tauri/src/swarm.rs `SwarmEvent`, .formal/runs/<run>.jsonl). */
export type RelayEvent = { folder: string; run: string; kind: string; role: string; item: string; text: string; spent: number };

/** An event as stored: `seq` orders them; a `history` row's text is the session's events so far, as JSON. */
export type RelayRow = RelayEvent & { seq: number; at: number };

export type RelaySession = { run: string; title: string; outcome: string; spent: number; running: boolean };
/** `repo`: the GitHub repository the folder's origin is ("owner/name"), so a project can find its folder. */
export type RelayFolder = { path: string; name: string; repo: string | null; sessions: RelaySession[] };
/** The Mac's folders and their sessions, published whenever they change. */
/** The Mac's folders and their sessions; `name` is the computer's own (older Macs don't send it). */
export type RelayState = { folders: RelayFolder[]; at: number; name?: string };

/** What a client asks the Mac to do. `history` asks it to publish a session's events from its log. */
export type RelayCommand =
	| { type: "say"; folder: string; run: string; text: string }
	| { type: "start"; folder: string; run?: string; goal?: string; budget?: number }
	| { type: "stop"; folder: string; run: string }
	| { type: "history"; folder: string; run: string };

export type RelayCommandRow = RelayCommand & { seq: number; at: number };

/** What the Mac sends: its state, new events, or one session's history (in place of what the relay held for it). */
export type RelayPublish = { state?: RelayState; events?: RelayEvent[]; history?: { folder: string; run: string; events: RelayEvent[] } };

/** A client's read: events after its cursor, the Mac's state, and when the Mac last checked in. */
export type RelayRead = { events: RelayRow[]; last: number; state: RelayState | null; macSeenAt: number | null };

type RelayStub = {
	publish(body: RelayPublish): Promise<void>;
	commands(after: number, wait: boolean): Promise<{ commands: RelayCommandRow[]; last: number }>;
	send(command: RelayCommand): Promise<number>;
	read(after: number, wait: boolean): Promise<RelayRead>;
};

/** The person's relay object, or null where the binding is missing (a build without it). */
export function relayObject(sub: string): RelayStub | null {
	const ns = currentRequest().env.RELAY;
	return ns ? (ns.get(ns.idFromName(`relay:${sub}`)) as unknown as RelayStub) : null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** A command from a client, checked and trimmed; null when it isn't one. */
export function parseCommand(body: unknown): RelayCommand | null {
	const b = (body ?? {}) as Record<string, unknown>;
	const folder = str(b.folder, 1000);
	const run = str(b.run, 100);
	if (!folder) return null;
	if (run && !/^[\w-]+$/.test(run)) return null;
	switch (b.type) {
		case "say": {
			const text = str(b.text, 8000).trim();
			return text && run ? { type: "say", folder, run, text } : null;
		}
		case "start": {
			const budget = typeof b.budget === "number" && b.budget > 0 && b.budget <= 1000 ? b.budget : undefined;
			return { type: "start", folder, ...(run ? { run } : {}), ...(b.goal ? { goal: str(b.goal, 2000) } : {}), ...(budget ? { budget } : {}) };
		}
		case "stop":
		case "history":
			return run ? { type: b.type, folder, run } : null;
		default:
			return null;
	}
}
