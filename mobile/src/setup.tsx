import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MarkGithubIcon } from "@primer/octicons-react";
import { ChevronRight, Laptop } from "lucide-react";
import { AddProjectCard } from "@/components/add-project";
import { ItemPreview } from "@/components/swarm/swarm-canvas";
import type { SwarmItem } from "@/lib/swarm";
import { projectPath, useProjects } from "@/components/projects/use-projects";
import { apiBase } from "@/desktop/src/api";
import type { SessionData } from "@/lib/session";
import { macOnline, setStartBudget, startBudget, useMac } from "./relay";
import { rememberProject } from "./tabs";
import { SwarmShowcase } from "./showcase";
import { CoverageCard } from "./proofs";

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

/** What the GitHub app posts: a spec issue from an audit, in the proofs repository (asyncswap/protocol-proofs#30). */
const BOT_ISSUE: SwarmItem = {
	repo: "asyncswap/protocol-proofs",
	number: 30,
	kind: "issue",
	title: "audit: executor revocation and scoping in setExecutor / setExecutorWithSig",
	labels: ["fm:in-progress"],
	url: "https://github.com/asyncswap/protocol-proofs/issues/30",
	createdAt: "2026-10-20T07:36:09Z",
	updatedAt: "2026-10-20T07:36:09Z",
	author: "formalmind[bot]",
	authorAvatar: "https://avatars.githubusercontent.com/in/1319020?v=4",
	excerpt: "Goal. Prove that executor authorization is revocable and scoped: after setExecutor(poolId, executor, false), that executor can no longer fill, cancel or updatePrice that maker's orders on that pool.",
	comments: 0,
	merged: false,
	state: "open",
};

function Frame({ step, total, onSkip, children }: { step: number; total: number; onSkip?: () => void; children: React.ReactNode }) {
	return (
		<main className="fm-safe-top fm-safe-bottom relative flex min-h-dvh flex-col overflow-x-hidden bg-[radial-gradient(ellipse_at_top,#151a24_0%,#08090b_60%)] px-6 pb-8 text-white">
			<div className="flex h-12 items-center gap-3">
				<div className="flex flex-1 gap-1" aria-label={`Step ${step + 1} of ${total}`}>
					{Array.from({ length: total }, (_, i) => (
						<span key={i} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-white" : "bg-white/15"}`} />
					))}
				</div>
				{onSkip ? (
					<button type="button" onClick={onSkip} className="text-[15px] text-white/50">
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

/** A count from 0 to 100 that runs once (the coverage a finished swarm reaches). */
function useCount(run: boolean, ms = 2400) {
	const [n, setN] = useState(0);
	useEffect(() => {
		if (!run) return;
		let raf = 0;
		const t0 = performance.now();
		const tick = (t: number) => {
			const p = Math.min(1, (t - t0) / ms);
			setN(Math.round(100 * (1 - (1 - p) ** 3)));
			if (p < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [run, ms]);
	return n;
}

/** The app's coverage card (the Proofs explorer's), at `value`% of AsyncSwap's 143 functions proved. */
function Coverage({ value }: { value: number }) {
	const total = 143;
	const proved = Math.round((value / 100) * total);
	return (
		<div className="dark text-foreground">
			<CoverageCard contract="AsyncSwap" theorems={Math.round((value / 100) * 876)} proved={proved} notYet={total - proved} opaque={0} />
		</div>
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
	const [verifying, setVerifying] = useState(false);
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
	const toHundred = useCount(verifying, 3000);
	const handle = user.nickname ?? user.name ?? "there";

	return (
		<Frame step={step} total={total} onSkip={step < total - 1 ? () => finish() : undefined}>
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
					<div className="fm-rise my-auto space-y-4 py-6">
						<Coverage value={100} />
					</div>
					<Headline muted="From 0 to 100." strong="Every function, proved." body="Coverage is how many of your functions have a checked Lean proof. Each one the swarm proves moves the bar; at 100 the whole contract matches its spec." />
					<button type="button" onClick={next} className={`${primary} mt-10`}>Continue</button>
				</>
			) : null}

			{step === 3 ? (
				<>
					<div className="fm-rise my-auto py-6">
						<div className={`dark ${card} p-4 text-foreground`}>
							<ItemPreview item={BOT_ISSUE} />
						</div>
					</div>
					<Headline
						muted="Set up on GitHub."
						strong="Specs that keep up."
						body="Formal Mind writes your specs as commits land, in a proofs repository beside yours, for the whole life of the project. Set it up once on formal.team; proving happens here and on your Mac."
					/>
					<button type="button" onClick={() => void openUrl(`${apiBase()}/onboarding`).then(next)} className={`${primary} mt-10 flex items-center justify-center gap-2`}>
						<MarkGithubIcon size={18} /> Set up on GitHub
					</button>
					<button type="button" onClick={next} className={`${quiet} mt-2`}>Later</button>
				</>
			) : null}

			{step === 4 ? (
				<>
					<div className="fm-rise my-auto space-y-4 py-6">
						<div className="grid grid-cols-5 gap-2">
							{BUDGETS.map((b) => (
								<button key={b} type="button" onClick={() => setBudget(b)} className={`h-12 rounded-full border text-[15px] font-medium ${budget === b ? "border-white bg-white text-neutral-950" : "border-white/15 bg-white/[0.05]"}`}>
									${b}
								</button>
							))}
						</div>
						{verifying ? <Coverage value={toHundred} /> : null}
						<p className="flex items-center gap-2 text-[13px] text-white/50">
							<Laptop className="size-4" />
							{macOnline(mac) ? "Your Mac is online: Start from a project's Chat runs it there with this cap." : "Starts run on your Mac with this cap. Sign in to Formal Mind there to connect it."}
						</p>
					</div>
					<Headline muted="Set a budget." strong="Start verifying." body="The swarm stops when it reaches the cap; raise it and resume to carry on. Credits come from your formal.team balance, or your own Anthropic key on the Mac." />
					<button
						type="button"
						onClick={() => {
							setStartBudget(budget);
							if (!verifying) setVerifying(true);
							else next();
						}}
						className={`${primary} mt-10`}
					>
						{!verifying ? `Start verifying with $${budget}` : toHundred < 100 ? `Verifying… ${toHundred}%` : "Continue"}
					</button>
				</>
			) : null}

			{step === 5 ? (
				<>
					<Headline muted="Select a project." strong="Start with one." body="Pick one of your projects, or add a repository from GitHub." />
					<div className="fm-rise mt-6 flex-1 space-y-3 overflow-y-auto">
						{projects?.map((p) => (
							<button key={p.repo} type="button" onClick={() => finish(p.repo)} className={`${card} flex w-full items-center gap-3 p-3.5 text-left active:bg-white/10`}>
								<MarkGithubIcon size={18} className="shrink-0 text-white/60" />
								<span className="min-w-0 flex-1">
									<span className="block truncate font-medium">{p.repo.split("/")[1]}</span>
									<span className="block truncate text-[12px] text-white/50">{p.repo.split("/")[0]}</span>
								</span>
								<ChevronRight className="size-4 text-white/40" />
							</button>
						))}
						{adding || projects?.length === 0 ? (
							<div className="text-foreground">
								{/* The card opens the new project itself. */}
								<AddProjectCard
									remoteOnly
									onCancel={projects?.length ? () => setAdding(false) : undefined}
									onDone={() => {
										setSetUpDone(true);
										onDone();
									}}
								/>
							</div>
						) : (
							<button type="button" onClick={() => setAdding(true)} className={`${card} w-full p-3.5 text-[15px] text-white/70 active:bg-white/10`}>
								Add a repository
							</button>
						)}
					</div>
					<button type="button" onClick={() => finish()} className={`${quiet} mt-4`}>Go to Home</button>
				</>
			) : null}
		</Frame>
	);
}
