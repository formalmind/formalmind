import { auth } from "@/lib/auth";
import { getCredits, hasSpend, recordSpend, REPORT_USD } from "@/lib/billing";

/**
 * POST { repo, commit, charge } from the signed-in desktop app: Formal Mind's audit report costs $REPORT_USD from
 * credits, once per repository and commit. Without `charge` it only quotes (the price, whether this commit is already
 * paid for, and the balance), for the app's confirm step; with it, it takes the charge, and a commit paid for before
 * is free. The report itself is built on the Mac; nothing of the code comes here.
 */
export async function POST(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const body = (await request.json().catch(() => ({}))) as { repo?: string; commit?: string; charge?: boolean };
	const repo = (body.repo ?? "").replace(/[^\w./-]/g, "").slice(0, 100);
	const commit = /^[0-9a-f]{7,40}$/.test(body.commit ?? "") ? body.commit! : "";
	if (!repo || !commit) return Response.json({ error: "The report needs the repository and its commit." }, { status: 400 });
	const sub = session.user.sub;
	const ref = `report:${repo}@${commit}`;
	const cents = REPORT_USD * 100;
	const [paid, credits] = await Promise.all([hasSpend(sub, ref), getCredits(sub)]);
	const quote = { price_cents: cents, paid, balance_cents: credits.cents };
	if (!body.charge || paid) return Response.json(quote);
	if (credits.cents < cents) return Response.json({ ...quote, error: `The report costs $${REPORT_USD} and your balance is $${(credits.cents / 100).toFixed(2)}. Add credits at https://formal.team/billing.` }, { status: 402 });
	await recordSpend(sub, cents, ref);
	return Response.json({ ...quote, paid: true, balance_cents: credits.cents - cents });
}
