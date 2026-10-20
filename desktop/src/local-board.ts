import type { SwarmItem, SwarmRole, SwarmState } from "@/lib/swarm";

type Ev = { kind: string; role: string; item: string; text: string; spent: number };
type Item = { index: number; mark: string; text: string };

const ROLES: SwarmRole[] = ["planner", "prover", "reviewer", "assistant"];

/**
 * The local swarm as the board's state: plan items are the cards (todo, in progress while the prover has them, review
 * while the reviewer does, done once approved, blocked after three tries), and the working agent sits on its card.
 */
export function localBoard(folder: string, plan: Item[], events: Ev[], running: boolean): SwarmState {
	const repo = `local/${folder.split(/[\\/]/).filter(Boolean).pop() ?? "folder"}`;
	const now = new Date().toISOString();
	const status = running ? [...events].reverse().find((e) => e.kind === "status" && ROLES.includes(e.role as SwarmRole)) : undefined;
	const at = status && /^\d+$/.test(status.item) ? Number(status.item) : null;
	const card = (i: Item, labels: string[], merged = false): SwarmItem => ({
		repo, number: i.index, title: i.text, kind: merged ? "pr" : "issue", labels, url: "", updatedAt: now, createdAt: now,
		author: "formalmind", authorAvatar: "", excerpt: i.text, comments: 0, merged, state: merged ? "merged" : "open",
	});
	const work: SwarmItem[] = [];
	const merged: SwarmItem[] = [];
	for (const i of plan) {
		if (i.mark === "x") merged.push(card(i, ["fm:approved"], true));
		else if (i.mark === "!") work.push(card(i, ["fm:todo", "fm:blocked"]));
		else if (i.index === at) work.push(card(i, [status?.role === "reviewer" ? "fm:review" : "fm:in-progress"]));
		else work.push(card(i, ["fm:todo"]));
	}
	const spent = events.at(-1)?.spent ?? 0;
	return {
		repo, fetchedAt: now,
		projects: [{ repo, proofsRepo: repo, inSwarm: true }],
		work, merged: merged.reverse(),
		costs: spent ? [{ repo, role: "local", ref: "", usd: spent, runId: null, createdAt: now }] : [],
		spentToday: spent, chief: null, assistant: null, cycle: null, notebook: [], ledger: [],
		runs: [{ id: 1, status: running ? "in_progress" : "completed", conclusion: running ? null : "success", phase: running ? "working" : "done", startedAt: now, updatedAt: now, url: "", note: null, usd: spent }],
		active: status ? [{ repo, role: status.role as SwarmRole, ref: at, task: null, phase: "working", startedAt: now }] : [],
	};
}
