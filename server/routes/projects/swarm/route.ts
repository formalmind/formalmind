import { auth } from "@/lib/auth";
import { parseRepo } from "@/lib/plan";
import { listProjects } from "@/lib/projects";
import { installationFor } from "@/lib/proofs-repo";

const WORKFLOW = "formalmind-swarm.yml";

/** The project's proofs repository, an App client on it, and whether you may run its swarm (write access or more). */
async function target(repoParam: string | null) {
	const session = await auth.getSession();
	if (!session?.user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
	const repo = parseRepo(repoParam ?? "");
	const project = (await listProjects(session.user.sub)).find((p) => p.repo === repo);
	if (!project?.proofsRepo) return { error: Response.json({ error: "That project has no swarm yet." }, { status: 404 }) };
	const [owner, name] = project.proofsRepo.split("/");
	const octokit = await installationFor(owner, name).catch(() => null);
	if (!octokit) return { error: Response.json({ error: `The formalmind GitHub App can't reach ${project.proofsRepo}.` }, { status: 409 }) };
	return { owner, name, octokit, login: session.user.nickname ?? "" };
}

const stateOf = async (t: { owner: string; name: string; octokit: Awaited<ReturnType<typeof installationFor>> }) => {
	const { data } = await t.octokit.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", { owner: t.owner, repo: t.name, workflow_id: WORKFLOW });
	return { paused: data.state !== "active" };
};

/** Whether a project's swarm is stopped: its workflow in the proofs repository is turned off. */
export async function GET(request: Request) {
	const t = await target(new URL(request.url).searchParams.get("repo"));
	if ("error" in t) return t.error as Response;
	return Response.json(await stateOf(t).catch(() => ({ paused: false })));
}

/** Stops (turns the workflow off and cancels runs in flight) or resumes a project's swarm. */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { repo?: string; paused?: boolean };
	const t = await target(body.repo ?? null);
	if ("error" in t) return t.error as Response;
	const { owner, name, octokit, login } = t;
	const permission = await octokit
		.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", { owner, repo: name, username: login })
		.then((r) => r.data.permission)
		.catch(() => "none");
	if (!["admin", "maintain", "write"].includes(permission)) return Response.json({ error: `You need write access to ${owner}/${name} to stop or resume its swarm.` }, { status: 403 });
	const workflow = { owner, repo: name, workflow_id: WORKFLOW };
	const { paused } = await stateOf(t);
	if (body.paused) {
		// Already off (turned off here or on GitHub): only the runs in flight are left to cancel.
		if (!paused) await octokit.request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable", workflow);
		for (const status of ["in_progress", "queued"] as const) {
			const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", { ...workflow, status, per_page: 20 });
			await Promise.all(data.workflow_runs.map((run) => octokit.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel", { owner, repo: name, run_id: run.id }).catch(() => null)));
		}
	} else if (paused) {
		await octokit.request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable", workflow);
	}
	return Response.json(await stateOf(t));
}
