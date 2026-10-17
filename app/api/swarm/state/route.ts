import { NextResponse } from "next/server";
import { getSwarmState } from "@/lib/swarm";

export async function GET() {
	try {
		return NextResponse.json(await getSwarmState());
	} catch (error) {
		console.error("[swarm] state fetch failed:", error);
		return NextResponse.json({ error: "Could not read the swarm state from GitHub." }, { status: 502 });
	}
}
