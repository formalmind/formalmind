import type { SwarmCost, SwarmItem, SwarmNote, SwarmRole, SwarmState } from "@/lib/swarm";

type Ev = { kind: string; role: string; item: string; text: string; spent: number };
type Item = { index: number; mark: string; text: string };

const ROLES: SwarmRole[] = ["planner", "prover", "reviewer", "rebuilder", "editor", "assistant"];
/** The ledger's names for the roles (its rows are coloured by them). */
const COST_NAME: Record<string, string> = { planner: "plan", prover: "prove", reviewer: "review", rebuilder: "rebuild", editor: "editor", assistant: "assistant" };

/** One agent turn in the session's events: from its first status to the next turn's. */
type Turn = { role: SwarmRole; item: string; tools: string[]; now: string | null; startSpent: number; endSpent: number };

function turns(events: Ev[]): Turn[] {
	const out: Turn[] = [];
	let lastSpent = 0;
	for (const e of events) {
		const t = out.at(-1);
		// A turn starts when an agent's status names another role or item (the swarm's own steps before "<role> is
		// working", like reading the AST, belong to the turn they prepare).
		if (e.kind === "status" && ROLES.includes(e.role as SwarmRole) && (!t || t.role !== e.role || t.item !== e.item)) {
			if (t) t.endSpent = lastSpent;
			out.push({ role: e.role as SwarmRole, item: e.item, tools: [], now: e.text, startSpent: lastSpent, endSpent: lastSpent });
		} else if (t && e.role === t.role) {
			if (e.kind === "tool") {
				t.tools.push(e.text.replace(/\s+/g, " ").slice(0, 90));
				t.now = null;
			} else if (e.kind === "status") t.now = e.text;
			else if (e.kind === "say") t.now = null;
		}
		lastSpent = e.spent || lastSpent;
		if (out.length) out[out.length - 1].endSpent = lastSpent;
	}
	return out;
}

/**
 * The local swarm as the board's state: plan items are the cards (todo, in progress while the prover has them, review
 * while the reviewer does, done once approved, blocked after three tries), the working agent sits on its card saying
 * what it is doing, the notebook lists the current turn's steps, and the ledger has a line per turn.
 */
export function localBoard(folder: string, plan: Item[], events: Ev[], running: boolean, budgetUsd?: number): SwarmState {
	const repo = `local/${folder.split(/[\\/]/).filter(Boolean).pop() ?? "folder"}`;
	const now = new Date().toISOString();
	const all = turns(events);
	const current = running ? all.at(-1) : undefined;
	const at = current && /^\d+$/.test(current.item) ? Number(current.item) : null;
	const card = (i: Item, labels: string[], merged = false): SwarmItem => ({
		repo, number: i.index, title: i.text, kind: merged ? "pr" : "issue", labels, url: "", updatedAt: now, createdAt: now,
		author: "formalmind", authorAvatar: "", excerpt: i.text, comments: 0, merged, state: merged ? "merged" : "open",
	});
	const work: SwarmItem[] = [];
	const merged: SwarmItem[] = [];
	for (const i of plan) {
		if (i.mark === "x") merged.push(card(i, ["fm:approved"], true));
		else if (i.mark === "!") work.push(card(i, ["fm:todo", "fm:blocked"]));
		else if (i.index === at) work.push(card(i, [current?.role === "reviewer" ? "fm:review" : "fm:in-progress"]));
		else work.push(card(i, ["fm:todo"]));
	}
	const spent = events.at(-1)?.spent ?? 0;
	// A ledger line per turn that cost something.
	const costs: SwarmCost[] = all
		.filter((t) => t.endSpent - t.startSpent > 0.0005)
		.map((t) => ({ repo, role: COST_NAME[t.role] ?? t.role, ref: /^\d+$/.test(t.item) ? t.item : "", usd: t.endSpent - t.startSpent, runId: null, createdAt: now }));
	if (!costs.length && spent) costs.push({ repo, role: "local", ref: "", usd: spent, runId: null, createdAt: now });
	// The current turn's notebook entry: its tool calls ticked off, then what it is doing now.
	const note: SwarmNote | null = current
		? {
				repo, role: current.role, ref: at, runId: 1, title: current.role === "planner" ? "Plan" : at ? `Item ${at}` : current.item || current.role,
				tasks: [...current.tools.slice(-7).map((text) => ({ text, done: true, dropped: false })), { text: current.now ?? "thinking", done: false, dropped: false }],
				verified: null, left: null, next: null, createdAt: now, updatedAt: now, url: "",
			}
		: null;
	const last = [...events].reverse().find((e) => e.kind === "done" || e.kind === "plan" || e.kind === "bug");
	const headline = current ? `${current.role}${at ? ` on item ${at}` : ""}: ${current.now ?? current.tools.at(-1) ?? "thinking"}` : (last?.text ?? (plan.length ? `${plan.filter((i) => i.mark === "x").length} of ${plan.length} items proven` : "Idle"));
	return {
		repo, fetchedAt: now,
		projects: [{ repo, proofsRepo: repo, inSwarm: true }],
		work, merged: merged.reverse(),
		costs,
		spentToday: spent, budgetUsd, chief: { body: `Swarm — ${headline}`, createdAt: now, url: "" }, assistant: null, cycle: null, notebook: [], ledger: [],
		runs: [{ id: 1, status: running ? "in_progress" : "completed", conclusion: running ? null : "success", phase: running ? "working" : "done", startedAt: now, updatedAt: now, url: "", note, usd: spent }],
		active: current ? [{ repo, role: current.role, ref: at, task: current.now, phase: "working", startedAt: now }] : [],
	};
}
