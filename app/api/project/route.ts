import { NextResponse } from "next/server";
import { getProject } from "@/lib/project";

export async function GET() {
	try {
		return NextResponse.json(await getProject());
	} catch (error) {
		console.error("[project] fetch failed:", error);
		return NextResponse.json({ error: "Could not read the project from GitHub." }, { status: 502 });
	}
}
