"use client";

import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useState } from "react";
import { ArrowRight, CircleDollarSign, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import YouTubeVideo from "@/components/youtube-video";
import { SetupPreview } from "./setup-preview";
import { usePlan } from "./use-plan";

const EXAMPLES = ["Uniswap/v4-core", "morpho-org/morpho-blue", "transmissions11/solmate"];

/**
 * The public front door: paste a repository, watch the planner draft the swarm's first plan
 * live, then sign up to start it.
 */
export function Landing({ signedIn }: { signedIn: boolean }) {
	const [input, setInput] = useState("");
	const { repo, plan, start, isLoading, error, done } = usePlan();
	const startHref = signedIn ? "/onboarding" : "/auth/login?screen_hint=signup&returnTo=%2Fonboarding";

	const run = (value: string) => {
		setInput(value);
		start(value);
	};

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
				<Link href="/welcome" className="flex items-center gap-2 font-semibold tracking-tight">
					<LogoMark size={24} />
					Formal Mind.
				</Link>
				<nav className="flex items-center gap-1 text-sm">
					<a href={signedIn ? "/" : "/login"} className="rounded-full px-3 py-1.5 text-muted-foreground hover:text-foreground">{signedIn ? "Open the app" : "Log in"}</a>
					<a href={startHref} className="rounded-full bg-primary px-3.5 py-1.5 font-medium text-primary-foreground hover:opacity-90">Get started</a>
				</nav>
			</header>

			<main>
				<section className="mx-auto max-w-6xl px-4 pb-10 pt-10 text-center sm:px-6 sm:pt-16">
					<h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
						Prove your Solidity code correct, using a swarm of agents for formal verification
					</h1>

					<form
						onSubmit={(e) => {
							e.preventDefault();
							run(input);
						}}
						className="mx-auto mt-8 flex max-w-xl items-center gap-2 rounded-full border bg-background p-1.5 pl-4 shadow-sm focus-within:ring-2 focus-within:ring-ring"
					>
						<MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" />
						<input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							placeholder="github.com/owner/repo"
							aria-label="GitHub repository"
							className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						/>
						<button type="submit" disabled={isLoading || !input.trim()} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
							{isLoading ? <Loader2 className="size-4 animate-spin" /> : null}
							{isLoading ? "Planning…" : "Plan my repo"}
						</button>
					</form>
					{error ? <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
					<p className="mt-3 text-xs text-muted-foreground">
						Try{" "}
						{EXAMPLES.map((example, i) => (
							<span key={example}>
								<button type="button" onClick={() => run(example)} disabled={isLoading} className="font-mono underline-offset-4 hover:text-foreground hover:underline">{example}</button>
								{i < EXAMPLES.length - 1 ? ", " : ""}
							</span>
						))}
					</p>
				</section>

				<section className="mx-auto max-w-6xl px-4 sm:px-6">
					{repo ? (
						<div aria-live="polite">
							<SetupPreview repo={repo} plan={plan} done={done} failed={Boolean(error)} startHref={startHref} />
						</div>
					) : (
						<div>
							<SwarmCanvas state={null} />
							<p className="mt-2 text-center text-xs text-muted-foreground">A replay of the swarm working one issue: turns, a question, a take-over, a merge.</p>
						</div>
					)}
				</section>

				<section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2">
					<div>
						<h2 className="text-2xl font-semibold tracking-tight">You set the budget. The swarm stops at it.</h2>
						<ul className="mt-6 space-y-4 text-sm leading-6 text-muted-foreground">
							<li className="flex gap-3"><CircleDollarSign className="mt-0.5 size-4 shrink-0 text-foreground" />Add prepaid credits with Stripe and choose a daily budget. When the day&apos;s budget is spent, the swarm pauses until tomorrow.</li>
							<li className="flex gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />Nothing merges without a clean Lean build on the exact commit, and never with a sorry or a new axiom.</li>
							<li className="flex gap-3"><Sparkles className="mt-0.5 size-4 shrink-0 text-foreground" />A daily report tells you what landed, what&apos;s in flight, and whether anything is waiting on you.</li>
						</ul>
						<a href={startHref} className="mt-8 inline-flex h-10 items-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90">
							Get started <ArrowRight className="size-4" />
						</a>
					</div>
					<YouTubeVideo videoId="xyZZqCQlmCE" title="Formal Mind quick intro" />
				</section>
			</main>

			<footer className="border-t">
				<div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:px-6">
					<span className="flex items-center gap-2"><LogoMark size={16} />Formal Mind.</span>
					<a href="mailto:formalmindai@gmail.com" className="hover:text-foreground">formalmindai@gmail.com</a>
				</div>
			</footer>
		</div>
	);
}
