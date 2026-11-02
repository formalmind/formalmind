/** The landing page's "bring your own plan" section: the agents run on the Claude or ChatGPT plan you already pay for. */
export function BringYourPlan() {
	return (
		<section className="mx-auto w-full max-w-6xl shrink-0 px-4 pt-16 sm:px-6">
			<div className="mx-auto max-w-2xl text-center">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Agentic</p>
				<h2 className="mt-3 font-display text-[clamp(1.75rem,9.2vw,2.25rem)] leading-[1.1] sm:text-5xl">Bring your own<br />Claude Max or ChatGPT plan</h2>
			</div>
		</section>
	);
}
