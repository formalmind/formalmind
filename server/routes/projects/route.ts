import { auth0 } from "@/lib/auth0";
import { listProjects } from "@/lib/projects";

/** The signed-in account's projects, for the sidebar's folders. */
export async function GET() {
	const session = await auth0.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	return Response.json({ projects: await listProjects(session.user.sub) });
}
