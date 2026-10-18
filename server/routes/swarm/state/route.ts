import { auth } from "@/lib/auth";
import { LIVE_PROJECT, listProjects } from "@/lib/projects";
import { getSwarmState } from "@/lib/swarm";

/** The swarm across its projects and the signed-in account's. */
export async function GET() {
	try {
		const session = await auth.getSession();
		const projects = session?.user ? await listProjects(session.user.sub) : [LIVE_PROJECT];
		return Response.json(await getSwarmState(projects));
	} catch (error) {
		console.error("[swarm] state fetch failed:", error);
		return Response.json({ error: "Could not read the swarm state from GitHub." }, { status: 502 });
	}
}
