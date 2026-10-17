import { applyCheckout, verifyStripeSignature } from "@/lib/billing";

/** Stripe calls this on checkout.session.completed; it credits the payment (idempotently). */
export async function POST(request: Request) {
	const secret = process.env.STRIPE_WEBHOOK_SECRET;
	if (!secret) return new Response("Webhook not configured", { status: 503 });
	const payload = await request.text();
	if (!(await verifyStripeSignature(payload, request.headers.get("stripe-signature"), secret))) {
		return new Response("Bad signature", { status: 400 });
	}
	const event = JSON.parse(payload) as { type: string; data: { object: Parameters<typeof applyCheckout>[0] } };
	if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
		await applyCheckout(event.data.object);
	}
	return Response.json({ received: true });
}
