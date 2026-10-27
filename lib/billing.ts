/**
 * The credits ledger formal.team's metered model route reads and writes (lib/model-gateway.ts, the desktop's
 * "formal" provider): entries under credit:<user>:…, the balance their sum. Buying credits (Stripe Checkout and the
 * Billing page) is gone; this plumbing stays so that route and the Usage page keep working for accounts that have a
 * balance. The swarm runs on the user's own Claude plan or API key by default and never touches it.
 */
import { kv } from "@/lib/kv";

/** Tokens one model call used: input, output, cache reads and cache writes. */
export type TokenCounts = { in: number; out: number; read: number; write: number };
export type CreditEntry = { at: string; cents: number; kind: "deposit" | "spend"; ref: string; tokens?: TokenCounts };
export type Credits = { cents: number; entries: CreditEntry[] };

const creditPrefix = (sub: string) => `credit:${sub}:`;

export async function getCredits(sub: string): Promise<Credits> {
	const store = await kv();
	const entries: CreditEntry[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.list<CreditEntry>({ prefix: creditPrefix(sub), cursor });
		for (const key of page.keys) if (key.metadata) entries.push(key.metadata);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	entries.sort((a, b) => b.at.localeCompare(a.at));
	return { cents: entries.reduce((sum, e) => sum + e.cents, 0), entries };
}

/**
 * Charges one swarm run to the account, as a negative entry keyed by the run and job, so a report sent twice counts
 * once. Fractions of a cent are kept: one model call often costs less than a cent.
 */
export async function recordSpend(sub: string, cents: number, ref: string, tokens?: TokenCounts) {
	if (!(cents > 0)) return;
	const entry: CreditEntry = { at: new Date().toISOString(), cents: -Math.round(cents * 1000) / 1000, kind: "spend", ref, ...(tokens ? { tokens } : {}) };
	await (await kv()).put(`${creditPrefix(sub)}spend:${ref}`, JSON.stringify(entry), { metadata: entry });
}
