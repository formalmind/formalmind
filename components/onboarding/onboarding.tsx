"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Rocket } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PlanBoard } from "@/components/landing/plan-board";
import { forgetLandingProgress, readDraft, usePlan } from "@/components/landing/use-plan";
import { projectPath, refreshProjects, useProjects } from "@/components/projects/use-projects";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { OnboardingState } from "@/server/routes/onboarding/state/route";
import { SWARM_MODES, TEAM_PRESETS } from "@/lib/teams";
import {
	BudgetCard,
	GitHubCard,
	ModePicker,
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

const EMPTY: OnboardingState = { repo: null, plan: null, mode: "specs", team: "pair", squadSize: 4, dailyUsd: 5, updatedAt: "" };

/** From a repository to a running swarm: plan, team, budget, GitHub App, start. */
export function Onboarding() {
	const [state, setState] = useState<OnboardingState>(EMPTY);
	const [loaded, setLoaded] = useState(false);
	const [step, setStep] = useState<StepKey>("plan");
	const [install, setInstall] = useState<{ installed: boolean; checking: boolean; error?: string }>({ installed: false, checking: false });
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const update = useCallback((patch: Partial<OnboardingState>) => {
		setState((prev) => {
			const next = { ...prev, ...patch };
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => {
				// A saved plan makes its repository a project, so the sidebar's folders are read again.
				void fetch("/api/onboarding/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).then(() => {
					if (next.repo && next.plan) refreshProjects();
				});
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

	// Checked as soon as the repository is known, so the step's check mark shows without visiting it first.
	useEffect(() => {
		if (loaded) void checkInstall(state.repo);
	}, [loaded, state.repo, checkInstall]);
	useEffect(() => {
		if (step === "github") void checkInstall(state.repo);
	}, [step, state.repo, checkInstall]);

	const projects = useProjects();
	const proofsRepo = projects?.find((p) => p.repo === state.repo)?.proofsRepo ?? null;
	const [init, setInit] = useState<{ busy: boolean; error?: string }>({ busy: false });
	const navigate = useNavigate();
	const initialise = async () => {
		if (!state.repo) return;
		setInit({ busy: true });
		const res = await fetch("/api/projects/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: state.repo, mode: state.mode }) }).catch(() => null);
		const body = (await res?.json().catch(() => null)) as { proofsRepo?: string; error?: string } | null;
		if (res?.ok && body?.proofsRepo) {
			setInit({ busy: false });
			refreshProjects();
			// Set up: straight into a new chat about the project, with the swarm a click away.
			navigate(projectPath(state.repo, "chat"));
		} else setInit({ busy: false, error: body?.error ?? "Couldn't reach the server; try again." });
	};

	// "+ New project" opens an empty box; a project's Setup link names its repository.
	const [params] = useSearchParams();
	const asked = params.get("repo");
	const boxRepo = params.get("new") === "1" && !planner.repo ? "" : asked ?? state.repo ?? "";
	// The saved plan belongs to state.repo; a different repository in the box starts from scratch.
	const planned = Boolean(state.plan) && boxRepo === state.repo;
	const done: Record<StepKey, boolean> = {
		plan: planned,
		mode: planned,
		team: planned,
		budget: planned,
		github: install.installed,
		start: planned && Boolean(proofsRepo),
	};
	const index = STEPS.findIndex((s) => s.key === step);
	const go = (offset: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + offset))].key);
	const plan = planner.plan ?? state.plan ?? undefined;

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
			<div className="flex items-center gap-3">
				<SidebarTrigger className="-ml-1" />
				<h1 className="text-sm font-semibold">Onboarding</h1>
				{boxRepo ? <span className="font-mono text-sm text-muted-foreground">{boxRepo}</span> : null}
			</div>

			<div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
				<StepList step={step} done={done} onSelect={setStep} />

				<section className="min-w-0 max-w-4xl">
					{!loaded ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading your setup…</div>
					) : step === "plan" ? (
						<Panel {...STEP_COPY.plan}>
							<RepoForm initial={boxRepo} busy={planner.isLoading} onPlan={planner.start} onContinue={state.plan && boxRepo === state.repo ? () => go(1) : undefined} />
							{planner.error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{planner.error}</p> : null}
							{planner.repo || (state.repo && boxRepo === state.repo) ? (
								<div className="mt-5">
									<PlanBoard repo={planner.repo ?? state.repo ?? ""} plan={plan} status={planner.isLoading ? "planning" : "done"} />
								</div>
							) : null}
							{state.repo && state.plan && boxRepo === state.repo && !planner.isLoading ? (
								<button type="button" onClick={() => planner.start(state.repo ?? "")} className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
									Plan this repository again
								</button>
							) : null}
						</Panel>
					) : step === "mode" ? (
						<Panel {...STEP_COPY.mode}>
							<ModePicker value={state.mode} onChange={(mode) => update({ mode })} />
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
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
									{ label: "Mode", value: SWARM_MODES.find((m) => m.key === state.mode)?.name ?? "", ok: true },
									{ label: "Team", value: `${TEAM_PRESETS.find((t) => t.key === state.team)?.name}${state.team === "squad" ? ` of ${state.squadSize}` : ""}`, ok: true },
									{ label: "Daily budget", value: `$${state.dailyUsd} a day`, ok: true },
									{ label: "GitHub App", value: install.installed ? "installed" : "not installed", ok: install.installed },
									{ label: "Proofs repository", value: proofsRepo ?? "not created", ok: Boolean(proofsRepo) },
								]}
							/>
							{proofsRepo ? (
								<>
								<p role="status" className="mt-6 flex items-center gap-2 text-sm">
									<Check className="size-4 shrink-0 text-green-600" />
									<span>
										<a href={`https://github.com/${proofsRepo}`} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-4">{proofsRepo}</a>{" "}
										{state.mode === "audit" ? "is auditing. No keys needed; the report is in audit/." : "is running. No keys needed."}
									</span>
								</p>
								<div className="mt-4 flex flex-wrap items-center gap-3">
									<Link to={projectPath(state.repo ?? "", "chat")} className="inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90">
										Chat about it
									</Link>
									<Link to={projectPath(state.repo ?? "")} className="inline-flex h-10 items-center rounded-full border px-5 text-sm hover:bg-muted">
										Watch the swarm
									</Link>
									{/* Links it again: the paying account and mode, then starts the swarm. Settings in the repository are kept. */}
									<button type="button" disabled={init.busy} onClick={() => void initialise()} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50">
										{init.busy ? "Linking…" : "Link again"}
									</button>
								</div>
								{init.error ? <p role="alert" className="mt-3 max-w-xl text-sm text-red-600 dark:text-red-400">{init.error}</p> : null}
								</>
							) : (
								<>
									<button
										type="button"
										disabled={!state.repo || !state.plan || !install.installed || init.busy}
										onClick={() => void initialise()}
										className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50"
									>
										{init.busy ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />}
										{init.busy ? `Creating ${state.repo}-proofs…` : "Create the proofs repository"}
									</button>
									{init.error ? <p role="alert" className="mt-3 max-w-xl text-sm text-red-600 dark:text-red-400">{init.error}</p> : null}
									<p className="mt-3 max-w-xl text-sm text-muted-foreground">
										{install.installed
											? `This creates ${state.repo}-proofs from the formalmind/lean-template Lean project and lists it for the swarm, which writes its proofs there.`
											: "Install the GitHub App first (the GitHub step); the proofs repository is created through it."}
									</p>
								</>
							)}
						</Panel>
					)}
				</section>
			</div>
		</div>
	);
}
