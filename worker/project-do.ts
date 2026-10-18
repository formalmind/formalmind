import { DurableObject } from "cloudflare:workers";
import { github, LEDGER_ISSUE, parseCost, type GitHubComment, type SwarmCost } from "@/lib/swarm";

/** How stale the ledger may get before a read catches up from GitHub (webhooks normally keep it current). */
const CATCH_UP_MS = 10 * 60_000;

type CostRow = { repo: string; role: string; ref: string; usd: number; run_id: number | null; created_at: string };

/**
 * One project's control-plane state on Cloudflare (protocol v1: "one Durable Object per project"). For now it
 * holds the spend: every cost line from the ledger issue, kept in this object's SQLite so the app can show usage
 * and today's budget without reading GitHub. GitHub stays the record: the ledger comments are the source, a
 * webhook pushes each new one here as it is written, and a catch-up read fills any gap (or rebuilds from scratch).
 */
export class ProjectDO extends DurableObject {
	constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: unknown) {
		super(ctx, env);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS costs (
			key TEXT PRIMARY KEY, repo TEXT NOT NULL, role TEXT NOT NULL, ref TEXT NOT NULL,
			usd REAL NOT NULL, run_id INTEGER, created_at TEXT NOT NULL)`);
		ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS costs_created ON costs (created_at)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	}

	private meta(key: string): string | null {
		return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: string, value: string) {
		this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
	}

	/** Records ledger comments; the comment URL keys each line, so the same comment twice is harmless. */
	addComments(comments: GitHubComment[]): number {
		let added = 0;
		for (const comment of comments) {
			for (const cost of parseCost(comment)) {
				const cursor = this.ctx.storage.sql.exec(
					"INSERT OR IGNORE INTO costs (key, repo, role, ref, usd, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					comment.html_url, cost.repo, cost.role, cost.ref, cost.usd, cost.runId, cost.createdAt,
				);
				added += (cursor as unknown as { rowsWritten: number }).rowsWritten ?? 0;
			}
		}
		return added;
	}

	/** Reads ledger comments newer than the last one seen (all of them the first time). */
	private async catchUp() {
		const since = this.meta("ledger_since");
		for (let page = 1; ; page++) {
			const comments = await github<GitHubComment[]>(
				`/issues/${LEDGER_ISSUE}/comments?per_page=100&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
			);
			this.addComments(comments);
			const last = comments.at(-1)?.updated_at;
			if (last && (!this.meta("ledger_since") || last > this.meta("ledger_since")!)) this.setMeta("ledger_since", last);
			if (comments.length < 100) break;
		}
		this.setMeta("synced_at", String(Date.now()));
	}

	/** Background catch-up from GitHub. A failure (rate limit, outage) is logged and retried later, never shown. */
	async alarm() {
		try {
			await this.catchUp();
		} catch (err) {
			console.error("[project] ledger catch-up failed", err);
			this.setMeta("synced_at", String(Date.now() - CATCH_UP_MS + 60_000)); // try again in a minute
		}
	}

	/**
	 * Every cost line, oldest first, always from this object's own storage. When the copy is older than
	 * CATCH_UP_MS an alarm catches up from GitHub in the background; only a never-filled store waits for GitHub.
	 */
	async costs(): Promise<{ costs: SwarmCost[]; syncedAt: number | null }> {
		const syncedAt = Number(this.meta("synced_at")) || null;
		if (!syncedAt) {
			await this.catchUp();
		} else if (Date.now() - syncedAt > CATCH_UP_MS && !(await this.ctx.storage.getAlarm())) {
			await this.ctx.storage.setAlarm(Date.now());
		}
		const rows = this.ctx.storage.sql.exec<CostRow>("SELECT repo, role, ref, usd, run_id, created_at FROM costs ORDER BY created_at").toArray();
		return {
			costs: rows.map((r) => ({ repo: r.repo, role: r.role, ref: r.ref, usd: r.usd, runId: r.run_id, createdAt: r.created_at })),
			syncedAt: Number(this.meta("synced_at")) || null,
		};
	}
}
