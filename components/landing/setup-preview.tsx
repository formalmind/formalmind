"use client";

import { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import { TEAM_PRESETS, type TeamPreset } from "@/lib/teams";
import {
	BudgetCard,
	CreditsCard,
	GitHubCard,
	Panel,
	SETUP_STEPS,
	STEP_COPY,
	SetupSummary,
	StepList,
	TeamPicker,
	type StepKey,
} from "@/components/onboarding/steps";
import { PlanBoard, type PartialPlan } from "./plan-board";

/**
 * The landing page's setup, picked up as soon as a repository is chosen: the live plan is step one, and the
 * rest are onboarding's own steps. Money and GitHub steps lead to sign-up.
 */
export function SetupPreview({ repo, plan, done, failed, startHref }: { repo: string; plan: PartialPlan | undefined; done: boolean; failed: boolean; startHref: string }) {
	const [step, setStep] = useState<StepKey>("plan");
	const plannerPick = plan?.team?.preset ?? "pair";
	const [team, setTeam] = useState<TeamPreset>(plannerPick);
	const [squadSize, setSquadSize] = useState(4);
	const [dailyUsd, setDailyUsd] = useState(5);
	// A choice turns its step green: picking a team (or continuing past the planner's pick), setting a budget.
	const [chosen, setChosen] = useState<{ team?: boolean; budget?: boolean }>({});
	// A new repository starts over at its plan, with the planner's team suggestion.
	useEffect(() => {
		setStep("plan");
		setChosen({});
	}, [repo]);
	useEffect(() => setTeam(plannerPick), [plannerPick]);
	const index = SETUP_STEPS.findIndex((s) => s.key === step);
	const go = (offset: number) => {
		if (offset > 0 && (step === "team" || step === "budget")) setChosen((c) => ({ ...c, [step]: true }));
		goTo(offset);
	};
	const goTo = (offset: number) => setStep(SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, Math.max(0, index + offset))].key);
	const signUp = () => {
		window.location.href = startHref;
	};

	return (
		<div className="rounded-2xl border bg-card p-4 sm:p-6">
			{/* Steps and the way forward stay at the top, pinned while the step below scrolls. */}
			<div className="sticky top-0 z-10 -mx-4 -mt-4 flex flex-wrap items-center gap-2 rounded-t-2xl border-b bg-card/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mt-6 sm:px-6">
				<div className="min-w-0 flex-1">
					<StepList step={step} done={{ plan: done, team: chosen.team, budget: chosen.budget }} onSelect={setStep} horizontal />
				</div>
				<div className="flex shrink-0 gap-2">
					{index > 0 ? (
						<button type="button" onClick={() => go(-1)} className="h-9 rounded-full border px-4 text-sm hover:bg-muted">Back</button>
					) : null}
					{step === "start" ? (
						<a href={startHref} className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
							<Rocket className="size-4" /> Set up my swarm
						</a>
					) : (
						<button type="button" onClick={() => go(1)} className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Continue</button>
					)}
				</div>
			</div>
			<section className="mt-6 min-w-0">
				{step === "plan" ? (
					<Panel {...STEP_COPY.plan}>
						<PlanBoard repo={repo} plan={plan} status={done ? "done" : "planning"} />
					</Panel>
				) : step === "team" ? (
					<Panel {...STEP_COPY.team}>
						<TeamPicker
							value={team}
							onChange={(next) => {
								setTeam(next);
								setChosen((c) => ({ ...c, team: true }));
							}} plannerPick={plannerPick} squadSize={squadSize} onSquadSize={setSquadSize} />
					</Panel>
				) : step === "budget" ? (
					<Panel {...STEP_COPY.budget}>
						<BudgetCard
							dailyUsd={dailyUsd}
							onChange={(usd) => {
								setDailyUsd(usd);
								setChosen((c) => ({ ...c, budget: true }));
							}}
						/>
					</Panel>
				) : step === "credits" ? (
					<Panel {...STEP_COPY.credits}>
						<CreditsCard cents={0} dailyUsd={dailyUsd} configured onDeposit={signUp} />
					</Panel>
				) : step === "github" ? (
					<Panel {...STEP_COPY.github}>
						<GitHubCard repo={repo} installed={false} checking={false} onCheck={signUp} />
					</Panel>
				) : (
					<Panel {...STEP_COPY.start}>
						<SetupSummary
							rows={[
								{ label: "Repository", value: repo, ok: true },
								{ label: "Plan", value: done ? `${plan?.issues?.length ?? 0} issues, ${plan?.invariants?.length ?? 0} invariants` : failed ? "not finished: re-plan above" : "planning…", ok: done },
								{ label: "Team", value: `${TEAM_PRESETS.find((t) => t.key === team)?.name}${team === "squad" ? ` of ${squadSize}` : ""}`, ok: true },
								{ label: "Daily budget", value: `$${dailyUsd} a day`, ok: true },
								{ label: "Credits", value: "$0.00", ok: false },
								{ label: "GitHub App", value: "not installed", ok: false },
							]}
						/>
					</Panel>
				)}
			</section>
		</div>
	);
}
