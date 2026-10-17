import { Link } from "react-router";
import { ArrowRight, Bot, CircleDollarSign, Eye, GitPullRequest, MessageSquare, ShieldCheck, Tag, Terminal } from "lucide-react";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { SwarmRole } from "@/lib/swarm";

const PROOFS_REPO = "https://github.com/asyncswap/v2-proofs";
const SWARM_README = `${PROOFS_REPO}/blob/dev/.github/formalmind/README.md`;
const RELAY = "https://github.com/formalmind/webhook-redis/tree/main/worker";

const ROLES: { role: SwarmRole; job: string; detail: string }[] = [
	{ role: "dispatcher", job: "Picks one job", detail: "Every 30 minutes, or when an fm: label changes. Order: merge, review, revise, resume, new issue, plan. Not a model." },
	{ role: "planner", job: "Scopes the work", detail: "Reads the roadmap and the gaps the changelog left, and writes small, disjoint issues labelled fm:todo." },
	{ role: "prover", job: "Writes the Lean", detail: "Takes one issue on its own branch, pushes as it goes, and opens a PR once lake build is clean." },
	{ role: "reviewer", job: "First pair of eyes", detail: "Reads the whole diff against the Solidity, leaves inline suggestions, then approves or bounces." },
	{ role: "merger", job: "Verifies and merges", detail: "Builds the exact head, checks every claim in the thread against the code, then merges or holds it for you." },
	{ role: "chief", job: "Reports daily", detail: "At 23:40 UTC posts one update: Done, Working, Waiting on you or Paused on budget." },
];

const FLOW = ["fm:todo", "fm:in-progress", "fm:review", "fm:approved", "merged"];

const CHIP = "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground";

function Code({ children }: { children: React.ReactNode }) {
	return <code className={CHIP}>{children}</code>;
}

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
	return (
		<section className="border-t py-10 first:border-t-0 first:pt-0">
			<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
			<h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</h2>
			<div className="mt-5">{children}</div>
		</section>
	);
}

function Step({ n, icon: Icon, title, children }: { n: number; icon: React.ElementType; title: string; children: React.ReactNode }) {
	return (
		<li className="flex gap-4">
			<div className="flex flex-col items-center">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background text-sm font-medium tabular-nums">{n}</span>
				<span className="mt-2 w-px flex-1 bg-border" aria-hidden />
			</div>
			<div className="min-w-0 pb-8">
				<h3 className="flex items-center gap-2 text-base font-medium text-foreground">
					<Icon className="size-4 text-muted-foreground" />
					{title}
				</h3>
				<div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">{children}</div>
			</div>
		</li>
	);
}

export function GetStarted() {
	return (
		<div className="not-prose mx-auto w-full max-w-3xl pb-16 pt-4 text-foreground">
			<header className="pb-10">
				<p className="text-sm text-muted-foreground">Get started</p>
				<h1 className="mt-2 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
					A swarm of agents that keeps your Lean spec in step with your Solidity
				</h1>
				<p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-muted-foreground">
					Formal Mind works where your code already lives. Issues are the task queue, <Code>fm:</Code> labels are the state,
					pull requests are the work, and every agent posts as <Code>formalmind[bot]</Code>. You watch, steer and decide; the
					swarm does the proving within a budget you set.
				</p>
				<div className="mt-6 flex flex-wrap gap-3">
					<Link to="/" className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
						Watch the swarm live <ArrowRight className="size-4" />
					</Link>
					<a href={SWARM_README} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors hover:bg-muted">
						Read the swarm design
					</a>
				</div>
			</header>

			<Section eyebrow="How it works" title="Six roles, one board">
				<ul className="grid gap-3 sm:grid-cols-2">
					{ROLES.map(({ role, job, detail }) => (
						<li key={role} className="rounded-xl border bg-card p-4">
							<div className="flex items-center gap-2">
								<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
									<polygon points="7 20 7 4 19 16 12 16 7 21" fill={ROLE_COLORS[role]} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
								</svg>
								<span className="text-sm font-medium">{role}</span>
								<span className="text-sm text-muted-foreground">· {job}</span>
							</div>
							<p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
						</li>
					))}
				</ul>

				<div className="mt-6 rounded-xl border bg-muted/40 p-4">
					<p className="text-sm font-medium">One issue&apos;s trip</p>
					<ol className="mt-3 flex flex-wrap items-center gap-2 text-xs">
						{FLOW.map((label, i) => (
							<li key={label} className="flex items-center gap-2">
								<span className="rounded-md border bg-background px-2 py-1 font-mono">{label}</span>
								{i < FLOW.length - 1 ? <ArrowRight className="size-3.5 text-muted-foreground" /> : null}
							</li>
						))}
					</ol>
					<p className="mt-3 text-sm leading-6 text-muted-foreground">
						The reviewer or merger can send a PR back as <Code>fm:changes</Code>, and anything that needs a human decision is parked as{" "}
						<Code>fm:blocked</Code> with the question asked in one comment. Every run keeps a task list on the notebook issue and a cost
						line on the ledger, so nothing it claims is unverifiable.
					</p>
				</div>
			</Section>

			<Section eyebrow="Working with it" title="Five things you do">
				<ol>
					<Step n={1} icon={Eye} title="Watch it work">
						<p>
							The <Link to="/" className="text-foreground underline underline-offset-4">Swarm page</Link> shows the board as it is. When a run
							starts, that role&apos;s cursor moves to the issue or PR it picked up and ticks off its task list live. Recent runs list what each
							one did and what it cost.
						</p>
					</Step>
					<Step n={2} icon={Tag} title="Queue work">
						<p>
							Put <Code>fm:todo</Code> on any issue and a prover picks it up on a coming sweep. Or let the planner write issues from the{" "}
							<strong className="font-medium text-foreground">Roadmap</strong> section of the proofs repo&apos;s README; it keeps two queued
							and plans more when the queue runs low.
						</p>
					</Step>
					<Step n={3} icon={MessageSquare} title="Ask questions">
						<p>
							Use <strong className="font-medium text-foreground">Ask the swarm</strong> above the board for what is running, what it spent
							and what is waiting on you. On GitHub, tag <Code>@formalmind</Code> in any issue, PR or comment: chat gets an answer in seconds,
							and a question that needs the repo or the Lean toolchain starts a real run.
						</p>
					</Step>
					<Step n={4} icon={ShieldCheck} title="Decide when asked">
						<p>
							You are tagged only when a decision is needed: an <Code>fm:blocked</Code> issue, or a PR the merger held because a theorem
							statement changed, the diff is wide, or a claim did not check out. Add <Code>fm:human-ok</Code> to let it merge. The chief&apos;s
							daily headline tells you whether anything is <strong className="font-medium text-foreground">Waiting on you</strong>.
						</p>
					</Step>
					<Step n={5} icon={Terminal} title="Drive it by hand">
						<p>The dispatcher decides on its own, but you can start any role now:</p>
						<pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-5 text-foreground">{`gh workflow run formalmind-swarm.yml -f role=plan
gh workflow run formalmind-swarm.yml -f role=prove -f number=12
gh workflow run formalmind-swarm.yml -f role=review -f number=40`}</pre>
					</Step>
				</ol>
			</Section>

			<Section eyebrow="Budget and safety" title="It cannot run away">
				<div className="grid gap-3 sm:grid-cols-3">
					{[
						{ icon: CircleDollarSign, title: "$5 a day, $150 a month", body: "Enforced from the ledger. Per-run caps: $3 to prove, $1 to review or merge, $0.40 to plan or report. When spent, it posts one pause note and waits for the reset." },
						{ icon: GitPullRequest, title: "Nothing unchecked merges", body: "A clean lake build on the exact head, and never a sorry, admit or new axiom. A false claim in the thread is a bounce." },
						{ icon: Bot, title: "Bounded retries", body: "One model job per sweep. A prover gets two runs per issue a day and a reviewer bounces twice before the work is parked for you." },
					].map(({ icon: Icon, title, body }) => (
						<div key={title} className="rounded-xl border bg-card p-4">
							<Icon className="size-4 text-muted-foreground" />
							<p className="mt-3 text-sm font-medium">{title}</p>
							<p className="mt-1.5 text-sm leading-6 text-muted-foreground">{body}</p>
						</div>
					))}
				</div>
			</Section>

			<Section eyebrow="Your repositories" title="Set it up on your own protocol">
				<ol className="space-y-4 text-sm leading-6 text-muted-foreground">
					{[
						<>
							<span className="font-medium text-foreground">A proofs repository.</span> A Lean 4 project with a README that records your
							decisions and a <span className="font-medium text-foreground">Roadmap</span>, and a <Code>FORMAL_MIND.md</Code> changelog. Copy
							the three workflows and the role prompts in <Code>.github/formalmind/</Code> from{" "}
							<a href={PROOFS_REPO} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">asyncswap/v2-proofs</a>.
						</>,
						<>
							<span className="font-medium text-foreground">Secrets.</span> <Code>ANTHROPIC_API_KEY</Code>, plus{" "}
							<Code>FORMALMIND_APP_ID</Code> and <Code>FORMALMIND_APP_PRIVATE_KEY</Code> for the GitHub App the agents post as. Add{" "}
							<Code>PROTOCOL_READ_TOKEN</Code> if the protocol repository is private.
						</>,
						<>
							<span className="font-medium text-foreground">Three pinned issues.</span> A ledger, a notebook and a chief-updates issue; put
							their numbers in the swarm workflow&apos;s <Code>LEDGER_ISSUE</Code>, <Code>NOTEBOOK_ISSUE</Code> and <Code>CHIEF_ISSUE</Code>.
						</>,
						<>
							<span className="font-medium text-foreground">The relay.</span> Deploy the{" "}
							<a href={RELAY} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">Cloudflare Worker</a>, map
							your protocol repository to the proofs repository in its <Code>TARGETS</Code>, and add a <Code>push</Code> webhook on the protocol
							repository. Every push then reconciles the spec, and the Worker also keeps the swarm&apos;s 30-minute clock.
						</>,
					].map((body, i) => (
						<li key={i} className="flex gap-3">
							<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-foreground">{i + 1}</span>
							<p>{body}</p>
						</li>
					))}
				</ol>
				<p className="mt-6 text-sm text-muted-foreground">
					Want help setting it up? <a href="mailto:formalmindai@gmail.com" className="text-foreground underline underline-offset-4">Get in touch</a>.
				</p>
			</Section>
		</div>
	);
}
