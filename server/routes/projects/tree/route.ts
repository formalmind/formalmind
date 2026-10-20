import { auth } from "@/lib/auth";
import { parseRepo } from "@/lib/plan";
import { listProjects } from "@/lib/projects";
import { installationFor } from "@/lib/proofs-repo";

/** Folders the tree leaves out: version control, dependencies, build output (as the desktop app does). */
const SKIP = new Set([".git", "node_modules", "lib", "dependencies", "out", "cache", "target", ".lake", "dist", "broadcast", ".next"]);
const LIMIT = 5000;

/** One of your projects' repositories, read through the formalmind GitHub App. */
export async function projectRepo(repoParam: string | null) {
	const session = await auth.getSession();
	if (!session?.user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
	const repo = parseRepo(repoParam ?? "");
	if (!repo || !(await listProjects(session.user.sub)).some((p) => p.repo === repo)) {
		return { error: Response.json({ error: "That isn't one of your projects." }, { status: 404 }) };
	}
	const [owner, name] = repo.split("/");
	const octokit = await installationFor(owner, name).catch(() => null);
	if (!octokit) return { error: Response.json({ error: `The formalmind GitHub App can't reach ${repo}. Install it on ${owner}.` }, { status: 409 }) };
	return { owner, name, octokit };
}

/** The project's files on its default branch, for the sidebar's file tree. */
export async function GET(request: Request) {
	const t = await projectRepo(new URL(request.url).searchParams.get("repo"));
	if ("error" in t) return t.error as Response;
	const { owner, name, octokit } = t;
	const { data: info } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name });
	const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo: name, tree_sha: info.default_branch, recursive: "1" });
	const files = data.tree
		.filter((e) => e.type === "blob" && e.path && !e.path.split("/").slice(0, -1).some((d) => SKIP.has(d)))
		.map((e) => e.path as string);
	return Response.json({ files: files.slice(0, LIMIT), truncated: data.truncated || files.length > LIMIT, branch: info.default_branch });
}
