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
	StepNav,
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
	// A new repository starts over at its plan, with the planner's team suggestion.
	useEffect(() => setStep("plan"), [repo]);
	useEffect(() => setTeam(plannerPick), [plannerPick]);
	const index = SETUP_STEPS.findIndex((s) => s.key === step);
	const go = (offset: number) => setStep(SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, Math.max(0, index + offset))].key);
	const signUp = () => {
		window.location.href = startHref;
	};

	return (
		<div className="rounded-2xl border bg-card p-4 sm:p-6">
			<StepList step={step} done={{ plan: done }} onSelect={setStep} horizontal />
			<section className="mt-6 min-w-0">
				{step === "plan" ? (
					<Panel {...STEP_COPY.plan}>
						<PlanBoard repo={repo} plan={plan} status={done ? "done" : "planning"} />
						<StepNav onNext={() => go(1)} />
					</Panel>
				) : step === "team" ? (
					<Panel {...STEP_COPY.team}>
						<TeamPicker value={team} onChange={setTeam} plannerPick={plannerPick} squadSize={squadSize} onSquadSize={setSquadSize} />
						<StepNav onBack={() => go(-1)} onNext={() => go(1)} />
					</Panel>
				) : step === "budget" ? (
					<Panel {...STEP_COPY.budget}>
						<BudgetCard dailyUsd={dailyUsd} onChange={setDailyUsd} />
						<StepNav onBack={() => go(-1)} onNext={() => go(1)} />
					</Panel>
				) : step === "credits" ? (
					<Panel {...STEP_COPY.credits}>
						<CreditsCard cents={0} dailyUsd={dailyUsd} configured onDeposit={signUp} />
						<StepNav onBack={() => go(-1)} onNext={() => go(1)} />
					</Panel>
				) : step === "github" ? (
					<Panel {...STEP_COPY.github}>
						<GitHubCard repo={repo} installed={false} checking={false} onCheck={signUp} />
						<StepNav onBack={() => go(-1)} onNext={() => go(1)} />
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
						<a href={startHref} className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90">
							<Rocket className="size-4" /> Set up my swarm
						</a>
					</Panel>
				)}
			</section>
		</div>
	);
}
