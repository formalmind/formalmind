"use client";

import { Link } from "react-router";
import { LogoMark } from "@/components/logo";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useState } from "react";
import { Loader2, Maximize2, Minimize2, Play, X } from "lucide-react";
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
	// The intro starts as an icon, opens small, and can expand to most of the page.
	const [video, setVideo] = useState<"icon" | "small" | "big">("icon");
	const startHref = signedIn ? "/onboarding" : "/auth/login?screen_hint=signup&returnTo=%2Fonboarding";

	const run = (value: string) => {
		setInput(value);
		start(value);
	};

	return (
		// One screen: header and hero at the top, the demo (or the setup steps) taking every pixel left.
		<div className="flex h-dvh flex-col bg-background text-foreground">
			<header className="mx-auto flex h-16 w-full max-w-6xl shrink-0 items-center justify-between px-4 sm:px-6">
				<Link to="/welcome" className="flex items-center gap-2 font-semibold tracking-tight">
					<LogoMark size={24} />
					Formal Mind.
				</Link>
				<nav className="flex items-center gap-1 text-sm">
					{/* One call to action: in for someone signed in, started for everyone else (login is on the way). */}
					<a href={signedIn ? "/" : startHref} className="rounded-full bg-primary px-3.5 py-1.5 font-medium text-primary-foreground hover:opacity-90">
						{signedIn ? "Open the app" : "Get started"}
					</a>
				</nav>
			</header>

			<main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<section className="mx-auto w-full max-w-6xl shrink-0 px-4 pb-10 pt-16 text-center sm:px-6 sm:pt-24">
					<h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
						A swarm of Lean4 agents for proving Solidity codebases
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
						{EXAMPLES.map((example, i) => (
							<span key={example}>
								<button type="button" onClick={() => run(example)} disabled={isLoading} className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:text-foreground hover:underline">
									<MarkGithubIcon size={12} className="shrink-0" />
									{example}
								</button>
								{i < EXAMPLES.length - 1 ? ", " : ""}
							</span>
						))}
					</p>
				</section>

				<section className={`mx-auto w-full max-w-6xl px-4 pb-6 sm:px-6 ${repo ? "" : "min-h-[320px] flex-1"}`}>
					{/* A plan that failed before anything arrived leaves the demo in place, with the error above. */}
					{repo && !(error && !plan) ? (
						<div aria-live="polite">
							<SetupPreview repo={repo} plan={plan} done={done} failed={Boolean(error)} startHref={startHref} />
						</div>
					) : (
						<div className="h-full">
							<SwarmCanvas state={null} contain />
						</div>
					)}
				</section>

			</main>

			{video === "icon" ? (
				<button
					type="button"
					onClick={() => setVideo("small")}
					aria-label="Play the quick intro"
					title="Watch the quick intro"
					className="fixed bottom-4 right-4 z-40 flex size-12 items-center justify-center rounded-full bg-foreground text-background shadow-2xl transition-transform duration-200 hover:scale-105 active:scale-95 animate-in fade-in-0 zoom-in-90 motion-reduce:transition-none"
				>
					<Play className="ml-0.5 size-5 fill-current" />
				</button>
			) : (
				<aside
					aria-label="Formal Mind quick intro"
					className={`fixed bottom-4 right-4 z-40 overflow-hidden ${video === "big" ? "w-[min(1100px,calc(100vw-2rem))]" : "w-[min(288px,calc(100vw-2rem))]"} rounded-2xl border bg-black shadow-2xl transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] animate-in fade-in-0 zoom-in-95 motion-reduce:transition-none`}
				>
					<YouTubeVideo videoId="xyZZqCQlmCE" title="Formal Mind quick intro" />
					<button
						type="button"
						onClick={() => setVideo(video === "big" ? "small" : "big")}
						aria-label={video === "big" ? "Shrink video" : "Expand video"}
						title={video === "big" ? "Shrink video" : "Expand video"}
						className="absolute right-11 top-2 z-10 flex size-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
					>
						{video === "big" ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
					</button>
					<button
						type="button"
						onClick={() => setVideo("icon")}
						aria-label="Minimize video"
						title="Minimize"
						className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-black/80"
					>
						<X className="size-3.5" />
					</button>
				</aside>
			)}

		</div>
	);
}
