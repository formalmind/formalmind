"use client";

import { useEffect, useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { PlanBoard, type PartialPlan } from "./plan-board";

/** How long the sign-in card shows before going on to sign in. */
const LEAD_MS = 3000;

/**
 * The landing page's live demo: the planner's plan for the repository streaming in, in the app's card frame. When it
 * finishes streaming here, a card rises over it with Get started, and the visitor goes on to sign in (then home, to Add a
 * project with this repository filled in); Stay here keeps them on the plan. A plan resumed from an earlier visit
 * doesn't lead on by itself. `fill` makes it take its container's height (the full-screen hand-off), with `onClose`.
 */
export function SetupPreview({ repo, plan, done, failed, startHref, fill = false, onClose }: { repo: string; plan: PartialPlan | undefined; done: boolean; failed: boolean; startHref: string; fill?: boolean; onClose?: () => void }) {
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
		<section className={`relative rounded-2xl border bg-muted/60 p-1.5 ${fill ? "flex min-h-0 w-full flex-col shadow-pop" : ""}`}>
			<header className="flex h-10 shrink-0 items-center gap-3 px-2.5" aria-live="polite">
				<span className="truncate font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Plan · {repo}</span>
				<span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
					{failed ? (
						"The plan didn't finish."
					) : !done ? (
						<>
							<span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
							Planning {name}…
						</>
					) : (
						<a href={startHref} className="btn-dark h-8 gap-1.5 px-3.5 text-[13px]">
							Get started <ArrowRight className="size-3.5" />
						</a>
					)}
					{onClose ? (
						<button type="button" onClick={onClose} title="Back" aria-label="Back" className="grid size-8 place-items-center rounded-full hover:bg-background hover:text-foreground">
							<X className="size-4" />
						</button>
					) : null}
				</span>
			</header>
			<div className={`shadow-card rounded-xl border bg-card p-3 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
				<PlanBoard repo={repo} plan={plan} status={done ? "done" : "planning"} />
			</div>
			{leaving ? (
				// The way in, once the plan is there: up from the bottom of the plan.
				<div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
					<div className="fm-rise pointer-events-auto w-full max-w-sm rounded-2xl border bg-popover p-5 text-center shadow-pop">
						<p className="font-display text-2xl">{name} is planned.</p>
						<p className="mt-1 text-[13px] text-muted-foreground">Sign in to add it and start the swarm. Taking you there…</p>
						<div className="mt-4 flex items-center justify-center gap-2">
							<a href={startHref} className="btn-dark h-9 gap-2 px-4">
								Get started <ArrowRight className="size-4" />
							</a>
							<button type="button" onClick={() => setStay(true)} className="btn-soft h-9 px-4">
								Stay here
							</button>
						</div>
					</div>
				</div>
			) : null}
		</section>
	);
}
