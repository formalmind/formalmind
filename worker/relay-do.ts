import { DurableObject } from "cloudflare:workers";
import type { RelayCommand, RelayCommandRow, RelayEvent, RelayPublish, RelayRead, RelayReply, RelayRow, RelayState } from "@/lib/relay";

/** How long a read or the Mac's command poll waits for something new before answering empty. */
const WAIT_MS = 25_000;
/** Events kept; older ones fall off (the Mac's .formal/runs logs stay the record). */
const KEEP_EVENTS = 4000;
/** A first read gets this many of the newest events. */
const FIRST_READ = 1500;
/** A command the Mac hasn't picked up in this long is dropped: a Start shouldn't fire hours later. */
const COMMAND_TTL_MS = 10 * 60_000;
/** Replies to calls are kept this long, for a caller that comes back for one. */
const REPLY_TTL_MS = 30 * 60_000;
/** A reply's result is cut to this many characters of JSON. */
const REPLY_MAX = 200_000;

type Row = { seq: number; folder: string; run: string; kind: string; role: string; item: string; text: string; spent: number; at: number };

/**
 * One person's swarm relay (lib/relay.ts): the Mac app publishes its sessions' events and state here and long-polls
 * for commands; clients (the phone) long-poll the events and send commands. Waiting reads are held in memory and
 * answered as soon as something arrives.
 */
export class RelayDO extends DurableObject {
	private waiting = { client: new Set<() => void>(), mac: new Set<() => void>(), reply: new Set<() => void>() };

	constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: unknown) {
		super(ctx, env);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
			seq INTEGER PRIMARY KEY AUTOINCREMENT, folder TEXT NOT NULL, run TEXT NOT NULL, kind TEXT NOT NULL,
			role TEXT NOT NULL, item TEXT NOT NULL, text TEXT NOT NULL, spent REAL NOT NULL, at INTEGER NOT NULL)`);
		ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_session ON events (folder, run)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS commands (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, at INTEGER NOT NULL)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)");
	}

	private meta(key: string): string | null {
		return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: string, value: string) {
		this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
	}

	private wait(who: "client" | "mac" | "reply") {
		return new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.waiting[who].delete(done);
				resolve();
			};
			const timer = setTimeout(done, WAIT_MS);
			this.waiting[who].add(done);
		});
	}

	private wake(who: "client" | "mac" | "reply") {
		for (const done of [...this.waiting[who]]) done();
	}

	private insert(e: RelayEvent, at: number) {
		this.ctx.storage.sql.exec(
			"INSERT INTO events (folder, run, kind, role, item, text, spent, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			String(e.folder ?? ""), String(e.run ?? ""), String(e.kind ?? ""), String(e.role ?? ""), String(e.item ?? ""),
			String(e.text ?? "").slice(0, 20_000), Number(e.spent) || 0, at,
		);
	}

	/** From the Mac: its folders and sessions, new events, or a session's history in place of what was held for it. */
	async publish(body: RelayPublish) {
		const now = Date.now();
		this.setMeta("mac_seen_at", String(now));
		if (body.state) this.setMeta("state", JSON.stringify({ ...body.state, at: now }));
		if (body.history) {
			const { folder, run, events } = body.history;
			this.ctx.storage.sql.exec("DELETE FROM events WHERE folder = ? AND run = ?", folder, run);
			this.insert({ folder, run, kind: "history", role: "swarm", item: "", text: JSON.stringify(events.slice(-600)), spent: events.at(-1)?.spent ?? 0 }, now);
		}
		for (const e of body.events ?? []) this.insert(e, now);
		for (const r of body.replies ?? []) {
			let json = JSON.stringify({ id: String(r.id), ok: Boolean(r.ok), ...(r.ok ? { result: r.result } : { error: String(r.error ?? "") }) });
			if (json.length > REPLY_MAX) json = JSON.stringify({ id: String(r.id), ok: r.ok, result: json.slice(0, REPLY_MAX), truncated: true });
			this.ctx.storage.sql.exec("INSERT OR REPLACE INTO replies (id, body, at) VALUES (?, ?, ?)", String(r.id), json, now);
		}
		if (body.replies?.length) {
			this.ctx.storage.sql.exec("DELETE FROM replies WHERE at < ?", now - REPLY_TTL_MS);
			this.wake("reply");
		}
		this.ctx.storage.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?", KEEP_EVENTS);
		this.wake("client");
	}

	private rows(after: number): RelayRow[] {
		const rows = after > 0
			? this.ctx.storage.sql.exec<Row>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, FIRST_READ).toArray()
			: this.ctx.storage.sql.exec<Row>("SELECT * FROM events ORDER BY seq DESC LIMIT ?", FIRST_READ).toArray().reverse();
		return rows.map((r) => ({ ...r }));
	}

	private lastSeq(): number {
		return this.ctx.storage.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM events").toArray()[0]?.m ?? 0;
	}

	/** For a client: events after `after` (the newest ones when 0), waiting for some when there are none yet. */
	async read(after: number, wait: boolean): Promise<RelayRead> {
		let events = this.rows(after);
		const stateBefore = this.meta("state");
		if (!events.length && wait && after > 0) {
			await this.wait("client");
			events = this.rows(after);
		}
		const state = this.meta("state") ?? stateBefore;
		return {
			events,
			last: events.at(-1)?.seq ?? Math.max(after, this.lastSeq()),
			state: state ? (JSON.parse(state) as RelayState) : null,
			macSeenAt: Number(this.meta("mac_seen_at")) || null,
		};
	}

	private findReply(id: string): RelayReply | null {
		const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM replies WHERE id = ?", id).toArray()[0];
		return row ? (JSON.parse(row.body) as RelayReply) : null;
	}

	/** For a client: the Mac's reply to the call with this id, waiting for it when it hasn't come yet. */
	async reply(id: string, wait: boolean): Promise<RelayReply | null> {
		const found = this.findReply(id);
		if (found || !wait) return found;
		const until = Date.now() + WAIT_MS;
		while (Date.now() < until) {
			await this.wait("reply");
			const r = this.findReply(id);
			if (r) return r;
		}
		return null;
	}

	/** From a client: a command for the Mac. */
	async send(command: RelayCommand): Promise<number> {
		this.ctx.storage.sql.exec("INSERT INTO commands (body, at) VALUES (?, ?)", JSON.stringify(command), Date.now());
		const seq = this.ctx.storage.sql.exec<{ seq: number }>("SELECT last_insert_rowid() AS seq").toArray()[0]?.seq ?? 0;
		this.wake("mac");
		return seq;
	}

	private pending(after: number): RelayCommandRow[] {
		return this.ctx.storage.sql
			.exec<{ seq: number; body: string; at: number }>("SELECT seq, body, at FROM commands WHERE seq > ? ORDER BY seq", after)
			.toArray()
			.map((r) => ({ ...(JSON.parse(r.body) as RelayCommand), seq: r.seq, at: r.at }));
	}

	/**
	 * For the Mac: commands after `after`, waiting for some when there are none. Asking with `after` acknowledges
	 * everything up to it; each poll also marks the Mac as online.
	 */
	async commands(after: number, wait: boolean): Promise<{ commands: RelayCommandRow[]; last: number }> {
		const seen = () => this.setMeta("mac_seen_at", String(Date.now()));
		seen();
		this.ctx.storage.sql.exec("DELETE FROM commands WHERE seq <= ? OR at < ?", after, Date.now() - COMMAND_TTL_MS);
		let commands = this.pending(after);
		if (!commands.length && wait) {
			await this.wait("mac");
			seen();
			commands = this.pending(after);
		}
		const last = this.ctx.storage.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM commands").toArray()[0]?.m ?? after;
		return { commands, last: Math.max(after, last) };
	}
}
