import { getProject } from "@/lib/project";

export async function GET() {
	try {
		return Response.json(await getProject());
	} catch (error) {
		console.error("[project] fetch failed:", error);
		return Response.json({ error: "Could not read the project from GitHub." }, { status: 502 });
	}
}
