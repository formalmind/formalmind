"use client";

import { Link } from "react-router";
import { LogoMark } from "@/components/logo";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { SetupPreview } from "./setup-preview";
import { readDraft, usePlan } from "./use-plan";
import { EXAMPLE_REPOS } from "@/lib/plan";

const EXAMPLES = EXAMPLE_REPOS;

/**
 * The public front door: paste a repository, watch the planner draft the swarm's first plan
 * live, then sign up to start it.
 */
const FOOTER = [
	{
		title: "Product",
		links: [
			{ label: "Get started", href: "/onboarding" },
			{ label: "Documentation", href: "/documentation/get-started" },
			{ label: "GitHub App", href: "https://github.com/apps/formalmind" },
		],
	},
	{
		title: "Resources",
		links: [
			{ label: "Brand kit", href: "/brand/" },
			{ label: "GitHub", href: "https://github.com/formalmind" },
			{ label: "Lean template", href: "https://github.com/formalmind/lean-template" },
		],
	},
	{
		title: "Legal",
		links: [
			{ label: "Privacy", href: "/privacy/" },
			{ label: "Terms", href: "/terms/" },
		],
	},
];

/** The latest desktop build, published as a GitHub release asset with a fixed name. */
const MAC_DOWNLOAD = "https://github.com/formalmind/formalmind/releases/latest/download/Formal-Mind-mac.dmg";

function AppleMark() {
	return (
		<svg viewBox="0 0 384 512" className="size-3.5 -translate-y-px" fill="currentColor" aria-hidden>
			<path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
		</svg>
	);
}

export function Landing({ signedIn }: { signedIn: boolean }) {
	const [input, setInput] = useState("");
	const [scrolled, setScrolled] = useState(false);
	const { repo, plan, start, reset, resume, isLoading, error, done } = usePlan();
	// Coming back to the page picks up the last plan where it was left.
	useEffect(() => {
		const draft = readDraft();
		if (draft) {
			resume(draft);
			setInput(draft.repo);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// Once a repository is being planned the box locks, so the next step is the setup below; Change unlocks it.
	const locked = Boolean(repo) && !(error && !plan);
	const startHref = signedIn ? "/onboarding" : "/auth/login?returnTo=%2Fonboarding";

	const run = (value: string) => {
		setInput(value);
		start(value);
	};

	return (
		// One screen: header and hero at the top, the demo (or the setup steps) taking every pixel left.
		<div className="relative flex h-dvh flex-col bg-background text-foreground">
			{/* Floats over the page; once it scrolls, it tucks into a frosted pill. */}
			<header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3">
				<div
					className={`pointer-events-auto flex w-full items-center justify-between transition-[max-width,height,margin,padding,background-color,box-shadow,border-color] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
						scrolled
							? "mt-3 h-12 max-w-2xl rounded-full border border-border/70 bg-background/80 pl-4 pr-1.5 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)] backdrop-blur-xl"
							: "mt-0 h-16 max-w-6xl border border-transparent px-1 sm:px-3"
					}`}
				>
				<Link to="/welcome" className="flex items-center gap-2 font-semibold tracking-tight">
					<LogoMark size={24} />
					<span className="font-display text-[23px] font-normal leading-none tracking-normal">Formal Mind.</span>
				</Link>
				<nav className="flex items-center gap-2 text-sm">
					{/* In for someone signed in, started for everyone else (login is on the way); or the Mac app. */}
					<a href={signedIn ? "/" : startHref} className="btn-soft h-9 px-4">
						{signedIn ? "Open the app" : "Get started"}
					</a>
					<a href={MAC_DOWNLOAD} className="btn-dark hidden h-9 gap-2 px-4 sm:inline-flex">
						<AppleMark />
						Download for Mac
					</a>
				</nav>
				</div>
			</header>

			<main onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)} className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-16">
				<section className="mx-auto w-full max-w-6xl shrink-0 px-4 pb-10 pt-16 text-center sm:px-6 sm:pt-24">
					<h1 className="mx-auto max-w-2xl text-balance bg-gradient-to-b from-neutral-500 to-neutral-950 bg-clip-text pb-1 text-transparent dark:from-neutral-500 dark:to-white text-[34px] font-medium leading-10 tracking-[-1px] sm:text-5xl sm:leading-[1.1] sm:tracking-[-1.5px]">
						A swarm of agents verifying Ethereum smart contracts
					</h1>
					<p className="mx-auto mt-4 max-w-[560px] text-balance text-[15px] leading-[22px] text-muted-foreground">
						Formal proofs of your contracts, one small pull request at a time, within a daily budget you set.
					</p>

					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (locked) {
								reset();
								return;
							}
							run(input);
						}}
						className={`shadow-pop mx-auto mt-8 flex max-w-xl items-center gap-2 rounded-full p-1.5 pl-4 focus-within:ring-2 focus-within:ring-ring ${locked ? "bg-muted/60" : "bg-background"}`}
					>
						{locked ? <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Locked" /> : <MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" />}
						<input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							readOnly={locked}
							placeholder="github.com/owner/repo"
							aria-label="GitHub repository"
							className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground ${locked ? "cursor-default text-muted-foreground" : ""}`}
						/>
						{locked ? (
							<button type="submit" className="btn-soft h-10">
								{isLoading ? <Loader2 className="size-4 animate-spin" /> : null}
								Change
							</button>
						) : (
							<button type="submit" disabled={isLoading || !input.trim()} className="btn-dark h-10 disabled:opacity-50">
								Plan my repo
							</button>
						)}
					</form>
					{error ? <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
					<p className="mt-3 flex flex-wrap items-center justify-center gap-x-1 text-xs text-muted-foreground">
						{EXAMPLES.map((example, i) => (
							<span key={example} className="inline-flex items-center">
								<button type="button" onClick={() => run(example)} disabled={locked} className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50">
									<MarkGithubIcon size={12} className="shrink-0" />
									{example}
								</button>
								{i < EXAMPLES.length - 1 ? ", " : ""}
							</span>
						))}
					</p>
					<JoinCount />
				</section>

				{/* The demo takes the width (up to the board's own 1200px) and its height follows; the page scrolls. */}
				<section className={`mx-auto w-full px-4 pb-6 sm:px-6 ${repo ? "max-w-6xl" : "max-w-[1248px]"}`}>
					{/* A plan that failed before anything arrived leaves the demo in place, with the error above. */}
					{repo && !(error && !plan) ? (
						<div aria-live="polite">
							<SetupPreview repo={repo} plan={plan} done={done} failed={Boolean(error)} startHref={startHref} />
						</div>
					) : (
						<SwarmCanvas state={null} />
					)}
				</section>

				<footer className="mt-8 w-full shrink-0 border-t">
					<div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-8 px-4 py-10 text-sm sm:grid-cols-4 sm:px-6">
						<div className="col-span-2 sm:col-span-1">
							<Link to="/welcome" className="flex items-center gap-2 font-semibold tracking-tight">
								<LogoMark size={20} />
								<span className="font-display text-[19px] font-normal leading-none tracking-normal">Formal Mind.</span>
							</Link>
							<p className="mt-3 max-w-[16rem] text-muted-foreground">A swarm of agents that verifies your Ethereum smart contracts in Lean 4.</p>
						</div>
						{FOOTER.map((column) => (
							<nav key={column.title} aria-label={column.title}>
								<h2 className="font-medium">{column.title}</h2>
								<ul className="mt-3 space-y-2">
									{column.links.map((link) => (
										<li key={link.label}>
											<a href={link.href} {...(link.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})} className="text-muted-foreground hover:text-foreground">
												{link.label}
											</a>
										</li>
									))}
								</ul>
							</nav>
						))}
					</div>
					<div className="mx-auto w-full max-w-6xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">© {new Date().getFullYear()} Formal Mind</div>
				</footer>
			</main>


		</div>
	);
}

/** "9 users verifying their contracts": everyone signed up, fading in once known; its line is reserved so nothing shifts. */
function JoinCount() {
	const [users, setUsers] = useState<number | null>(null);
	useEffect(() => {
		void fetch("/api/stats")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { users?: number } | null) => setUsers(body?.users ?? null))
			.catch(() => setUsers(null));
	}, []);
	return (
		<p className={`mt-4 h-5 text-sm text-muted-foreground transition-opacity duration-500 ${users ? "opacity-100" : "opacity-0"}`}>
			{users ? <><span className="font-medium tabular-nums text-foreground">{users}</span> {users === 1 ? "user" : "users"} verifying their contracts</> : null}
		</p>
	);
}
