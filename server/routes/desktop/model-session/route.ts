import { auth } from "@/lib/auth";
import { getCredits } from "@/lib/billing";
import { mintModelSession } from "@/lib/swarm-tokens";

/**
 * POST { folder, run, role, ref } from the signed-in desktop app: a model session for one agent turn of a local swarm.
 * Calls go through the same metered proxy as hosted runs and are charged as `local/<folder>:<run>:<role>:<ref>`, so
 * Billing shows which local agent spent what. The folder's code never comes here; only the model calls do.
 */
export async function POST(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const body = (await request.json().catch(() => ({}))) as { folder?: string; run?: string; role?: string; ref?: string };
	const folder = (body.folder ?? "").replace(/[^\w.-]/g, "").slice(0, 60) || "folder";
	const run = /^[\w-]{1,40}$/.test(body.run ?? "") ? body.run! : `local-${Date.now()}`;
	const role = /^[a-z]{1,20}$/.test(body.role ?? "") ? body.role! : "";
	const ref = /^[\w-]{1,20}$/.test(body.ref ?? "") ? body.ref! : "";
	const credits = await getCredits(session.user.sub);
	if (credits.cents <= 0) return Response.json({ error: "Out of Formal Mind credits. Add credits at https://formal.team/billing." }, { status: 402 });
	const key = await mintModelSession(session.user.sub, `local/${folder}`, run, { role, ref });
	return Response.json({ key, base_url: `${new URL(request.url).origin}/api/model`, credits_cents: credits.cents });
}
