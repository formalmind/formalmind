import { auth0 } from "@/lib/auth0";
import { confirmCheckout, getCredits, isBillingConfigured } from "@/lib/billing";

/** The signed-in user's credits; with ?session_id= (the Checkout redirect) it confirms that payment first. */
export async function GET(request: Request) {
	const session = await auth0.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const configured = isBillingConfigured();
	const sessionId = new URL(request.url).searchParams.get("session_id");
	try {
		const credits = configured && sessionId ? await confirmCheckout(sessionId, session.user.sub) : await getCredits(session.user.sub);
		return Response.json({ configured, ...credits });
	} catch (error) {
		return Response.json({ configured, error: error instanceof Error ? error.message : "Couldn't load credits." }, { status: 400 });
	}
}
