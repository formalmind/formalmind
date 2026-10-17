"use client";

import { MarkGithubIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDollarSign, Loader2, Map as MapIcon, Rocket, Users } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PlanBoard } from "@/components/landing/plan-board";
import { readDraft, usePlan } from "@/components/landing/use-plan";
import type { OnboardingState } from "@/app/api/onboarding/state/route";
import { DEPOSITS_USD } from "@/lib/billing-plans";
import { TEAM_PRESETS } from "@/lib/teams";

const APP_INSTALL_URL = "https://github.com/apps/formalmind/installations/new";
/** What one run of each costs at most, from the swarm workflow's per-run caps. */
const RUN_CAPS = { prove: 3, review: 1 };

type StepKey = "plan" | "team" | "budget" | "credits" | "github" | "start";
const STEPS: { key: StepKey; title: string; icon: React.ElementType }[] = [
	{ key: "plan", title: "Your plan", icon: MapIcon },
	{ key: "team", title: "Team", icon: Users },
	{ key: "budget", title: "Daily budget", icon: CircleDollarSign },
	{ key: "credits", title: "Credits", icon: CircleDollarSign },
	{ key: "github", title: "GitHub", icon: MarkGithubIcon },
	{ key: "start", title: "Start", icon: Rocket },
];

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
		const body = await fetch(`/api/onboarding/install?repo=${encodeURIComponent(repo)}`).then((r) => r.json()).catch(() => ({ installed: false, error: "Couldn't check just now." }));
		setInstall({ installed: Boolean(body.installed), checking: false, error: body.error });
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
				<nav aria-label="Setup steps">
					<ol className="flex gap-1 overflow-x-auto lg:flex-col">
						{STEPS.map((s, i) => (
							<li key={s.key}>
								<button
									type="button"
									onClick={() => setStep(s.key)}
									aria-current={step === s.key ? "step" : undefined}
									className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors ${step === s.key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
								>
									<span className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] tabular-nums ${done[s.key] ? "border-emerald-500 bg-emerald-500 text-white" : ""}`}>
										{done[s.key] ? <Check className="size-3" /> : i + 1}
									</span>
									{s.title}
								</button>
							</li>
						))}
					</ol>
				</nav>

				<section className="min-w-0 max-w-4xl">
					{!loaded ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading your setup…</div>
					) : step === "plan" ? (
						<Panel title="Your plan" lead="The planner's first pass on your repository. You can re-plan it, or plan a different repository.">
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
						<Panel title="How many agents?" lead="The protocol is the same for every team size. More agents work disjoint issues in parallel; the planner and the chief are on call in every team.">
							<div className="grid gap-3 sm:grid-cols-2">
								{TEAM_PRESETS.map((team) => (
									<button
										key={team.key}
										type="button"
										onClick={() => update({ team: team.key })}
										aria-pressed={state.team === team.key}
										className={`rounded-xl border p-4 text-left transition-colors ${state.team === team.key ? "border-foreground/40 bg-muted/60 ring-1 ring-foreground/20" : "hover:bg-muted/40"}`}
									>
										<span className="flex items-center justify-between text-sm font-medium">
											{team.name}
											<span className="text-xs font-normal text-muted-foreground">{team.agents}</span>
										</span>
										<span className="mt-2 block text-sm leading-6 text-muted-foreground">{team.split}</span>
										<span className="mt-2 flex flex-wrap gap-1.5 text-xs">
											<span>{team.bestFor}</span>
											{state.plan?.team.preset === team.key ? <span className="rounded-full bg-violet-500/15 px-2 text-violet-700 dark:text-violet-300">planner&apos;s pick</span> : null}
										</span>
									</button>
								))}
							</div>
							{state.team === "squad" ? (
								<label className="mt-4 flex items-center gap-3 text-sm">
									Agents at once
									<input type="range" min={4} max={7} value={state.squadSize} onChange={(e) => update({ squadSize: Number(e.target.value) })} className="w-40" />
									<span className="tabular-nums">{state.squadSize}</span>
								</label>
							) : null}
							{state.plan?.team.why ? <p className="mt-4 text-sm text-muted-foreground">Planner: {state.plan.team.why}</p> : null}
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : step === "budget" ? (
						<Panel title="Daily budget" lead="The swarm only starts a run when the run's whole cap fits in what is left today, and pauses until tomorrow when it is spent.">
							<div className="rounded-xl border p-5">
								<div className="flex items-baseline justify-between">
									<span className="text-3xl font-semibold tabular-nums">${state.dailyUsd}</span>
									<span className="text-sm text-muted-foreground">a day · at most ${state.dailyUsd * 30} a month</span>
								</div>
								<input type="range" min={2} max={50} step={1} value={state.dailyUsd} onChange={(e) => update({ dailyUsd: Number(e.target.value) })} className="mt-4 w-full" aria-label="Daily budget in dollars" />
								<p className="mt-4 text-sm leading-6 text-muted-foreground">
									Room for about {Math.floor(state.dailyUsd / RUN_CAPS.prove)} proving run{Math.floor(state.dailyUsd / RUN_CAPS.prove) === 1 ? "" : "s"} (up to ${RUN_CAPS.prove} each) or{" "}
									{Math.floor(state.dailyUsd / RUN_CAPS.review)} reviews (up to ${RUN_CAPS.review}) a day. Most runs cost less than their cap.
								</p>
							</div>
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : step === "credits" ? (
						<Panel title="Credits" lead="Model usage is paid from prepaid credits. Your daily budget decides how fast they are spent.">
							{notice ? <p role="status" className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{notice}</p> : null}
							<div className="rounded-xl border p-5">
								<p className="text-sm text-muted-foreground">Balance</p>
								<p className="mt-1 text-3xl font-semibold tabular-nums">{credits ? `$${(credits.cents / 100).toFixed(2)}` : "…"}</p>
								{credits && credits.cents > 0 ? (
									<p className="mt-1 text-sm text-muted-foreground">About {Math.floor(credits.cents / 100 / state.dailyUsd)} days at ${state.dailyUsd} a day.</p>
								) : null}
								{credits?.configured === false ? (
									<p className="mt-4 text-sm text-muted-foreground">Payments aren&apos;t connected yet.</p>
								) : (
									<div className="mt-5 flex flex-wrap gap-2">
										{DEPOSITS_USD.map((usd) => (
											<button key={usd} type="button" onClick={() => void deposit(usd)} className="inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium transition-colors hover:bg-muted">
												Add ${usd}
											</button>
										))}
									</div>
								)}
								{credits?.entries.length ? (
									<ul className="mt-5 divide-y border-t text-sm">
										{credits.entries.slice(0, 5).map((e) => (
											<li key={e.ref} className="flex justify-between py-2 text-muted-foreground">
												<span>Deposit · {new Date(e.at).toLocaleDateString()}</span>
												<span className="tabular-nums text-foreground">+${(e.cents / 100).toFixed(2)}</span>
											</li>
										))}
									</ul>
								) : null}
							</div>
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : step === "github" ? (
						<Panel title="Install the GitHub App" lead="The formalmind App is how the swarm works in your repository: it opens issues and pull requests, labels them, and runs its workflows there.">
							<div className="flex flex-wrap items-center gap-3 rounded-xl border p-5">
								{install.installed ? (
									<p className="flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-600" /> Installed on <span className="font-mono">{state.repo}</span></p>
								) : (
									<>
										<a href={APP_INSTALL_URL} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
											<MarkGithubIcon size={16} /> Install on GitHub
										</a>
										<button type="button" onClick={() => void checkInstall(state.repo)} className="inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm hover:bg-muted">
											{install.checking ? <Loader2 className="size-4 animate-spin" /> : null} I&apos;ve installed it
										</button>
										<p className="w-full text-sm text-muted-foreground">
											Give it access to <span className="font-mono text-foreground">{state.repo ?? "your repository"}</span>.
											{install.error ? ` ${install.error}` : ""}
										</p>
									</>
								)}
							</div>
							<Nav onBack={() => go(-1)} onNext={() => go(1)} />
						</Panel>
					) : (
						<Panel title="Start the swarm" lead="Everything the swarm needs, in one place.">
							<ul className="divide-y rounded-xl border text-sm">
								<Summary label="Repository" value={state.repo ?? "not chosen"} ok={Boolean(state.repo)} />
								<Summary label="Plan" value={state.plan ? `${state.plan.issues.length} issues, ${state.plan.invariants.length} invariants` : "not planned"} ok={Boolean(state.plan)} />
								<Summary label="Team" value={`${TEAM_PRESETS.find((t) => t.key === state.team)?.name}${state.team === "squad" ? ` of ${state.squadSize}` : ""}`} ok />
								<Summary label="Daily budget" value={`$${state.dailyUsd} a day`} ok />
								<Summary label="Credits" value={credits ? `$${(credits.cents / 100).toFixed(2)}` : "…"} ok={(credits?.cents ?? 0) > 0} />
								<Summary label="GitHub App" value={install.installed ? "installed" : "not installed"} ok={install.installed} />
							</ul>
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

function Panel({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
	return (
		<div>
			<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
			<p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{lead}</p>
			<div className="mt-5">{children}</div>
		</div>
	);
}

function Nav({ onBack, onNext, nextDisabled }: { onBack?: () => void; onNext?: () => void; nextDisabled?: boolean }) {
	return (
		<div className="mt-6 flex gap-2">
			{onBack ? <button type="button" onClick={onBack} className="h-9 rounded-full border px-4 text-sm hover:bg-muted">Back</button> : null}
			{onNext ? <button type="button" onClick={onNext} disabled={nextDisabled} className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Continue</button> : null}
		</div>
	);
}

function Summary({ label, value, ok }: { label: string; value: string; ok: boolean }) {
	return (
		<li className="flex items-center justify-between gap-3 px-4 py-3">
			<span className="text-muted-foreground">{label}</span>
			<span className="flex items-center gap-2 font-medium">
				{value}
				{ok ? <Check className="size-4 text-emerald-600" /> : <span className="size-2 rounded-full bg-amber-500" aria-label="needs attention" />}
			</span>
		</li>
	);
}

function RepoForm({ initial, busy, onPlan }: { initial: string; busy: boolean; onPlan: (repo: string) => void }) {
	const [value, setValue] = useState(initial);
	useEffect(() => setValue(initial), [initial]);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onPlan(value);
			}}
			className="flex max-w-xl items-center gap-2 rounded-full border bg-background p-1.5 pl-4 focus-within:ring-2 focus-within:ring-ring"
		>
			<MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" />
			<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="github.com/owner/repo" aria-label="GitHub repository" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
			<button type="submit" disabled={busy || !value.trim()} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
				{busy ? <Loader2 className="size-4 animate-spin" /> : null}
				{initial ? "Re-plan" : "Plan it"}
			</button>
		</form>
	);
}
