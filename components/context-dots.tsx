/**
 * How full an agent's context is, as a grid of dots: each dot is an equal share of the window, coloured by what fills
 * it (the role's instructions, the task, the tools' schemas, then the conversation), with a ring on the dot where the
 * swarm compacts. The data is the swarm's `context` event: `{ system, task, tools, used, window, compact_at }`.
 * While the agent works, the newest filled dot pulses; while it loads, the empty grid breathes. Nothing slides or
 * fades in.
 */

export type ContextUse = {
	/** Tokens in the role's instructions, the task and the tool schemas. */
	system: number;
	task: number;
	tools: number;
	/** All tokens in use, those three included. */
	used: number;
	window: number;
	/** Where the swarm compacts the conversation, if it does. */
	compact_at?: number;
	/** The count is an estimate (Claude Code and Codex don't report it exactly). */
	estimated?: boolean;
};

const PARTS = [
	{ key: "system", label: "Instructions", dot: "bg-violet-500" },
	{ key: "task", label: "Task", dot: "bg-sky-500" },
	{ key: "tools", label: "Tools", dot: "bg-amber-500" },
	{ key: "talk", label: "Conversation", dot: "bg-foreground/70" },
] as const;

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function ContextDots({
	use,
	state = "idle",
	columns = 25,
	rows = 4,
}: {
	use?: ContextUse;
	/** `running`: the newest dot pulses; `loading`: no count yet, the grid breathes. */
	state?: "idle" | "running" | "loading";
	columns?: number;
	rows?: number;
}) {
	const n = columns * rows;
	const per = use && use.window > 0 ? use.window / n : 0;
	const talk = use ? Math.max(0, use.used - use.system - use.task - use.tools) : 0;
	const sizes = use ? { system: use.system, task: use.task, tools: use.tools, talk } : { system: 0, task: 0, tools: 0, talk: 0 };
	// Each part fills whole dots in order; a part too small for one still gets one, so it shows.
	const kinds: (typeof PARTS)[number]["key"][] = [];
	if (per > 0) {
		for (const p of PARTS) {
			const count = sizes[p.key] > 0 ? Math.max(1, Math.round(sizes[p.key] / per)) : 0;
			for (let i = 0; i < count && kinds.length < n; i++) kinds.push(p.key);
		}
	}
	const compactDot = use?.compact_at && per > 0 ? Math.min(n - 1, Math.floor(use.compact_at / per)) : -1;
	const loading = state === "loading" || !use;
	const pct = use && use.window > 0 ? Math.round((use.used / use.window) * 100) : 0;
	return (
		<figure className="w-full space-y-2 text-[13px]" aria-label={use ? `Context ${pct}% full` : "Context loading"}>
			<div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
				{Array.from({ length: n }, (_, i) => {
					const kind = kinds[i];
					const color = kind ? PARTS.find((p) => p.key === kind)!.dot : "bg-muted";
					const newest = state === "running" && i === kinds.length - 1;
					return (
						<span
							key={i}
							className={`aspect-square rounded-full ${color} ${newest || loading ? "motion-safe:animate-pulse" : ""} ${i === compactDot ? "ring-1 ring-foreground/40 ring-offset-1 ring-offset-background" : ""}`}
							style={loading ? { animationDelay: `${(i % columns) * 40}ms` } : undefined}
						/>
					);
				})}
			</div>
			<figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
				{use ? (
					<>
						<span className="text-foreground">
							{use.estimated ? "≈" : ""}
							{tokens.format(use.used)} of {tokens.format(use.window)} · {pct}%
						</span>
						{PARTS.map((p) => (
							<span key={p.key} className="inline-flex items-center gap-1.5">
								<span className={`size-2 rounded-full ${p.dot}`} />
								{p.label} {tokens.format(sizes[p.key])}
							</span>
						))}
						{use.compact_at ? <span>compacts at {tokens.format(use.compact_at)}</span> : null}
					</>
				) : (
					<span>Reading the context…</span>
				)}
			</figcaption>
		</figure>
	);
}
