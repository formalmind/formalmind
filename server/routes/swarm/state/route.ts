import { getSwarmState } from "@/lib/swarm";

export async function GET() {
	try {
		return Response.json(await getSwarmState());
	} catch (error) {
		console.error("[swarm] state fetch failed:", error);
		return Response.json({ error: "Could not read the swarm state from GitHub." }, { status: 502 });
	}
}
