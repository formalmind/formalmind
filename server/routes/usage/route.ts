import { auth } from "@/lib/auth";
import { getCredits } from "@/lib/billing";
import type { SwarmCost } from "@/lib/swarm";

/** Every cost line formal.team's model proxy charged the signed-in account (its "formal" route), one line per run. */
export async function GET() {
	try {
		const session = await auth.getSession();
		if (!session?.user) return Response.json({ costs: [], syncedAt: null });
		const runs = new Map<string, SwarmCost>();
		for (const e of (await getCredits(session.user.sub)).entries) {
			if (e.kind !== "spend") continue;
			const [repo, run, role = "", ref = ""] = e.ref.split(":");
			if (!repo) continue;
			const key = `${repo}:${run}:${role}:${ref}`;
			const line = runs.get(key) ?? { repo, role: role || "run", ref: refLabel(ref), usd: 0, runId: Number(run) || null, createdAt: e.at };
			line.usd += -e.cents / 100;
			if (e.at > line.createdAt) line.createdAt = e.at;
			runs.set(key, line);
		}
		const costs = [...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return Response.json({ costs, syncedAt: Date.now() });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Could not read usage." }, { status: 502 });
	}
}

/** One "#" in front of an item number, however many the source wrote ("25", "#25" and "##25" all read "#25"). */
function refLabel(ref: string | null | undefined): string {
	const bare = (ref ?? "").trim().replace(/^#+/, "");
	return bare ? `#${bare}` : "";
}
