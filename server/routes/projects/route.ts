import { auth } from "@/lib/auth";
import { listProjects } from "@/lib/projects";

/** The signed-in account's projects, for the sidebar's folders. */
export async function GET() {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	return Response.json({ projects: await listProjects(session.user.sub) });
}
