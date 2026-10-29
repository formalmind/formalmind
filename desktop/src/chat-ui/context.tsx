import { ContextBody, type ContextUse } from "../context-panel";

/**
 * One agent's context window in a card: how full it is, what fills it (system prompt, tools, task, messages, the room
 * kept for compaction, free space), and Compact now, which asks the swarm to summarize the older steps.
 */
export function ContextCard({ role, color, use, onCompact }: { role: string; color?: string; use: ContextUse; onCompact?: () => Promise<unknown> }) {
	return (
		<section className="rounded-2xl border bg-card p-3 text-[13px] font-normal shadow-card">
			<ContextBody role={role} color={color} use={use} onCompact={onCompact} />
		</section>
	);
}
