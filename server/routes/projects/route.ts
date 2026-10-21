import { auth } from "@/lib/auth";
import { addProject, listProjects } from "@/lib/projects";

/** The signed-in account's projects, for the sidebar's folders. */
export async function GET() {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	return Response.json({ projects: await listProjects(session.user.sub) });
}

/**
 * POST { repo: "owner/name" }: imports a GitHub repository as a project (Add a project → Remote repository), once it
 * is found on GitHub. Nothing else is set up: the code and audits are read from it, and a swarm asks for credits or a
 * key only when it starts.
 */
export async function POST(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const { repo = "" } = (await request.json().catch(() => ({}))) as { repo?: string };
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Response.json({ error: "Name a repository as owner/name." }, { status: 400 });
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "formal-mind" };
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${repo}`, { headers }).catch(() => null);
	if (res?.status === 404) return Response.json({ error: `${repo} isn't on GitHub, or it's private.` }, { status: 404 });
	// Found, or GitHub couldn't say (rate limit, outage): add it either way; the Code tab reports a repository it can't read.
	const name = res?.ok ? ((await res.json()) as { full_name?: string }).full_name ?? repo : repo;
	await addProject(session.user.sub, name);
	return Response.json({ repo: name });
}
