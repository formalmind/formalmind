/**
 * Prepaid credits. Users deposit with Stripe Checkout. Each paid session is stored under its
 * own key, credit:<user>:<session>, so crediting is idempotent even though KV is eventually
 * consistent: the webhook and the success redirect may both write it, and it still counts once.
 * The balance is the sum of those entries. Spending it (the metering proxy the swarm's model
 * calls go through) comes next.
 */
import { kv } from "@/lib/kv";

export { DEPOSITS_USD } from "@/lib/billing-plans";

const MIN_USD = 10;
const MAX_USD = 1_000;

export type CreditEntry = { at: string; cents: number; kind: "deposit" | "spend"; ref: string };
export type Credits = { cents: number; entries: CreditEntry[] };

const creditPrefix = (sub: string) => `credit:${sub}:`;

export function isBillingConfigured() {
	return Boolean(process.env.STRIPE_SECRET_KEY);
}

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

async function stripe<T>(path: string, init?: { method?: string; form?: Record<string, string> }): Promise<T> {
	const key = process.env.STRIPE_SECRET_KEY;
	if (!key) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY).");
	const res = await fetch(`https://api.stripe.com/v1${path}`, {
		method: init?.method ?? "GET",
		headers: {
			Authorization: `Bearer ${key}`,
			...(init?.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
		},
		body: init?.form ? new URLSearchParams(init.form) : undefined,
	});
	const body = await res.json() as T & { error?: { message: string } };
	if (!res.ok) throw new Error(`Stripe: ${body.error?.message ?? res.statusText}`);
	return body;
}

/** Checkout returns to the page that started it: onboarding or billing. */
export async function createCheckout({ sub, email, usd, origin, page = "/onboarding" }: { sub: string; email?: string; usd: number; origin: string; page?: "/onboarding" | "/billing" }) {
	if (!Number.isFinite(usd) || usd < MIN_USD || usd > MAX_USD) throw new Error(`Deposits are between $${MIN_USD} and $${MAX_USD}.`);
	const session = await stripe<{ id: string; url: string }>("/checkout/sessions", {
		method: "POST",
		form: {
			mode: "payment",
			"line_items[0][quantity]": "1",
			"line_items[0][price_data][currency]": "usd",
			"line_items[0][price_data][unit_amount]": String(Math.round(usd * 100)),
			"line_items[0][price_data][product_data][name]": "Formal Mind credits",
			"line_items[0][price_data][product_data][description]": "Prepaid model usage for your swarm",
			client_reference_id: sub,
			"metadata[sub]": sub,
			...(email ? { customer_email: email } : {}),
			success_url: `${origin}${page}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${origin}${page}?checkout=cancelled`,
		},
	});
	return session.url;
}

type CheckoutSession = { id: string; created?: number; payment_status: string; amount_total: number | null; client_reference_id: string | null; metadata?: Record<string, string> };

/** Records a paid Checkout session as a deposit. Writing the same session twice is harmless. */
export async function applyCheckout(session: CheckoutSession & { created?: number }) {
	const sub = session.client_reference_id ?? session.metadata?.sub;
	if (!sub || session.payment_status !== "paid" || !session.amount_total) return false;
	const entry: CreditEntry = {
		at: new Date((session.created ?? Date.now() / 1000) * 1000).toISOString(),
		cents: session.amount_total,
		kind: "deposit",
		ref: session.id,
	};
	await (await kv()).put(`${creditPrefix(sub)}${session.id}`, JSON.stringify(entry), { metadata: entry });
	return true;
}

/** The success redirect: look the session up and credit it if it is the caller's and paid. */
export async function confirmCheckout(sessionId: string, sub: string) {
	const session = await stripe<CheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
	if ((session.client_reference_id ?? session.metadata?.sub) !== sub) throw new Error("That payment belongs to another account.");
	await applyCheckout(session);
	// A KV listing can trail a fresh write by up to a minute; count this payment either way.
	const credits = await getCredits(sub);
	if (session.payment_status === "paid" && session.amount_total && !credits.entries.some((e) => e.ref === session.id)) {
		credits.entries.unshift({ at: new Date().toISOString(), cents: session.amount_total, kind: "deposit", ref: session.id });
		credits.cents += session.amount_total;
	}
	return credits;
}

/** Stripe-Signature check (v1 HMAC-SHA256 over "t.payload"), with a five-minute tolerance. */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string) {
	if (!header) return false;
	const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
	const signatures = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
	const t = Number(parts.t);
	if (!t || Math.abs(Date.now() / 1000 - t) > 300 || !signatures.length) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
	const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
	return signatures.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string) {
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Charges one swarm run to the account, as a negative entry keyed by the run and job, so a report sent twice counts
 * once. Fractions of a cent are kept: one model call often costs less than a cent.
 */
export async function recordSpend(sub: string, cents: number, ref: string) {
	if (!(cents > 0)) return;
	const entry: CreditEntry = { at: new Date().toISOString(), cents: -Math.round(cents * 1000) / 1000, kind: "spend", ref };
	await (await kv()).put(`${creditPrefix(sub)}spend:${ref}`, JSON.stringify(entry), { metadata: entry });
}
