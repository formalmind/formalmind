import { useState } from "react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ArrowRight, Bot, CircleDollarSign, Eye, GitPullRequest, MessageSquare, ShieldCheck, Tag, Terminal } from "lucide-react";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { SwarmRole } from "@/lib/swarm";

const PROOFS_REPO = "https://github.com/asyncswap/v2-proofs";
/** Where the role prompts live until the swarm PRs merge into dev; switch this to "dev" then. */
const PROMPTS_REF = "fm/multi-project";
const CYCLE = `${PROOFS_REPO}/blob/${PROMPTS_REF}/.github/formalmind/cycle.md`;
const SWARM_README = `${PROOFS_REPO}/blob/${PROMPTS_REF}/.github/formalmind/README.md`;
const promptUrl = (file: string) => `https://raw.githubusercontent.com/asyncswap/v2-proofs/${PROMPTS_REF}/.github/formalmind/${file}`;
const ASSISTANT_THREAD = `${PROOFS_REPO}/issues/69`;
const RELAY = "https://github.com/formalmind/webhook-redis/tree/main/worker";

/** Each agent with its prompt file in .github/formalmind/ (the dispatcher is not a model, so it has none). */
const ROLES: { role: SwarmRole | "consolidator"; job: string; detail: string; prompt?: string }[] = [
	{ role: "dispatcher", job: "Picks one job", detail: "Every 30 minutes, or when an fm: label changes. Order: answer, merge, review, revise, resume, new issue, edit, plan. Not a model." },
	{ role: "planner", job: "Scopes the work", detail: "Reads the roadmap and the gaps the changelog left, and writes small, disjoint issues labelled fm:todo.", prompt: "plan.md" },
	{ role: "prover", job: "Writes the Lean", detail: "Takes one issue on its own branch, pushes as it goes, and opens a PR once lake build is clean.", prompt: "prove.md" },
	{ role: "rebuilder", job: "Rebuilds from the proofs", detail: "Writes a polished, simplified Solidity version of your protocol from the Lean alone, never your code, and lists every guess it had to make.", prompt: "rebuild.md" },
	{ role: "reviewer", job: "First pair of eyes", detail: "Reads the whole diff against the Solidity, leaves inline suggestions, then approves or bounces.", prompt: "review.md" },
	{ role: "merger", job: "Verifies and merges", detail: "Builds the exact head, checks every claim in the thread against the code, then merges or holds it for you.", prompt: "merge.md" },
	{ role: "editor", job: "Compares and polishes", detail: "Holds your code, the rebuild and the proofs side by side, classifies every difference, and runs the cycle until they agree.", prompt: "editor.md" },
	{ role: "consolidator", job: "Keeps the official protocol", detail: "Carries every decision into one official version, then rewrites its state machine, diagrams and docs, in that order.", prompt: "consolidate.md" },
	{ role: "chief", job: "Audits the day", detail: "At 23:40 UTC checks every run's claims against what landed, with a headline: Done, Working, Waiting on you or Paused on budget.", prompt: "chief.md" },
	{ role: "assistant", job: "Talks to you", detail: "The only agent that does. Asks you one precise question at a time with a recommendation, and carries out your answer.", prompt: "assistant.md" },
];

const FLOW = ["fm:todo", "fm:in-progress", "fm:review", "fm:approved", "merged"];

const CYCLE_PHASES: { phase: string; who: string; what: string }[] = [
	{ phase: "spec", who: "planner, prover", what: "Formalize your code, and any behaviour you described in words, until the spec is near complete." },
	{ phase: "rebuild", who: "rebuilder", what: "Rebuild the protocol in Solidity from the proofs alone. Every guess is a place the proofs are silent." },
	{ phase: "compare", who: "editor", what: "Put the rebuild next to your code. Each difference is a gap, an improvement, a divergence or a bug." },
	{ phase: "polish", who: "rebuilder, prover", what: "Fix what you decided, prove what the spec missed, compare again." },
	{ phase: "reprove", who: "prover, editor", what: "Prove the rebuild as its own spec and compare the two specs theorem by theorem." },
	{ phase: "close", who: "editor", what: "Summary and confidence. Start again when your code or your intent changes." },
];

const CHIP = "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em] text-foreground";

function Code({ children }: { children: React.ReactNode }) {
	return <code className={CHIP}>{children}</code>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="border-t py-10 first:border-t-0 first:pt-0">
			<h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
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
				<h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
					<Icon className="size-4 text-muted-foreground" />
					{title}
				</h3>
				<div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">{children}</div>
			</div>
		</li>
	);
}

/** A role's card; hovering it shows the role's prompt, read from the swarm's repository. */
function RoleCard({ role, job, detail, prompt }: (typeof ROLES)[number]) {
	const [text, setText] = useState<string | null>(null);
	const color = role === "consolidator" ? "#0ea5e9" : ROLE_COLORS[role];
	const card = (
		<li className="rounded-xl border bg-card p-4">
			<div className="flex items-center gap-2">
				<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
					<polygon points="7 20 7 4 19 16 12 16 7 21" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
				</svg>
				<span className="text-sm font-medium">{role}</span>
				<span className="text-sm text-muted-foreground">· {job}</span>
			</div>
			<p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
		</li>
	);
	if (!prompt) return card;
	return (
		<HoverCard
			openDelay={250}
			onOpenChange={(open) => {
				if (open && text === null) {
					fetch(promptUrl(prompt))
						.then((res) => (res.ok ? res.text() : Promise.reject()))
						.then(setText)
						.catch(() => setText("Couldn't load this prompt."));
				}
			}}
		>
			<HoverCardTrigger asChild>{card}</HoverCardTrigger>
			<HoverCardContent side="right" align="start" className="max-h-[28rem] w-[28rem] max-w-[90vw] overflow-y-auto">
				<p className="mb-2 font-mono text-sm text-muted-foreground">.github/formalmind/{prompt}</p>
				{text === null ? (
					<p className="text-sm text-muted-foreground">Loading the prompt…</p>
				) : (
					<div className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-sm prose-p:my-2 prose-ul:my-2 prose-pre:text-sm">
						<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
					</div>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}

export function GetStarted() {
	return (
		<div className="not-prose mx-auto w-full max-w-3xl pb-16 pt-4 text-foreground">
			<header className="pb-10">
				<h1 className="text-sm font-semibold tracking-tight">Get started</h1>
				<p className="mt-4 max-w-2xl text-pretty text-sm leading-7 text-muted-foreground">
					A swarm of agents builds your Lean spec and your Solidity in parallel, together, and keeps them in step.
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

			<Section title="Ten roles, one board">
				<ul className="grid gap-3 sm:grid-cols-2">
					{ROLES.map((r) => <RoleCard key={r.role} {...r} />)}
				</ul>

				<div className="mt-6 rounded-xl border bg-muted/40 p-4">
					<p className="text-sm font-medium">One issue&apos;s trip</p>
					<ol className="mt-3 flex flex-wrap items-center gap-2 text-sm">
						{FLOW.map((label, i) => (
							<li key={label} className="flex items-center gap-2">
								<span className="rounded-md border bg-background px-2 py-1 font-mono">{label}</span>
								{i < FLOW.length - 1 ? <ArrowRight className="size-3.5 text-muted-foreground" /> : null}
							</li>
						))}
					</ol>
					<p className="mt-3 text-sm leading-6 text-muted-foreground">
						The reviewer or merger can send a PR back as <Code>fm:changes</Code>, and anything that needs a human decision is parked as{" "}
						<Code>fm:blocked</Code> and handed to the assistant, who asks you. Every run keeps a task list in the Swarm notebook and a cost
						line in the Ledger notebook, so nothing it claims is unverifiable.
					</p>
				</div>
			</Section>

			<Section title="Prove it, rebuild it, compare, repeat">
				<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
					Proving your code is the first half. Then the swarm rebuilds the protocol from the proofs alone and compares the rebuild with
					what you wrote. Wherever the two differ, either the proofs are missing something or one version is better, and you decide
					which. Two to five cycles, until both versions and both specs agree and a cycle finds nothing new.
				</p>
				<ol className="mt-5 grid gap-3 sm:grid-cols-3">
					{CYCLE_PHASES.map(({ phase, who, what }, i) => (
						<li key={phase} className="rounded-xl border bg-card p-4">
							<div className="flex items-baseline gap-2">
								<span className="text-sm tabular-nums text-muted-foreground">{i + 1}</span>
								<span className="font-mono text-sm font-medium">{phase}</span>
								<span className="truncate text-sm text-muted-foreground">· {who}</span>
							</div>
							<p className="mt-2 text-sm leading-6 text-muted-foreground">{what}</p>
						</li>
					))}
				</ol>
				<p className="mt-4 text-sm leading-6 text-muted-foreground">
					New behaviour you describe in words counts as a change too: it is specified first, the rebuild implements it, and the
					comparison tells you whether your code does it yet.{" "}
					<a href={CYCLE} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">The full algorithm</a>.
				</p>
			</Section>

			<Section title="Five things you do">
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
							Put <Code>fm:todo</Code> on any issue and a prover picks it up on a coming sweep; <Code>fm:rebuild</Code> queues it for the
							rebuilder instead. Or let the planner write issues from the{" "}
							<strong className="font-medium text-foreground">Roadmap</strong> section of the proofs repo&apos;s <Code>.formal/plan.md</Code>; it keeps two queued
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
					<Step n={4} icon={ShieldCheck} title="Decide when the assistant asks">
						<p>
							One agent talks to you: the assistant, on{" "}
							<a href={ASSISTANT_THREAD} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">its own thread</a>.
							Whenever another role is stuck, or the editor finds a difference only you can settle, the assistant asks you one question
							with its recommendation first. Reply in plain words (&ldquo;merge it&rdquo;, &ldquo;follow my code on partial fills&rdquo;,
							&ldquo;orders should expire after a day&rdquo;) and it unblocks, labels and files the work for you. Every evening it posts what
							needs you, what landed and where the cycle stands.
						</p>
					</Step>
					<Step n={5} icon={Terminal} title="Drive it by hand">
						<p>The dispatcher decides on its own, but you can start any role now:</p>
						<pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-sm leading-5 text-foreground">{`gh workflow run formalmind-swarm.yml -f role=plan
gh workflow run formalmind-swarm.yml -f role=prove -f number=12
gh workflow run formalmind-swarm.yml -f role=review -f number=40
gh workflow run formalmind-swarm.yml -f role=editor`}</pre>
					</Step>
				</ol>
			</Section>

			<Section title="It cannot run away">
				<div className="grid gap-3 sm:grid-cols-3">
					{[
						{ icon: CircleDollarSign, title: "$5 a day, $150 a month", body: "Enforced from the ledger. Per-run caps: $3 to prove or rebuild, $1 to review, merge or edit, $0.40 to plan or report. When spent, it posts one pause note and waits for the reset." },
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

			<Section title="Set it up on your own protocol">
				<ol className="space-y-4 text-sm leading-6 text-muted-foreground">
					{[
						<>
							<span className="font-medium text-foreground">A proofs repository.</span> A Lean 4 project with a <Code>.formal/plan.md</Code> that records
							your decisions and a <span className="font-medium text-foreground">Roadmap</span>, a <Code>.formal/notebook.json</Code> config,
							and a <Code>FORMAL_MIND.md</Code> changelog. Copy
							the workflows and the role prompts in <Code>.github/formalmind/</Code> from{" "}
							<a href={PROOFS_REPO} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">asyncswap/v2-proofs</a>.
						</>,
						<>
							<span className="font-medium text-foreground">Secrets.</span> <Code>ANTHROPIC_API_KEY</Code>, plus{" "}
							<Code>FORMALMIND_APP_ID</Code> and <Code>FORMALMIND_APP_PRIVATE_KEY</Code> for the GitHub App the agents post as. Add{" "}
							<Code>PROTOCOL_READ_TOKEN</Code> if the protocol repository is private.
						</>,
						<>
							<span className="font-medium text-foreground">Four notebooks.</span> One issue each: the Ledger notebook, the Swarm notebook,
							the Chief notebook and the Assistant notebook. Put their numbers in the swarm workflow&apos;s <Code>LEDGER_ISSUE</Code>,{" "}
							<Code>NOTEBOOK_ISSUE</Code>, <Code>CHIEF_ISSUE</Code> and <Code>ASSISTANT_ISSUE</Code>.
						</>,
						<>
							<span className="font-medium text-foreground">The relay.</span> Deploy the{" "}
							<a href={RELAY} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">Cloudflare Worker</a>, map
							your protocol repository to the proofs repository in its <Code>TARGETS</Code>, and add a <Code>push</Code> webhook on the protocol
							repository. Every push then reconciles the spec, and the Worker also keeps the swarm&apos;s 30-minute clock.
						</>,
					].map((body, i) => (
						<li key={i} className="flex gap-3">
							<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium tabular-nums text-foreground">{i + 1}</span>
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
