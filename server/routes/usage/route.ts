import { projectObject } from "@/lib/spend";

/** Every cost line, from the Project Durable Object: usage does not depend on GitHub being reachable. */
export async function GET() {
	const project = projectObject();
	if (!project) return Response.json({ error: "The PROJECT Durable Object binding is missing; see wrangler.jsonc." }, { status: 500 });
	try {
		return Response.json(await project.costs());
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Could not read usage." }, { status: 502 });
	}
}
