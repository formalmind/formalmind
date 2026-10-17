"use client";

import { useEffect, useRef, useState } from "react";
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
import { LANDING_KEEP_MS } from "./use-plan";

const SETUP_KEY = "fm-landing-setup";
type SavedSetup = { savedAt?: number; repo: string; step: StepKey; team: TeamPreset; squadSize: number; dailyUsd: number; chosen: { team?: boolean; budget?: boolean } };

function readSetup(repo: string): SavedSetup | null {
	try {
		const saved = JSON.parse(localStorage.getItem(SETUP_KEY) ?? "null") as SavedSetup | null;
		return saved?.repo === repo && Date.now() - (saved.savedAt ?? 0) <= LANDING_KEEP_MS ? saved : null;
	} catch {
		return null;
	}
}

function writeSetup(setup: SavedSetup) {
	try {
		localStorage.setItem(SETUP_KEY, JSON.stringify({ ...setup, savedAt: Date.now() }));
	} catch {
		// Storage refused (private window): the setup just won't be resumed.
	}
}

/**
 * The landing page's setup, picked up as soon as a repository is chosen: the live plan is step one, and the
 * rest are onboarding's own steps. Money and GitHub steps lead to sign-up.
 */
export function SetupPreview({ repo, plan, done, failed, startHref }: { repo: string; plan: PartialPlan | undefined; done: boolean; failed: boolean; startHref: string }) {
	// Where the visitor was and what they picked, kept per repository so leaving the site and coming back resumes it.
	const saved = readSetup(repo);
	const [step, setStep] = useState<StepKey>(saved?.step ?? "plan");
	const plannerPick = plan?.team?.preset ?? "pair";
	const [team, setTeam] = useState<TeamPreset>(saved?.team ?? plannerPick);
	const [squadSize, setSquadSize] = useState(saved?.squadSize ?? 4);
	const [dailyUsd, setDailyUsd] = useState(saved?.dailyUsd ?? 5);
	// A choice turns its step green: picking a team (or continuing past the planner's pick), setting a budget.
	const [chosen, setChosen] = useState<{ team?: boolean; budget?: boolean }>(saved?.chosen ?? {});
	useEffect(() => {
		writeSetup({ repo, step, team, squadSize, dailyUsd, chosen });
	}, [repo, step, team, squadSize, dailyUsd, chosen]);
	// A new repository starts over at its plan, with the planner's team suggestion.
	const firstRepo = useRef(repo);
	useEffect(() => {
		if (firstRepo.current === repo) return;
		firstRepo.current = repo;
		setStep("plan");
		setChosen({});
	}, [repo]);
	// The planner's pick fills in the team until the visitor chooses one.
	useEffect(() => {
		if (!chosen.team) setTeam(plannerPick);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [plannerPick]);
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
