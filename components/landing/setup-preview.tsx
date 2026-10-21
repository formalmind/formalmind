"use client";

import { useEffect, useState } from "react";
import { PlanBoard, type PartialPlan } from "./plan-board";

/** How long the finished plan stays on screen before sign-in. */
const LEAD_MS = 2500;

/**
 * The landing page's live demo, in the demo's place: the planner's plan for the repository streaming in, under one
 * quiet line saying what's happening. When it finishes streaming here, the visitor goes straight on to sign in (then
 * home, to Add a project with this repository filled in); Stay here keeps them on the plan. A plan resumed from an
 * earlier visit doesn't lead on by itself.
 */
export function SetupPreview({ repo, plan, done, failed, startHref }: { repo: string; plan: PartialPlan | undefined; done: boolean; failed: boolean; startHref: string }) {
	const [stay, setStay] = useState(false);
	const [streamed, setStreamed] = useState(false);
	useEffect(() => {
		if (!done) setStreamed(true);
	}, [done]);
	const leaving = streamed && done && !failed && !stay;
	useEffect(() => {
		if (!leaving) return;
		const t = setTimeout(() => {
			window.location.href = startHref;
		}, LEAD_MS);
		return () => clearTimeout(t);
	}, [leaving, startHref]);
	const name = repo.split("/").pop();

	return (
		// The app's card: a gray frame with a small label (and what's happening), the board on the card inside.
		<section className="rounded-2xl border bg-muted/60 p-1.5">
			<header className="flex h-8 items-center gap-3 px-2.5" aria-live="polite">
				<span className="truncate font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Plan · {repo}</span>
				<span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
					{failed ? (
						"The plan didn't finish."
					) : !done ? (
						<>
							<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
							Planning {name}…
						</>
					) : leaving ? (
						<>
							Planned. Taking you to sign in…
							<button type="button" onClick={() => setStay(true)} className="underline underline-offset-2 hover:text-foreground">
								Stay here
							</button>
						</>
					) : (
						<a href={startHref} className="underline underline-offset-2 hover:text-foreground">
							Sign in to add it
						</a>
					)}
				</span>
			</header>
			<div className="shadow-card rounded-xl border bg-card p-3">
				<PlanBoard repo={repo} plan={plan} status={done ? "done" : "planning"} />
			</div>
		</section>
	);
}
