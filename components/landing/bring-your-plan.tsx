import { useId } from "react";
import { ArrowRight } from "lucide-react";

/** One box: a name and a mono sublabel. `focal` draws it in ink, `dashed` marks the pay-per-token route. */
export function Node({ x, y, w, name, sub, focal = false, dashed = false }: { x: number; y: number; w: number; name: string; sub: string; focal?: boolean; dashed?: boolean }) {
	return (
		<g>
			<rect x={x} y={y} width={w} height={56} rx={6} className={`fill-card ${focal ? "stroke-foreground" : "stroke-border"}`} strokeWidth={focal ? 1.5 : 1} strokeDasharray={dashed ? "5 4" : undefined} />
			<text x={x + 16} y={y + 24} className="fill-foreground text-[13px] font-medium">{name}</text>
			<text x={x + 16} y={y + 42} className="fill-muted-foreground font-mono text-[11px]">{sub}</text>
		</g>
	);
}

/** Who pays for the agents: the swarm runs on your computer and only its model calls leave, on your own plan. */
function RoutesDiagram() {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const ink = `${id}-ink`;
	const soft = `${id}-soft`;
	return (
		<svg viewBox="0 0 768 316" role="img" aria-labelledby={`${id}-title ${id}-desc`} className="h-auto w-full">
			<title id={`${id}-title`}>Who pays for the agents</title>
			<desc id={`${id}-desc`}>
				The swarm runs on your computer with your files, lake and forge. Its model calls go out through your signed-in Claude Code to your Claude Pro or Max plan, through Codex to your ChatGPT Plus or Pro plan, or with an Anthropic or OpenAI key billed per token.
			</desc>
			<defs>
				<marker id={ink} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-foreground" />
				</marker>
				<marker id={soft} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-muted-foreground" />
				</marker>
			</defs>

			{/* Your computer: everything but the model calls stays inside. */}
			<rect x={4} y={24} width={400} height={248} rx={10} className="fill-muted/40 stroke-border" strokeDasharray="4 4" />
			<text x={24} y={48} className="fill-muted-foreground font-mono text-[11px] uppercase tracking-wider">Your computer</text>
			<text x={548} y={48} className="fill-muted-foreground font-mono text-[11px] uppercase tracking-wider">Paid by</text>

			{/* Arrows before boxes, so the lines sit behind them. */}
			<g fill="none" className="stroke-muted-foreground" strokeWidth={1.25}>
				<path d="M192 137 H200 Q208 137 208 129 V96 Q208 88 216 88 H230" markerEnd={`url(#${soft})`} />
				<path d="M192 156 H230" markerEnd={`url(#${soft})`} />
				<path d="M192 175 H200 Q208 175 208 183 V216 Q208 224 216 224 H230" markerEnd={`url(#${soft})`} />
			</g>
			<g fill="none" strokeWidth={1.5}>
				<path d="M380 88 H546" className="stroke-foreground" markerEnd={`url(#${ink})`} />
				<path d="M380 156 H546" className="stroke-foreground" markerEnd={`url(#${ink})`} />
				<path d="M380 224 H546" className="stroke-muted-foreground" strokeWidth={1.25} strokeDasharray="5 4" markerEnd={`url(#${soft})`} />
			</g>
			<rect x={428} y={64} width={100} height={16} className="fill-background" />
			<text x={478} y={76} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px] uppercase tracking-wider">Model calls</text>

			<Node x={32} y={128} w={160} name="Agent swarm" sub="files · lake · forge" />
			<Node x={232} y={60} w={148} name="Claude Code" sub="agentic CLI" />
			<Node x={232} y={128} w={148} name="Codex" sub="agentic CLI" />
			<Node x={232} y={196} w={148} name="Keychain" sub="your API key" />
			<Node x={548} y={60} w={212} name="Claude Pro or Max" sub="Anthropic · your plan" focal />
			<Node x={548} y={128} w={212} name="ChatGPT Plus or Pro" sub="OpenAI · your plan" focal />
			<Node x={548} y={196} w={212} name="Anthropic or OpenAI" sub="billed per token" dashed />

			{/* Legend strip. */}
			<path d="M8 300 H36" className="stroke-foreground" strokeWidth={1.5} />
			<text x={44} y={304} className="fill-muted-foreground text-[12px]">Your plan's usage limits, nothing charged to a key</text>
			<path d="M380 300 H408" className="stroke-muted-foreground" strokeWidth={1.25} strokeDasharray="5 4" />
			<text x={416} y={304} className="fill-muted-foreground text-[12px]">Billed to your key, with a spending cap</text>
		</svg>
	);
}

/** The landing page's "bring your own plan" section: the agents run on the Claude or ChatGPT plan you already pay for. */
export function BringYourPlan() {
	return (
		<section className="mx-auto w-full max-w-6xl shrink-0 px-4 pt-16 sm:px-6">
			<div className="mx-auto max-w-2xl text-center">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Agentic</p>
				<h2 className="mt-3 text-balance font-display text-4xl leading-[1.1] sm:text-5xl">Bring your own Claude Max or ChatGPT plan</h2>
				<p className="mx-auto mt-4 max-w-[560px] text-balance text-[15px] leading-[22px] text-muted-foreground">
					Run the agents on the Claude Code or Codex you already pay for. No API key needed.
				</p>
			</div>
			<div className="mt-10 rounded-2xl border bg-muted/60 p-1.5">
				<div className="shadow-card overflow-x-auto rounded-xl border bg-card p-4 sm:p-6">
					<div className="mx-auto min-w-[640px] max-w-[880px]">
						<RoutesDiagram />
					</div>
				</div>
			</div>
			<p className="mt-4 text-center text-sm">
				<a href="/docs/models" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
					Models and costs <ArrowRight className="size-3.5" />
				</a>
			</p>
		</section>
	);
}
