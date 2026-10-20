import { auth } from "@/lib/auth";
import { getCredits } from "@/lib/billing";
import { projectObject } from "@/lib/spend";
import type { SwarmCost } from "@/lib/swarm";

/**
 * Every cost line: the swarm home's ledger (from the Project Durable Object, so usage doesn't depend on GitHub), plus
 * what formal.team's model proxy charged the signed-in account, one line per run, for projects that ledger doesn't cover.
 */
export async function GET() {
	const project = projectObject();
	if (!project) return Response.json({ error: "The PROJECT Durable Object binding is missing; see wrangler.jsonc." }, { status: 500 });
	try {
		const ledger = (await project.costs()) as { costs: SwarmCost[]; syncedAt: number | null };
		// One "#" in front of an item number, however many the source wrote ("25", "#25" and "##25" all read "#25").
		for (const c of ledger.costs) c.ref = refLabel(c.ref);
		const session = await auth.getSession();
		if (!session?.user) return Response.json(ledger);
		const covered = new Set(ledger.costs.map((c) => c.repo.toLowerCase()));
		const runs = new Map<string, SwarmCost>();
		for (const e of (await getCredits(session.user.sub)).entries) {
			if (e.kind !== "spend") continue;
			const [repo, run, role = "", ref = ""] = e.ref.split(":");
			if (!repo || covered.has(repo.toLowerCase())) continue;
			const key = `${repo}:${run}:${role}:${ref}`;
			const line = runs.get(key) ?? { repo, role: role || "run", ref: refLabel(ref), usd: 0, runId: Number(run) || null, createdAt: e.at };
			line.usd += -e.cents / 100;
			if (e.at > line.createdAt) line.createdAt = e.at;
			runs.set(key, line);
		}
		const costs = [...ledger.costs, ...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return Response.json({ ...ledger, costs });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Could not read usage." }, { status: 502 });
	}
}

function refLabel(ref: string | null | undefined): string {
	const bare = (ref ?? "").trim().replace(/^#+/, "");
	return bare ? `#${bare}` : "";
}
