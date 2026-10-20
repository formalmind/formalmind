import { getCredits } from "@/lib/billing";
import { getProofsOwner, mintGitHubToken, mintModelSession, TokenError, verifyActionsToken } from "@/lib/swarm-tokens";

/**
 * POST with `Authorization: Bearer <GitHub Actions OIDC token, audience https://formal.team>` from a proofs repository's
 * swarm workflow. Answers { github_token, model_key, model_base_url, credits_cents }: everything a run needs, no secrets.
 */
export async function POST(request: Request) {
	const oidc = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	try {
		const { repo, runId } = await verifyActionsToken(oidc);
		// The job's agent and item, as labels for its charges (?role=prove&ref=25); not trusted for anything else.
		const params = new URL(request.url).searchParams;
		const role = /^[a-z]{1,20}$/.test(params.get("role") ?? "") ? params.get("role")! : "";
		const ref = /^\d{1,9}$/.test(params.get("ref") ?? "") ? params.get("ref")! : "";
		const owner = await getProofsOwner(repo);
		if (!owner) throw new TokenError(404, `${repo} isn't a Formal Mind project. Set it up at https://formal.team/onboarding.`);
		const [github_token, model_key, credits] = await Promise.all([mintGitHubToken(repo, owner.protocol), mintModelSession(owner.sub, repo, runId, { role, ref }), getCredits(owner.sub)]);
		return Response.json({ github_token, model_key, model_base_url: `${new URL(request.url).origin}/api/model`, credits_cents: credits.cents });
	} catch (error) {
		if (error instanceof TokenError) return Response.json({ error: error.message }, { status: error.status });
		console.error("[swarm/token]", error);
		return Response.json({ error: "Minting the swarm's token failed." }, { status: 502 });
	}
}
