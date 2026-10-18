import { auth0 } from "@/lib/auth0";
import { parseRepo } from "@/lib/plan";
import { listProjects, setProofsRepo } from "@/lib/projects";
import { InitError, initProofsRepo } from "@/lib/proofs-repo";

/** Creates a project's proofs repository (`<repo>-proofs`, from the Lean template) and hands it to the swarm. */
export async function POST(request: Request) {
	const session = await auth0.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const body = (await request.json().catch(() => ({}))) as { repo?: string };
	const repo = parseRepo(body.repo ?? "");
	if (!repo) return Response.json({ error: "Which repository?" }, { status: 400 });
	const projects = await listProjects(session.user.sub);
	const project = projects.find((p) => p.repo === repo);
	if (!project) return Response.json({ error: `${repo} isn't one of your projects yet; plan it first.` }, { status: 404 });
	try {
		const result = await initProofsRepo(repo);
		await setProofsRepo(session.user.sub, repo, result.proofsRepo);
		return Response.json(result);
	} catch (error) {
		if (error instanceof InitError) return Response.json({ error: error.message, step: error.step }, { status: 409 });
		console.error("[projects] init failed:", error);
		return Response.json({ error: "Setting up the proofs repository failed on GitHub's side; try again in a minute." }, { status: 502 });
	}
}
