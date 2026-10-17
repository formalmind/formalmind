"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Rocket } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PlanBoard } from "@/components/landing/plan-board";
import { forgetLandingProgress, readDraft, usePlan } from "@/components/landing/use-plan";
import type { OnboardingState } from "@/server/routes/onboarding/state/route";
import { TEAM_PRESETS } from "@/lib/teams";
import {
	BudgetCard,
	CreditsCard,
	GitHubCard,
	Panel,
	RepoForm,
	SETUP_STEPS as STEPS,
	STEP_COPY,
	SetupSummary,
	StepList,
	StepNav as Nav,
	TeamPicker,
	type StepKey,
} from "./steps";

type Credits = { configured: boolean; cents: number; entries: { at: string; cents: number; ref: string }[]; error?: string };

const EMPTY: OnboardingState = { repo: null, plan: null, team: "pair", squadSize: 4, dailyUsd: 5, updatedAt: "" };

/** From a repository to a running swarm: plan, team, budget, credits, GitHub App, start. */
export function Onboarding() {
	const [state, setState] = useState<OnboardingState>(EMPTY);
	const [loaded, setLoaded] = useState(false);
	const [step, setStep] = useState<StepKey>("plan");
	const [credits, setCredits] = useState<Credits | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [install, setInstall] = useState<{ installed: boolean; checking: boolean; error?: string }>({ installed: false, checking: false });
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const update = useCallback((patch: Partial<OnboardingState>) => {
		setState((prev) => {
			const next = { ...prev, ...patch };
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => {
				void fetch("/api/onboarding/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
			}, 500);
			return next;
		});
	}, []);

	const planner = usePlan((draft) => update({ repo: draft.repo, plan: draft.plan, team: draft.plan.team.preset }));

	// Saved progress first; a fresh landing-page draft fills in what is missing.
	useEffect(() => {
		void (async () => {
			const saved = (await fetch("/api/onboarding/state").then((r) => (r.ok ? r.json() : null)).catch(() => null)) as OnboardingState | null;
			const draft = readDraft();
			const merged: OnboardingState = { ...EMPTY, ...(saved ?? {}) };
			if (draft && (!merged.plan || draft.repo !== merged.repo)) {
				Object.assign(merged, { repo: draft.repo, plan: draft.plan, team: saved?.plan ? merged.team : draft.plan.team.preset });
				update(merged);
			} else {
				setState(merged);
			}
			// Signed in, the account holds the progress now: the landing page goes back to its demo.
			if (draft) forgetLandingProgress();
			setLoaded(true);
		})();
	}, [update]);

	// Back from Stripe Checkout: confirm the payment and land on the credits step.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const outcome = params.get("checkout");
		const sessionId = params.get("session_id");
		void fetch(`/api/billing/balance${outcome === "success" && sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`)
			.then((r) => r.json())
			.then((body: Credits) => setCredits(body))
			.catch(() => setCredits({ configured: false, cents: 0, entries: [], error: "Couldn't load your credits." }));
		if (outcome) {
			setStep("credits");
			setNotice(outcome === "success" ? "Payment received. Thanks!" : "Checkout was cancelled; nothing was charged.");
			window.history.replaceState(null, "", "/onboarding");
		}
	}, []);

	const checkInstall = useCallback(async (repo: string | null) => {
		if (!repo) return;
		setInstall((s) => ({ ...s, checking: true }));
		// A check that fails just leaves the install option up; there is nothing for the visitor to fix.
		const body = await fetch(`/api/onboarding/install?repo=${encodeURIComponent(repo)}`).then((r) => r.json()).catch(() => ({ installed: false }));
		const installed = Boolean(body.installed);
		setInstall({ installed, checking: false });
		// Already installed: nothing to do on this step, so move on.
		if (installed) setStep((current) => (current === "github" ? "start" : current));
	}, []);

	useEffect(() => {
		if (step === "github" || step === "start") void checkInstall(state.repo);
	}, [step, state.repo, checkInstall]);

	const deposit = async (usd: number) => {
		setNotice(null);
		const res = await fetch("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usd }) });
		const body = await res.json();
		if (body.url) window.location.href = body.url;
		else setNotice(body.error ?? "Checkout didn't start.");
	};

	const done: Record<StepKey, boolean> = {
		plan: Boolean(state.plan),
		team: Boolean(state.plan),
		budget: Boolean(state.plan),
		credits: (credits?.cents ?? 0) > 0,
		github: install.installed,
		start: false,
	};
	const index = STEPS.findIndex((s) => s.key === step);
	const go = (offset: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + offset))].key);
	const plan = planner.plan ?? state.plan ?? undefined;

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
			<div className="flex items-center gap-3">
				<SidebarTrigger className="-ml-1" />
				<h1 className="text-base font-semibold">Set up your swarm</h1>
				{state.repo ? <span className="font-mono text-sm text-muted-foreground">{state.repo}</span> : null}
			</div>

			<div className="mt-6 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
				<StepList step={step} done={done} onSelect={setStep} />

				<section className="min-w-0 max-w-4xl">
					{!loaded ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading your setup…</div>
					) : step === "plan" ? (
						<Panel {...STEP_COPY.plan}>
							<RepoForm initial={state.repo ?? ""} busy={planner.isLoading} onPlan={planner.start} />
							{planner.error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{planner.error}</p> : null}
							{planner.repo || state.repo ? (
								<div className="mt-5">
									<PlanBoard repo={planner.repo ?? state.repo ?? ""} plan={plan} status={planner.isLoading ? "planning" : "done"} />
								</div>
							) : null}
							<Nav onNext={() => go(1)} nextDisabled={!state.plan} />
						</Panel>
					) : step === "team" ? (
						<Panel {...STEP_COPY.team}>
							<TeamPicker
								value={state.team}
								onChange={(team) => update({ team })}
								plannerPick={state.plan?.team.preset}
								squadSize={state.squadSize}
								onSquadSize={(squadSize) => update({ squadSize })}
							/>
							{state.plan?.team.why ? <p className="mt-4 text-sm text-muted-foreground">Planner: {state.plan.team.why}</p> : null}
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : step === "budget" ? (
						<Panel {...STEP_COPY.budget}>
							<BudgetCard dailyUsd={state.dailyUsd} onChange={(dailyUsd) => update({ dailyUsd })} />
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : step === "credits" ? (
						<Panel {...STEP_COPY.credits}>
							{notice ? <p role="status" className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{notice}</p> : null}
							<CreditsCard
								cents={credits ? credits.cents : null}
								dailyUsd={state.dailyUsd}
								configured={credits?.configured !== false}
								entries={credits?.entries}
								onDeposit={(usd) => void deposit(usd)}
							/>
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : step === "github" ? (
						<Panel {...STEP_COPY.github}>
							<GitHubCard repo={state.repo} installed={install.installed} checking={install.checking} onCheck={() => void checkInstall(state.repo)} />
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : (
						<Panel {...STEP_COPY.start}>
							<SetupSummary
								rows={[
									{ label: "Repository", value: state.repo ?? "not chosen", ok: Boolean(state.repo) },
									{ label: "Plan", value: state.plan ? `${state.plan.issues.length} issues, ${state.plan.invariants.length} invariants` : "not planned", ok: Boolean(state.plan) },
									{ label: "Team", value: `${TEAM_PRESETS.find((t) => t.key === state.team)?.name}${state.team === "squad" ? ` of ${state.squadSize}` : ""}`, ok: true },
									{ label: "Daily budget", value: `$${state.dailyUsd} a day`, ok: true },
									{ label: "Credits", value: credits ? `$${(credits.cents / 100).toFixed(2)}` : "…", ok: (credits?.cents ?? 0) > 0 },
									{ label: "GitHub App", value: install.installed ? "installed" : "not installed", ok: install.installed },
								]}
							/>
							<button type="button" disabled className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground opacity-50">
								<Rocket className="size-4" /> Start the swarm
							</button>
							<p className="mt-3 max-w-xl text-sm text-muted-foreground">
								Starting is the last piece we&apos;re building: it commits the swarm&apos;s workflows to your repository, opens the plan&apos;s issues, and meters the agents&apos; model usage against your credits. Your setup is saved, so it&apos;ll be one click from here.
							</p>
						</Panel>
					)}
				</section>
			</div>
		</div>
	);
}
