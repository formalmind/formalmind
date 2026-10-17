import type { SwarmItem, SwarmRole, SwarmRun, SwarmState } from "@/lib/swarm";
import snapshot from "./swarm-state.json";

/**
 * Board states for stories, built from a real snapshot of asyncswap/v2-proofs
 * (stories/fixtures/swarm-state.json). Times are shifted to now so the live and
 * replay modes render the same way every time the story opens.
 */

const base = snapshot as SwarmState;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Nothing ran recently, so the board plays the replay. */
export function replayState(): SwarmState {
	return {
		...structuredClone(base),
		fetchedAt: ago(0),
		runs: base.runs.map((run, i) => ({ ...run, startedAt: ago(180 + i * 30), updatedAt: ago(178 + i * 30) })),
	};
}

const LIVE: Record<"prover" | "reviewer" | "merger" | "planner", { ref: number; title: string; tasks: [string, boolean][]; labels?: string[] }> = {
	prover: {
		ref: 61,
		title: "prove pool reserves and claim supply stay non-negative",
		tasks: [["Read the issue, Model.lean and PoolManager.sol", true], ["State reserves_nonneg for every v2 entry point", true], ["Prove the swap and donate cases", false], ["lake build clean, open the PR", false]],
		labels: ["fm:in-progress"],
	},
	reviewer: {
		ref: 63,
		title: "review BalNonNeg against Router.sol",
		tasks: [["Read the whole diff", true], ["Check each theorem statement against Router.sol", false], ["Approve or bounce", false]],
	},
	merger: {
		ref: 63,
		title: "second look at BalNonNeg, then merge or hold",
		tasks: [["Read the diff fresh", true], ["lake build on the exact head", true], ["Check the thread's claims against the code", false], ["Merge, delete branch, comment", false]],
	},
	planner: {
		ref: 38,
		title: "scope the queue and post a digest",
		tasks: [["Read roadmap, changelog and ledger", true], ["Queue new issues if fewer than two fm:todo", false], ["Post digest on ledger", false]],
	},
};

/** One role is mid-run, ticking through its notebook task list. */
export function liveState(role: keyof typeof LIVE = "prover"): SwarmState {
	const state = replayState();
	const plan = LIVE[role];
	const work: SwarmItem[] = state.work.map((item) => (item.number === plan.ref && plan.labels ? { ...item, labels: plan.labels } : item));
	if (role === "reviewer" || role === "merger") {
		const pr = state.merged.find((m) => m.number === plan.ref);
		if (pr) work.push({ ...pr, merged: false, labels: [role === "merger" ? "fm:approved" : "fm:review"] });
	}
	const run: SwarmRun = {
		id: 1,
		status: "in_progress",
		conclusion: null,
		phase: "working",
		startedAt: ago(4),
		updatedAt: ago(0),
		url: "https://github.com/asyncswap/v2-proofs/actions",
		usd: null,
		note: {
			repo: base.repo,
			role: role as SwarmRole,
			ref: plan.ref,
			runId: 1,
			title: plan.title,
			tasks: plan.tasks.map(([text, done]) => ({ text, done, dropped: false })),
			verified: null,
			left: null,
			next: null,
			createdAt: ago(3),
			updatedAt: ago(0),
			url: "https://github.com/asyncswap/v2-proofs/issues/55",
		},
	};
	return { ...state, work, merged: state.merged.filter((m) => !work.some((w) => w.number === m.number)), runs: [run, ...state.runs] };
}

/** The latest run finished a couple of minutes ago and is still on the board. */
export function justFinishedState(): SwarmState {
	const state = replayState();
	const [latest, ...rest] = base.runs;
	return { ...state, runs: [{ ...latest, startedAt: ago(4), updatedAt: ago(2) }, ...state.runs.slice(1, rest.length + 1)] };
}

export const openIssue = base.work[0];
export const mergedPr = base.merged[0];

/** The reviewer just finished and handed the turn to the merger. */
export function handoffState(): SwarmState {
	const state = liveState("reviewer");
	const [run, ...rest] = state.runs;
	const note = run.note!;
	return {
		...state,
		runs: [{
			...run,
			status: "completed",
			conclusion: "success",
			phase: "done",
			updatedAt: ago(1),
			note: { ...note, tasks: note.tasks.map((t) => ({ ...t, done: true })), verified: "approved PR #63", next: { to: "merger", why: "the swap case is the one to double-check" } },
		}, ...rest],
		work: state.work.map((item) => (item.number === 63 ? { ...item, labels: ["fm:approved"] } : item)),
	};
}

/** The prover is mid-turn on #61 and has asked the reviewer a question, which waits for its turn. */
export function askState(): SwarmState {
	const state = liveState("prover");
	return { ...state, work: state.work.map((item) => (item.number === 61 ? { ...item, labels: ["fm:in-progress", "fm:ask-reviewer"] } : item)) };
}

/**
 * One swarm across three projects: the live one, a second proofs repository whose issue the prover is
 * working on right now, and an account project with no proofs repository yet.
 */
export function severalProjectsState(): SwarmState {
	const state = liveState("prover");
	const other = "asyncswap/v3-proofs";
	const copy = (item: SwarmItem, number: number, labels = item.labels): SwarmItem => ({
		...item,
		repo: other,
		number,
		labels,
		url: `https://github.com/${other}/issues/${number}`,
	});
	const v2 = state.work.map((item) => ({ ...item, repo: state.repo, labels: item.labels.filter((l) => l !== "fm:in-progress") }));
	const v3 = state.work.slice(0, 3).map((item, i) => copy(item, 4 + i, i === 0 ? ["fm:in-progress"] : item.labels));
	const run = state.runs[0];
	return {
		...state,
		projects: [
			{ repo: "asyncswap/v2", proofsRepo: state.repo, inSwarm: true },
			{ repo: "asyncswap/v3", proofsRepo: other, inSwarm: true },
			{ repo: "asyncswap/hooks", proofsRepo: null, inSwarm: false },
		],
		work: [...v2, ...v3],
		merged: [...state.merged.map((item) => ({ ...item, repo: state.repo })), ...state.merged.slice(0, 1).map((item) => copy(item, 3))],
		runs: [{ ...run, note: run.note && { ...run.note, repo: other, ref: 4 } }, ...state.runs.slice(1)],
	};
}
