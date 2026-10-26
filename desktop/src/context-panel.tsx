import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

/** What an agent's last request carried, from its `context` event (see `measure` and the agent loop in swarm.rs). */
export type ContextUse = { used: number; window: number; compact_at: number; system: number; tools: number; task: number };

/** A `context` event's text: JSON, or "<used>/<window>" from logs written before the breakdown existed. */
export function parseContext(text: string): ContextUse | null {
	try {
		const c = JSON.parse(text) as Partial<ContextUse>;
		if (typeof c.used === "number" && typeof c.window === "number" && c.window > 0) {
			return { used: c.used, window: c.window, compact_at: c.compact_at ?? Math.round(c.window * 0.75), system: c.system ?? 0, tools: c.tools ?? 0, task: c.task ?? 0 };
		}
	} catch {
		const [used, window] = text.split("/").map(Number);
		if (window > 0 && Number.isFinite(used)) return { used, window, compact_at: Math.round(window * 0.75), system: 0, tools: 0, task: 0 };
	}
	return null;
}

/** 744k, 1M, 1.2k, 830. */
export function tokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);

/**
 * How full one agent's context window is and what fills it, like Claude Code's Context panel: the system prompt, the
 * tool definitions, the task (with an attached report), the conversation since, the room kept for compaction and what
 * is free. Compact now summarizes the older steps before the agent's next one. `rows` false leaves out the list.
 */
export function ContextBody({ role, color, use, onCompact, rows: showRows = true }: { role?: string; color?: string; use: ContextUse; onCompact?: () => Promise<unknown>; rows?: boolean }) {
	const [asked, setAsked] = useState(false);
	// The next count (after the compaction) clears the request.
	useEffect(() => setAsked(false), [use.used]);
	const fixed = use.system + use.tools + use.task;
	const messages = Math.max(0, use.used - fixed);
	const buffer = Math.max(0, use.window - Math.max(use.compact_at, use.used));
	const free = Math.max(0, use.compact_at - use.used);
	const rows = [
		{ label: "System prompt", n: use.system, swatch: "bg-zinc-400 dark:bg-zinc-500" },
		{ label: "Tools", n: use.tools, swatch: "bg-emerald-500" },
		{ label: "Task", n: use.task, swatch: "bg-amber-500" },
		{ label: "Messages", n: messages, swatch: "bg-blue-500" },
		{ label: "Compaction buffer", n: buffer, swatch: "bg-zinc-300 dark:bg-zinc-700" },
		{ label: "Free space", n: free, swatch: "border border-zinc-300 bg-transparent dark:border-zinc-600" },
	];
	return (
		<div className="space-y-2.5 text-[12px]">
			<div className="flex items-baseline justify-between gap-2 tabular-nums">
				<span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
					{role ? <span style={{ color }}>{role}</span> : null}
					<span>{Math.round(pct(use.used, use.window))}% used</span>
				</span>
				<span className="text-muted-foreground">
					{tokens(use.used)} / {tokens(use.window)}
				</span>
			</div>
			<div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
				{rows.slice(0, 5).map((r) => (r.n > 0 ? <span key={r.label} className={`h-full transition-[width] duration-700 ${r.swatch}`} style={{ width: `${pct(r.n, use.window)}%` }} /> : null))}
			</div>
			{showRows ? (
				<ul className="space-y-1">
					{rows.map((r) => (
						<li key={r.label} className="flex items-center gap-2 tabular-nums">
							<span className={`size-2.5 shrink-0 rounded-sm ${r.swatch}`} />
							<span className="flex-1 truncate text-foreground">{r.label}</span>
							<span className="text-muted-foreground">{tokens(r.n)}</span>
							<span className="w-11 text-right text-muted-foreground">{pct(r.n, use.window)}%</span>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex items-center justify-between gap-2 border-t pt-2.5">
				<span className="tabular-nums text-muted-foreground">
					{use.used >= use.compact_at ? "Compacts before the next step" : `${tokens(use.compact_at - use.used)} until compact`}
				</span>
				{onCompact ? (
					<button
						type="button"
						disabled={asked}
						onClick={() => {
							setAsked(true);
							void onCompact().catch(() => setAsked(false));
						}}
						className="h-6 shrink-0 rounded-md border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-muted disabled:text-muted-foreground disabled:hover:bg-background"
						title="Summarize the older steps before the agent's next one"
					>
						{asked ? "Before next step" : "Compact now"}
					</button>
				) : null}
			</div>
		</div>
	);
}

/** The same in the app's grey frame, for the chat header's popover; the header collapses the rows. */
export function ContextPanel({ role, color, use, onCompact }: { role: string; color: string; use: ContextUse; onCompact?: () => Promise<unknown> }) {
	const [open, setOpen] = useState(true);
	return (
		<section className="w-72 rounded-2xl border bg-muted p-1.5">
			<button type="button" onClick={() => setOpen(!open)} className="flex h-8 w-full items-center gap-1.5 px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
				Context · {role}
				<ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
			</button>
			<div className="rounded-xl border bg-card p-3 shadow-card">
				<ContextBody role={role} color={color} use={use} onCompact={onCompact} rows={open} />
			</div>
		</section>
	);
}
