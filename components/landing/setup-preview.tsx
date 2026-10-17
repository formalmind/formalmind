"use client";

import { useState } from "react";
import { Eye, Rocket } from "lucide-react";
import { TEAM_PRESETS, type TeamPreset } from "@/lib/teams";
import {
	BudgetCard,
	CreditsCard,
	GitHubCard,
	Panel,
	RepoForm,
	SETUP_STEPS,
	STEP_COPY,
	SetupSummary,
	StepList,
	StepNav,
	TeamPicker,
	type StepKey,
} from "@/components/onboarding/steps";

const SAMPLE_REPO = "Uniswap/v4-core";

/**
 * A sneak peek of onboarding, built from the same step components, with sample values.
 * Planning here runs the landing page's live planner; money and GitHub steps lead to sign-up.
 */
export function SetupPreview({ onPlan, startHref, busy }: { onPlan: (repo: string) => void; startHref: string; busy: boolean }) {
	const [step, setStep] = useState<StepKey>("plan");
	const [team, setTeam] = useState<TeamPreset>("pair");
	const [squadSize, setSquadSize] = useState(4);
	const [dailyUsd, setDailyUsd] = useState(5);
	const index = SETUP_STEPS.findIndex((s) => s.key === step);
	const go = (offset: number) => setStep(SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, Math.max(0, index + offset))].key);
	const signUp = () => {
		window.location.href = startHref;
	};

	return (
		<div className="rounded-2xl border bg-card p-4 sm:p-6">
			<p className="mb-5 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
				<Eye className="size-3.5" /> Preview of setup · sample values
			</p>
			<div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
				<StepList step={step} done={{}} onSelect={setStep} />
				<section className="min-w-0">
					{step === "plan" ? (
						<Panel {...STEP_COPY.plan}>
							<RepoForm initial={SAMPLE_REPO} busy={busy} onPlan={onPlan} cta="Plan it" />
							<p className="mt-3 text-sm text-muted-foreground">Planning runs live at the top of this page: issues, invariants, and the team the planner suggests.</p>
							<StepNav onNext={() => go(1)} />
						</Panel>
					) : step === "team" ? (
						<Panel {...STEP_COPY.team}>
							<TeamPicker value={team} onChange={setTeam} plannerPick="pair" squadSize={squadSize} onSquadSize={setSquadSize} />
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
							<GitHubCard repo={SAMPLE_REPO} installed={false} checking={false} onCheck={signUp} />
							<StepNav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : (
						<Panel {...STEP_COPY.start}>
							<SetupSummary
								rows={[
									{ label: "Repository", value: SAMPLE_REPO, ok: true },
									{ label: "Plan", value: "from the planner", ok: true },
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
		</div>
	);
}
