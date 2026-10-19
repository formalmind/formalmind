import { auth } from "@/lib/auth";
import { parseRepo } from "@/lib/plan";
import { getJSON } from "@/lib/kv";
import { listProjects, setProofsRepo } from "@/lib/projects";
import { TEAM_PRESETS } from "@/lib/teams";
import type { OnboardingState } from "@/server/routes/onboarding/state/route";
import { InitError, initProofsRepo } from "@/lib/proofs-repo";

/** Creates a project's proofs repository (`<repo>-proofs`, from the Lean template) and hands it to the swarm. */
export async function POST(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const body = (await request.json().catch(() => ({}))) as { repo?: string; mode?: string };
	const repo = parseRepo(body.repo ?? "");
	if (!repo) return Response.json({ error: "Which repository?" }, { status: 400 });
	const projects = await listProjects(session.user.sub);
	const project = projects.find((p) => p.repo === repo);
	if (!project) return Response.json({ error: `${repo} isn't one of your projects yet; plan it first.` }, { status: 404 });
	try {
		// Team and budget come from the account's onboarding; the agents in a team are its parallel slots in an audit.
		const saved = await getJSON<OnboardingState>(`onboarding:${session.user.sub}`);
		const team = saved?.team === "squad" ? saved.squadSize : Number.parseInt(TEAM_PRESETS.find((t) => t.key === (saved?.team ?? "pair"))?.agents ?? "2", 10) || 2;
		const result = await initProofsRepo(repo, {
			sub: session.user.sub,
			mode: body.mode === "audit" ? "audit" : "specs",
			maintainer: session.user.nickname ?? repo.split("/")[0],
			team,
			dailyUsd: saved?.dailyUsd ?? 5,
		});
		await setProofsRepo(session.user.sub, repo, result.proofsRepo);
		return Response.json(result);
	} catch (error) {
		if (error instanceof InitError) return Response.json({ error: error.message, step: error.step }, { status: 409 });
		console.error("[projects] init failed:", error);
		return Response.json({ error: "Setting up the proofs repository failed on GitHub's side; try again in a minute." }, { status: 502 });
	}
}
