import { getJSON, putJSON } from "@/lib/kv";

/** A GitHub Marketplace purchase, as the marketplace_purchase webhook sends it. */
type Purchase = {
	account: { id: number; login: string; type: string };
	billing_cycle: string | null;
	unit_count: number;
	on_free_trial: boolean;
	next_billing_date: string | null;
	plan: { id: number; name: string; monthly_price_in_cents: number; yearly_price_in_cents: number };
};
type MarketplaceEvent = { action: string; effective_date: string; marketplace_purchase: Purchase; previous_marketplace_purchase?: Purchase };

/** What an account bought on GitHub Marketplace; `plan` is null once it is cancelled. */
export type MarketplacePlan = { plan: string | null; planId: number | null; units: number; billingCycle: string | null; onFreeTrial: boolean; updatedAt: string; history: { at: string; action: string; plan: string }[] };

const key = (accountId: number) => `marketplace:${accountId}`;

async function verify(payload: string, signature: string | null, secret: string): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;
	const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(payload)));
	const expected = `sha256=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0;
}

/** GitHub Marketplace events (purchased, changed, cancelled, pending_change…): records each account's plan. */
export async function POST(request: Request) {
	const secret = process.env.GITHUB_MARKETPLACE_WEBHOOK_SECRET;
	if (!secret) return new Response("Webhook not configured", { status: 503 });
	const payload = await request.text();
	if (!(await verify(payload, request.headers.get("x-hub-signature-256"), secret))) return new Response("Bad signature", { status: 400 });
	if (request.headers.get("x-github-event") === "ping") return Response.json({ pong: true });
	// GitHub sends JSON or form-encoded (payload=<json>), depending on the webhook's content type.
	const json = payload.startsWith("payload=") ? new URLSearchParams(payload).get("payload") ?? "{}" : payload;
	const event = JSON.parse(json) as MarketplaceEvent;
	const purchase = event.marketplace_purchase;
	if (!purchase?.account) return Response.json({ ignored: true });
	const previous = await getJSON<MarketplacePlan>(key(purchase.account.id));
	// A pending change only takes effect at the next billing date; until then the current plan stands.
	if (event.action === "pending_change" || event.action === "pending_change_cancelled") {
		await putJSON(key(purchase.account.id), { ...(previous ?? {}), history: [{ at: event.effective_date, action: event.action, plan: purchase.plan.name }, ...(previous?.history ?? [])].slice(0, 50) });
		return Response.json({ received: true });
	}
	const cancelled = event.action === "cancelled";
	const next: MarketplacePlan = {
		plan: cancelled ? null : purchase.plan.name,
		planId: cancelled ? null : purchase.plan.id,
		units: purchase.unit_count,
		billingCycle: purchase.billing_cycle,
		onFreeTrial: purchase.on_free_trial,
		updatedAt: new Date().toISOString(),
		history: [{ at: event.effective_date, action: event.action, plan: purchase.plan.name }, ...(previous?.history ?? [])].slice(0, 50),
	};
	await putJSON(key(purchase.account.id), next);
	console.log(`[marketplace] ${purchase.account.login}: ${event.action} ${purchase.plan.name}`);
	return Response.json({ received: true });
}
