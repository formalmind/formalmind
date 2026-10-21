import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MarkGithubIcon } from "@primer/octicons-react";
import { ChevronRight, Laptop, Plus } from "lucide-react";
import { AddProjectCard } from "@/components/add-project";
import { HomeEmpty } from "@/components/home-empty";
import { APP_INSTALL_URL } from "@/components/onboarding/steps";
import { projectPath, useProjects } from "@/components/projects/use-projects";
import type { SessionData } from "@/lib/session";
import type { Formal } from "@/desktop/src/swarm-panel";
import { macOnline, setStartBudget, startBudget, useMac } from "./relay";
import { rememberProject } from "./tabs";
import { SwarmShowcase } from "./showcase";
import { Skeleton } from "./bar";
import { useSwipe } from "./swipe";
import { TheoremCard } from "./proofs";
import formal from "./fixtures/formal-asyncswap.json";

const KEY = "fm:mobile-setup";

/** Whether this phone finished setup after signing in (Settings can run it again). */
export const setUpDone = () => {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return true;
	}
};

export const setSetUpDone = (on: boolean) => {
	try {
		if (on) localStorage.setItem(KEY, "1");
		else localStorage.removeItem(KEY);
	} catch {
		/* asked again next launch */
	}
};

const primary = "w-full rounded-full bg-white px-4 py-3 text-[15px] font-medium text-neutral-950 active:bg-neutral-100 disabled:opacity-50";
const quiet = "w-full py-2 text-[15px] text-white/50";
const card = "rounded-2xl border border-white/10 bg-white/[0.05]";

/**
 * An issue as the GitHub app files it, laid out as ItemPreview draws one: the bot that opened it is real, the rest is
 * skeleton (whatever your project's spec turns out to be).
 */
function BotIssueCard() {
	return (
		<div className={`dark fm-skeleton-strong ${card} p-4 text-foreground`}>
			<div className="flex items-center gap-1.5">
				<Skeleton className="h-3 w-16" />
				<Skeleton className="h-3 w-32" />
			</div>
			<Skeleton className="mt-3 h-4 w-[92%]" />
			<Skeleton className="mt-1.5 h-4 w-[64%]" />
			<Skeleton className="mt-4 h-[52px] w-full" />
			<Skeleton className="mt-4 h-4 w-24 rounded" />
			<div className="mt-3 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
				<img src="https://avatars.githubusercontent.com/in/1319020?v=4&s=40" alt="" className="size-4 rounded-full" />
				<span className="font-medium text-foreground">formalmind[bot]</span>
				<span>opened</span>
			</div>
		</div>
	);
}

/** sweep: anyone but the owner reverts with NotOwner (formal-ast's real output for AsyncSwap, ./fixtures). */
const THEOREM = (formal as unknown as Formal).theorems.find((t) => t.name === "sweep_notOwner") ?? (formal as unknown as Formal).theorems[0];

function Frame({ step, total, onSkip, onBack, children }: { step: number; total: number; onSkip?: () => void; onBack?: () => void; children: React.ReactNode }) {
	const swipe = useSwipe((dir) => dir === "right" && onBack?.());
	return (
		<main
			// A swipe to the right goes back a step, as in the introduction.
			{...swipe}
			className="fm-safe-top fm-safe-bottom relative flex min-h-dvh flex-col overflow-x-hidden bg-[radial-gradient(ellipse_at_top,#151a24_0%,#08090b_60%)] px-6 pb-8 text-white">
			<div className="flex h-12 items-center gap-3">
				{/* The introduction's dots: the current step drawn long. */}
				<div className="flex flex-1 gap-1.5" aria-label={`Step ${step + 1} of ${total}`}>
					{Array.from({ length: total }, (_, i) => (
						<span key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? "w-6 bg-white" : "w-1.5 bg-white/25"}`} />
					))}
				</div>
				{onSkip ? (
					<button type="button" onClick={onSkip} className="px-2 text-[15px] text-white/50">
						Skip
					</button>
				) : null}
			</div>
			<div key={step} className="flex flex-1 flex-col">
				{children}
			</div>
		</main>
	);
}

function Headline({ muted, strong, body }: { muted: string; strong: string; body?: React.ReactNode }) {
	return (
		<>
			<h1 className="fm-rise font-display text-[42px] leading-[1.05] [animation-delay:60ms]">
				<span className="text-white/45">{muted}</span>
				<br />
				{strong}
			</h1>
			{body ? <p className="fm-rise mt-4 text-[15px] leading-6 text-white/60 [animation-delay:120ms]">{body}</p> : null}
		</>
	);
}

const BUDGETS = [2, 5, 10, 20, 50];

/**
 * Setup after signing in: welcome, what the swarm does, what coverage means (0 to 100), specs written on GitHub as the
 * project changes, a budget to start verifying with, and the first project. Ends on Home.
 */
export function Setup({ user, onDone }: { user: SessionData["user"]; onDone: () => void }) {
	const [step, setStep] = useState(0);
	const [budget, setBudget] = useState(() => startBudget() ?? 5);
	const [adding, setAdding] = useState(false);
	const projects = useProjects();
	const navigate = useNavigate();
	const mac = useMac();
	const total = 6;
	const next = () => setStep((s) => Math.min(total - 1, s + 1));
	const finish = (repo?: string) => {
		setSetUpDone(true);
		onDone();
		if (repo) {
			rememberProject(repo);
			navigate(projectPath(repo));
		} else navigate("/");
	};
	// Each step starts in place, whatever the last one scrolled.
	useEffect(() => window.scrollTo(0, 0), [step]);
	const handle = user.nickname ?? user.name ?? "there";

	return (
		<Frame step={step} total={total} onSkip={step < total - 1 ? () => finish() : undefined} onBack={step > 0 ? () => setStep(step - 1) : undefined}>
			{step === 0 ? (
				<>
					<div className="fm-rise grid flex-1 place-items-center">
						{/* Your GitHub picture; without one, the app's icon on its own. */}
						{user.picture ? (
							<span className="grid size-24 place-items-center overflow-hidden rounded-full border border-white/15 bg-white/10">
								<img src={user.picture} alt="" className="size-full object-cover" />
							</span>
						) : (
							<img src="/onboarding/icon.png" alt="Formal Mind" className="size-[148px] drop-shadow-[0_18px_40px_rgb(0_0_0/0.6)]" />
						)}
					</div>
					<Headline muted={`Welcome, @${handle}.`} strong="Let’s prove your contracts." body="A minute of setup: what the swarm does, how far your proofs go, and where your first project starts." />
					<button type="button" onClick={next} className={`${primary} mt-10`}>Continue</button>
				</>
			) : null}

			{step === 1 ? (
				<>
					{/* The swarm on the Mac: its agents' cursors at work on the plan. */}
					<div className="fm-rise my-auto py-6">
						<SwarmShowcase />
					</div>
					<Headline muted="Run a swarm." strong="Agents do the proving." body="On your Mac, a swarm of agents works through your contracts until every function is proved or the budget is spent. From here you follow it and steer it." />
					<button type="button" onClick={next} className={`${primary} mt-10`}>Continue</button>
				</>
			) : null}

			{step === 2 ? (
				<>
					{/* One of AsyncSwap's checked theorems, as Proofs shows it. */}
					<div className="fm-rise my-auto py-6">
						<div className="dark fm-skeleton-strong mx-auto w-full max-w-[330px] text-foreground drop-shadow-[0_24px_50px_rgb(0_0_0/0.5)]">
							<TheoremCard t={THEOREM} full codeOnly className="pointer-events-none w-full" />
						</div>
					</div>
					<Headline muted="From 0 to 100." strong="Every function, proved." body="Coverage is how many of your functions have a checked Lean proof. Each one the swarm proves moves the bar; at 100 the whole contract matches its spec." />
					<button type="button" onClick={next} className={`${primary} mt-10`}>Continue</button>
				</>
			) : null}

			{step === 3 ? (
				<>
					<div className="fm-rise my-auto py-6">
						<BotIssueCard />
					</div>
					<Headline
						muted="Set up on GitHub."
						strong="Specs that keep up."
						body="Formal Mind writes your specs as commits land, in a proofs repository beside yours, for the whole life of the project. Set it up once on formal.team; proving happens here and on your Mac."
					/>
					<button type="button" onClick={() => void openUrl(APP_INSTALL_URL).then(next)} className={`${primary} mt-10 flex items-center justify-center gap-2`}>
						<MarkGithubIcon size={18} /> Set up on GitHub
					</button>
					<button type="button" onClick={next} className={`${quiet} mt-2`}>Later</button>
				</>
			) : null}

			{step === 4 ? (
				<>
					<div className="fm-rise my-auto space-y-4 py-6">
						{/* Framed as the app's cards are; the amounts not chosen shimmer as skeletons. */}
						<section className="dark fm-skeleton-strong rounded-2xl border bg-muted/60 p-1.5 text-foreground">
							<p className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
								Budget
								<span className="ml-auto normal-case tracking-normal">per run</span>
							</p>
							<div className="shadow-card rounded-xl border bg-card p-3">
								<div className="grid grid-cols-5 gap-1.5">
									{BUDGETS.map((b) => (
										<button key={b} type="button" onClick={() => setBudget(b)} className={`h-10 rounded-full text-[14px] font-medium ${budget === b ? "bg-white text-neutral-950" : "fm-skeleton text-foreground/40"}`}>
											${b}
										</button>
									))}
								</div>
								<p className="mt-3 flex items-start gap-2 border-t pt-3 text-[12px] leading-5 text-muted-foreground">
									<Laptop className="mt-0.5 size-3.5 shrink-0" />
									{macOnline(mac) ? "Your Mac is online: Start from a project's Chat runs it there with this cap." : "Starts runs on your Mac with this cap. Sign in to Formal Mind there to connect it."}
								</p>
							</div>
						</section>
					</div>
					<Headline muted="Set a budget." strong="Start verifying." body="The swarm stops when it reaches the cap; raise it and resume to carry on. Credits come from your formal.team balance, or your own Anthropic key on the Mac." />
					<button
						type="button"
						onClick={() => {
							setStartBudget(budget);
							next();
						}}
						className={`${primary} mt-10`}
					>
						Start verifying with ${budget}
					</button>
				</>
			) : null}

			{step === 5 ? (
				<>
					{/* Home's own empty state, centered as on the introduction's last page: pick a project there. */}
					<div className="fm-rise my-auto py-6">
						<div className="dark fm-home mx-auto w-full max-w-[340px] rounded-[28px] border border-white/10 bg-background text-foreground shadow-[0_24px_60px_rgb(0_0_0/0.5)]">
							<HomeEmpty muted="Bugs, proofs and code." strong={projects?.length === 0 ? "Open a repository." : "Pick a project."}>
								<div className="w-full space-y-2">
									{projects?.map((p) => (
										<button key={p.repo} type="button" onClick={() => finish(p.repo)} className="btn-soft flex h-11 w-full items-center gap-2.5 px-3.5 text-left text-[14px]">
											<MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1 truncate">
												<span className="font-light text-muted-foreground">{p.repo.split("/")[0]}/</span>
												<span className="font-semibold">{p.repo.split("/")[1]}</span>
											</span>
											<ChevronRight className="size-4 text-muted-foreground" />
										</button>
									))}
									{adding || projects?.length === 0 ? (
										// The card opens the new project itself.
										<AddProjectCard
											remoteOnly
											onCancel={projects?.length ? () => setAdding(false) : undefined}
											onDone={() => {
												setSetUpDone(true);
												onDone();
											}}
										/>
									) : (
										<button type="button" onClick={() => setAdding(true)} className="btn-soft inline-flex h-10 w-full items-center justify-center gap-1.5 text-[14px] font-medium">
											<Plus className="size-4" /> Add a project
										</button>
									)}
								</div>
							</HomeEmpty>
						</div>
					</div>
					<button type="button" onClick={() => finish()} className={`${quiet} mt-4`}>Go to Home</button>
				</>
			) : null}
		</Frame>
	);
}
