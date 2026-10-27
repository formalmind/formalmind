/**
 * What an agent can ask the Mac app to do or read through the relay, by name: everything the folder page does, run
 * the way the app runs it (desktop/src/relay.ts). `write` ones change something or spend; the rest only read.
 * Secrets (tokens, keys), the terminal and the interactive debugger aren't here.
 */
export const MAC_OPS = {
	// Reads
	folders: { write: false, args: "", about: "the added folders and their sessions (folder not needed)" },
	status: { write: false, args: "", about: "Claude Code's sign-in, whether an Anthropic or OpenAI key is set, and the model route Settings uses (folder not needed)" },
	files: { write: false, args: "", about: "the folder's file tree" },
	scan: { write: false, args: "", about: "the folder's Solidity and Lean files" },
	git: { write: false, args: "", about: "the folder's git graph" },
	read_file: { write: false, args: "path", about: "a file in the folder, by path relative to it" },
	plan: { write: false, args: "", about: "the plan (.formal/plan.md): one item per function, with its mark" },
	statements: { write: false, args: "", about: "the statements and how far each has got" },
	bugs: { write: false, args: "", about: "the findings, each with its PoC" },
	proofs: { write: false, args: "", about: "which files and theorems proved each item" },
	queue: { write: false, args: "run?, done?", about: "a session's job queue (the main one by default): its open jobs, and with done: true each finished job's result (approve, changes, bug) and its agent's summary, such as a reviewer's reasons" },
	sessions: { write: false, args: "", about: "the folder's sessions" },
	running: { write: false, args: "", about: "the sessions running now" },
	history: { write: false, args: "run", about: "a session's events from its log" },
	scripts: { write: false, args: "", about: "what each deploy script deploys and calls: the scope" },
	units: { write: false, args: "entry", about: "an entry file's units of work (functions with their footprint)" },
	coverage: { write: false, args: "entry", about: "an entry file's Lean coverage, function by function" },
	slice: { write: false, args: "entry, function", about: "the brief an agent gets for one function" },
	reach: { write: false, args: "entry", about: "the Bug Hunter's call graph by what's known of each branch" },
	report_quote: { write: false, args: "", about: "what Formal Mind's report costs for this folder and commit" },
	work_map: { write: false, args: "", about: "what's covered and what's left, as JSON: every in-scope function's status (proved, has_sorry, in_lean, not_modeled), the Lean def a theorem must name, the model and where its proof goes, theorems with file and line, its plan item, the open items to take next, and models formal-ast could now translate more of" },
	health: { write: false, args: "limit?", about: "the swarm's health: its newest agent turns (role, item, tool calls, lake builds, how each ended) with anything that looked wrong, such as tools that didn't connect, tool calls written as text, loops or repeated build failures; folder optional" },
	ledger: { write: false, args: "check?, force?", about: "the proof ledger: each function proved or not and why (its theorems built and checked by Lean, no sorry or extra axioms, a statement about the def, the reviewer's approval still matching the def and the theorems), with each theorem's statement and doc comment; check (default true) runs Lean when the sources changed" },
	brief: { write: false, args: "function", about: "what the swarm's prover gets for a function (its Lean def, slice, and where to write the proof), by Lean def" },
	// Actions
	questions: { write: false, args: "", about: "the swarm's questions waiting for an answer: each statement's claim, what the swarm formalized it to mean, its assumptions and functions; answer with confirm_statement or correct_statement" },
	answers: { write: true, args: "who", about: "who answers the swarm's questions: mcp (the default: you, or an MCP client acting for you) or agent (an answerer agent confirms or corrects each formalization once, and leaves doubts for you)" },
	verify_repo: { write: true, args: "repo, ref?, goal?, budget?, path?", about: "verify any GitHub repository at a branch, tag or commit: the Mac forks it into formalmind, clones it (into ~/formal-targets unless path is given), checks out ref on its own branch, adds the folder with Report to GitHub on, and starts the swarm; each approved proof is committed (co-authored by formalmind[bot]) and pushed to the fork" },
	add_folder: { write: true, args: "path", about: "add a folder on the Mac (an absolute path; folder not needed)" },
	remove_folder: { write: true, args: "path", about: "remove a folder from the list (its files stay)" },
	start: { write: true, args: "goal?, budget?, run?", about: "start or resume the swarm, with the model route Settings uses" },
	hunt: { write: true, args: "focus?, budget?, run?", about: "start the Bug Hunter (Concolic) on a focus, or the whole codebase" },
	stop: { write: true, args: "run", about: "stop a session (as pause)" },
	pause: { write: true, args: "run?", about: "pause a session now, or every running session in the folder: the agent's turn and the folder's background tasks (a long lean or forge run) stop, the job stays queued" },
	resume: { write: true, args: "run?", about: "resume a paused session (the folder's main one by default) from its queue, on the model route Settings uses (your Claude plan by default)" },
	say: { write: true, args: "run, text", about: "a message to a session, as if typed in its chat" },
	set_budget: { write: true, args: "run, usd", about: "a session's spending cap" },
	add_statement: { write: true, args: "text", about: "a claim in plain words; a stopped swarm starts just for statements" },
	confirm_statement: { write: true, args: "id", about: "confirm a formalized statement means what you meant" },
	correct_statement: { write: true, args: "id, text", about: "what a formalized statement should mean instead" },
	mark_statement: { write: true, args: "id, mark", about: "set a statement's mark ([ ] [?] [~] [x] [!] [-])" },
	remove_statement: { write: true, args: "id", about: "remove a statement" },
	triage: { write: true, args: "path", about: "queue an audit report (a file in the folder) for the swarm's auditor" },
	reach_run: { write: true, args: "tool, target?", about: "run one Bug Hunter tool (coverage, explore) from Reach" },
	github: { write: true, args: "on", about: "turn the folder's Report to GitHub on or off: off (the default) keeps everything local; on lets Formal Mind's GitHub App comment on the repository's pull requests with what the ledger says changed" },
	report: { write: true, args: "dirs?", about: "generate Formal Mind's report ($150 from credits, once per repository and commit)" },
	refresh_model: { write: true, args: "", about: "rewrite each generated model formal-ast now translates more of, so a def a proof needs exists in the file Lake builds" },
	check_proof: { write: true, args: "path, content?", about: "write a .lean proof under the Lake sources' Proofs/ (when content is given) and check it as the swarm does: no sorry/admit/axiom/native_decide, lake build, which functions it proves" },
	submit_proof: { write: true, args: "function, path, notes?", about: "send a checked proof to the swarm's reviewer, like its own prover's work; approved, the item is proved and goes into the audit file" },
} as const;

export type MacOp = keyof typeof MAC_OPS;
