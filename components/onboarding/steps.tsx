"use client";

import { MarkGithubIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { Check, CircleDollarSign, Loader2, Map as MapIcon, Rocket, ScanSearch, Users } from "lucide-react";
import { SWARM_MODES, TEAM_PRESETS, type SwarmMode, type TeamPreset } from "@/lib/teams";

/**
 * The setup steps' building blocks, shared by the onboarding flow and the landing page's
 * preview of it, so the preview always looks exactly like what a new user will do.
 */

export const APP_INSTALL_URL = "https://github.com/apps/formalmind/installations/new";
/** What one run of each costs at most, from the swarm workflow's per-run caps. */
export const RUN_CAPS = { prove: 3, review: 1 };

export type StepKey = "plan" | "mode" | "team" | "budget" | "github" | "start";
export const SETUP_STEPS: { key: StepKey; title: string; icon: React.ElementType }[] = [
	{ key: "plan", title: "Your plan", icon: MapIcon },
	{ key: "mode", title: "Mode", icon: ScanSearch },
	{ key: "team", title: "Team", icon: Users },
	{ key: "budget", title: "Daily budget", icon: CircleDollarSign },
	{ key: "github", title: "GitHub", icon: MarkGithubIcon },
	{ key: "start", title: "Start", icon: Rocket },
];

/** A column beside the step from lg up; `horizontal` keeps it a row above the step at every width. */
export function StepList({ step, done, onSelect, horizontal = false }: { step: StepKey; done: Partial<Record<StepKey, boolean>>; onSelect: (key: StepKey) => void; horizontal?: boolean }) {
	return (
		<nav aria-label="Setup steps">
			<ol className={`flex flex-wrap gap-1 ${horizontal ? "" : "lg:flex-col lg:flex-nowrap"}`}>
				{SETUP_STEPS.map((s, i) => (
					<li key={s.key}>
						<button
							type="button"
							onClick={() => onSelect(s.key)}
							aria-current={step === s.key ? "step" : undefined}
							className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors ${step === s.key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
						>
							<span className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-sm tabular-nums ${done[s.key] ? "border-emerald-500 bg-emerald-500 text-white" : ""}`}>
								{done[s.key] ? <Check className="size-3" /> : i + 1}
							</span>
							{s.title}
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
}

export function Panel({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
	return (
		<div>
			<h2 className="text-sm font-semibold tracking-tight">{title}</h2>
			<p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{lead}</p>
			<div className="mt-5">{children}</div>
		</div>
	);
}

export function StepNav({ onBack, onNext, nextDisabled, nextLabel = "Continue" }: { onBack?: () => void; onNext?: () => void; nextDisabled?: boolean; nextLabel?: string }) {
	return (
		<div className="mt-6 flex gap-2">
			{onBack ? <button type="button" onClick={onBack} className="h-9 rounded-full border px-4 text-sm hover:bg-muted">Back</button> : null}
			{onNext ? <button type="button" onClick={onNext} disabled={nextDisabled} className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{nextLabel}</button> : null}
		</div>
	);
}

/**
 * The repository box. Once `initial` has a plan, `onContinue` makes the button move forward for that
 * repository (planning it again is a separate, quieter action); typing another repository plans that one.
 */
export function RepoForm({ initial, busy, onPlan, onContinue, cta }: { initial: string; busy: boolean; onPlan: (repo: string) => void; onContinue?: () => void; cta?: string }) {
	const [value, setValue] = useState(initial);
	useEffect(() => setValue(initial), [initial]);
	const continues = Boolean(onContinue && initial && value.trim() === initial);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (continues) onContinue?.();
				else onPlan(value);
			}}
			className="flex max-w-xl items-center gap-2 rounded-full border bg-background p-1.5 pl-4 focus-within:ring-2 focus-within:ring-ring"
		>
			<MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" />
			<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="github.com/owner/repo" aria-label="GitHub repository" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
			<button type="submit" disabled={busy || !value.trim()} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
				{busy ? <Loader2 className="size-4 animate-spin" /> : null}
				{cta ?? (continues ? "Continue" : "Plan it")}
			</button>
		</form>
	);
}

/** Audit a commit, or build specs that keep up with the code. */
export function ModePicker({ value, onChange }: { value: SwarmMode; onChange: (mode: SwarmMode) => void }) {
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			{SWARM_MODES.map((mode) => (
				<button
					key={mode.key}
					type="button"
					onClick={() => onChange(mode.key)}
					aria-pressed={value === mode.key}
					className={`rounded-xl border p-4 text-left transition-colors ${value === mode.key ? "border-foreground/40 bg-muted/60 ring-1 ring-foreground/20" : "hover:bg-muted/40"}`}
				>
					<span className="block text-sm font-medium">{mode.name}</span>
					<span className="mt-2 block text-sm leading-6 text-muted-foreground">{mode.lead}</span>
					<span className="mt-2 block text-sm">{mode.ends}</span>
				</button>
			))}
		</div>
	);
}

export function TeamPicker({
	value,
	onChange,
	plannerPick,
	squadSize,
	onSquadSize,
}: {
	value: TeamPreset;
	onChange: (team: TeamPreset) => void;
	plannerPick?: TeamPreset;
	squadSize: number;
	onSquadSize: (size: number) => void;
}) {
	return (
		<>
			<div className="grid gap-3 sm:grid-cols-2">
				{TEAM_PRESETS.map((team) => (
					<button
						key={team.key}
						type="button"
						onClick={() => onChange(team.key)}
						aria-pressed={value === team.key}
						className={`rounded-xl border p-4 text-left transition-colors ${value === team.key ? "border-foreground/40 bg-muted/60 ring-1 ring-foreground/20" : "hover:bg-muted/40"}`}
					>
						<span className="flex items-center justify-between text-sm font-medium">
							{team.name}
							<span className="text-sm font-normal text-muted-foreground">{team.agents}</span>
						</span>
						<span className="mt-2 block text-sm leading-6 text-muted-foreground">{team.split}</span>
						<span className="mt-2 flex flex-wrap gap-1.5 text-sm">
							<span>{team.bestFor}</span>
							{plannerPick === team.key ? <span className="rounded-full bg-violet-500/15 px-2 text-violet-700 dark:text-violet-300">planner&apos;s pick</span> : null}
						</span>
					</button>
				))}
			</div>
			{value === "squad" ? (
				<label className="mt-4 flex items-center gap-3 text-sm">
					Agents at once
					<input type="range" min={4} max={7} value={squadSize} onChange={(e) => onSquadSize(Number(e.target.value))} className="w-40" />
					<span className="tabular-nums">{squadSize}</span>
				</label>
			) : null}
		</>
	);
}

export function BudgetCard({ dailyUsd, onChange }: { dailyUsd: number; onChange: (usd: number) => void }) {
	const proves = Math.floor(dailyUsd / RUN_CAPS.prove);
	return (
		<div className="rounded-xl border p-5">
			<div className="flex items-baseline justify-between">
				<span className="text-sm font-semibold tabular-nums">${dailyUsd}</span>
				<span className="text-sm text-muted-foreground">a day · at most ${dailyUsd * 30} a month</span>
			</div>
			<input type="range" min={2} max={50} step={1} value={dailyUsd} onChange={(e) => onChange(Number(e.target.value))} className="mt-4 w-full" aria-label="Daily budget in dollars" />
			<p className="mt-4 text-sm leading-6 text-muted-foreground">
				Room for about {proves} proving run{proves === 1 ? "" : "s"} (up to ${RUN_CAPS.prove} each) or{" "}
				{Math.floor(dailyUsd / RUN_CAPS.review)} reviews (up to ${RUN_CAPS.review}) a day. Most runs cost less than their cap.
			</p>
		</div>
	);
}

export function GitHubCard({ repo, installed, checking, error, onCheck }: { repo: string | null; installed: boolean; checking: boolean; error?: string; onCheck: () => void }) {
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-xl border p-5">
			{installed ? (
				<p className="flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-600" /> Installed on <span className="font-mono">{repo}</span></p>
			) : (
				<>
					<a href={APP_INSTALL_URL} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
						<MarkGithubIcon size={16} /> Install on GitHub
					</a>
					<button type="button" onClick={onCheck} className="inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm hover:bg-muted">
						{checking ? <Loader2 className="size-4 animate-spin" /> : null} I&apos;ve installed it
					</button>
					<p className="w-full text-sm text-muted-foreground">
						Give it access to <span className="font-mono text-foreground">{repo ?? "your repository"}</span>.
						{error ? ` ${error}` : ""}
					</p>
				</>
			)}
		</div>
	);
}

export function SetupSummary({ rows }: { rows: { label: string; value: string; ok: boolean }[] }) {
	return (
		<ul className="divide-y rounded-xl border text-sm">
			{rows.map((row) => (
				<li key={row.label} className="flex items-center justify-between gap-3 px-4 py-3">
					<span className="text-muted-foreground">{row.label}</span>
					<span className="flex items-center gap-2 font-medium">
						{row.value}
						{row.ok ? <Check className="size-4 text-emerald-600" /> : <span className="size-2 rounded-full bg-amber-500" aria-label="needs attention" />}
					</span>
				</li>
			))}
		</ul>
	);
}

/** The copy each step opens with, so the onboarding and its landing preview read the same. */
export const STEP_COPY: Record<StepKey, { title: string; lead: string }> = {
	plan: { title: "Your plan", lead: "The planner's first pass on your repository. Continue with it, or enter a different repository to plan that one." },
	mode: { title: "Audit or specs?", lead: "Audit a commit and get one report, or have the swarm build and keep formal specs for your protocol. You can keep building specs after an audit." },
	team: { title: "How many agents?", lead: "The protocol is the same for every team size. More agents work disjoint issues in parallel; the planner and the chief are on call in every team." },
	budget: { title: "Daily budget", lead: "The swarm only starts a run when the run's whole cap fits in what is left today, and pauses until tomorrow when it is spent." },
	github: { title: "Install the GitHub App", lead: "The formalmind App is how the swarm works in your repository: it opens issues and pull requests, labels them, and runs its workflows there." },
	start: { title: "Start the swarm", lead: "Everything the swarm needs, in one place." },
};
