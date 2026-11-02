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
		</section>
	);
}
