import { auth } from "@/lib/auth";
import { createCheckout, isBillingConfigured } from "@/lib/billing";

export async function POST(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	if (!isBillingConfigured()) return Response.json({ error: "Payments aren't connected yet." }, { status: 503 });
	const { usd } = (await request.json()) as { usd: number };
	try {
		const url = await createCheckout({ sub: session.user.sub, email: session.user.email, usd: Number(usd), origin: new URL(request.url).origin });
		return Response.json({ url });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Checkout failed." }, { status: 400 });
	}
}
