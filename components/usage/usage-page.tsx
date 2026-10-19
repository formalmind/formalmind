import { useEffect, useMemo, useState } from "react";
import { GitFork, Star } from "lucide-react";
import { notify } from "@/lib/notifications";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { SwarmCost, SwarmItem, SwarmRole } from "@/lib/swarm";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ItemPreview } from "@/components/swarm/swarm-canvas";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const usd = (n: number) => `$${n.toFixed(2)}`;
/** A date's day in the viewer's own timezone (YYYY-MM-DD), so "today" matches their clock rather than UTC's. */
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localTime = (iso: string) => {
	const d = new Date(iso);
	return `${day(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function sumBy(costs: SwarmCost[], key: (c: SwarmCost) => string) {
	const totals = new Map<string, number>();
	for (const c of costs) totals.set(key(c), (totals.get(key(c)) ?? 0) + c.usd);
	return [...totals].sort((a, b) => b[1] - a[1]);
}

/** Historical spend: every cost line the swarm wrote to its ledger issue, by day, role and project. */

/** The ledger names a run by its job (prove, review, ...); colour each by the agent that does it. */
const LEDGER_ROLES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", rebuild: "rebuilder", review: "reviewer", merge: "merger", edit: "editor", chief: "chief", assist: "assistant", answer: "assistant" };
export function UsagePage() {
	const [costs, setCosts] = useState<SwarmCost[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [range, setRange] = useState<Range>(30);

	useEffect(() => {
		// Spend is kept on Cloudflare (the Project Durable Object), so this page works while GitHub is unreachable.
		fetch("/api/usage")
			.then(async (res) => {
				const body = await res.json();
				if (!res.ok) throw new Error(body.error ?? res.statusText);
				setCosts((body as { costs: SwarmCost[] }).costs);
			})
			.catch((err) => {
				const message = err instanceof Error ? err.message : "Could not load usage.";
				setError(message);
				notify.error("Could not load usage", { id: "usage", description: message });
			});
	}, []);

	const { days, inRange, total, peak } = useMemo(() => {
		const days: { date: string; usd: number }[] = [];
		const today = new Date();
		for (let i = range - 1; i >= 0; i--) days.push({ date: day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)), usd: 0 });
		const index = new Map(days.map((d, i) => [d.date, i]));
		const inRange = (costs ?? []).filter((c) => index.has(day(new Date(c.createdAt))));
		for (const c of inRange) days[index.get(day(new Date(c.createdAt)))!].usd += c.usd;
		const total = inRange.reduce((s, c) => s + c.usd, 0);
		return { days, inRange, total, peak: Math.max(0.01, ...days.map((d) => d.usd)) };
	}, [costs, range]);

	const byRole = sumBy(inRange, (c) => c.role);
	const byRepo = sumBy(inRange, (c) => c.repo || "unknown");
	const allTime = (costs ?? []).reduce((s, c) => s + c.usd, 0);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<main className="mx-auto w-full max-w-4xl space-y-6 px-6 pb-10 pt-2">
				{error ? <p className="text-sm text-destructive">{error}</p> : null}
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div>
						<p className="text-sm text-muted-foreground">Spent in the last {range} days</p>
						<p className="mt-1 text-3xl font-semibold tabular-nums">{costs ? usd(total) : "…"}</p>
						<p className="mt-1 text-xs text-muted-foreground">
							{costs ? `${inRange.length} runs · ${usd(allTime)} all time` : "Reading the ledger…"}
						</p>
					</div>
					<div className="inline-flex rounded-full border p-0.5 text-sm">
						{RANGES.map((r) => (
							<button
								key={r}
								type="button"
								onClick={() => setRange(r)}
								className={`rounded-full px-3 py-1 ${r === range ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
							>
								{r}d
							</button>
						))}
					</div>
				</div>

				<section className="rounded-xl border p-5">
					<div className="flex h-40 items-end gap-px">
						{days.map((d) => (
							<div key={d.date} className="group relative flex h-full flex-1 items-end" title={`${d.date}: ${usd(d.usd)}`}>
								<div
									className="w-full rounded-t-sm bg-foreground/80 transition-colors group-hover:bg-foreground"
									style={{ height: `${(d.usd / peak) * 100}%`, minHeight: d.usd > 0 ? 2 : 0 }}
								/>
							</div>
						))}
					</div>
					<div className="mt-3 flex justify-between text-xs text-muted-foreground tabular-nums">
						<span>{days[0]?.date}</span>
						<span>peak {usd(peak === 0.01 ? 0 : peak)} / day</span>
						<span>{days.at(-1)?.date}</span>
					</div>
				</section>

				<div className="grid items-start gap-4 sm:grid-cols-2">
					<Breakdown title="By role" rows={byRole} total={total} color={(k) => ROLE_COLORS[(LEDGER_ROLES[k] ?? k) as SwarmRole]} />
					<Breakdown title="By project" rows={byRepo} total={total} />
				</div>

				<section className="rounded-xl border">
					<h2 className="border-b px-5 py-3 text-sm font-medium">Runs</h2>
					{inRange.length === 0 ? (
						<p className="px-5 py-4 text-sm text-muted-foreground">No runs in this range.</p>
					) : (
						<ul className="max-h-96 divide-y overflow-y-auto text-sm">
							{[...inRange].reverse().map((c, i) => (
								<li key={`${c.createdAt}-${i}`} className="flex items-center gap-4 px-5 py-2.5">
									<span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">{localTime(c.createdAt)}</span>
									<span className="min-w-0 flex-1 truncate">
										{c.role}
										{c.ref ? <> <span className="text-muted-foreground">on</span> <RefCard repo={c.repo} ref_={c.ref} /></> : null}
										<span className="text-muted-foreground"> · </span>
										<RepoCard repo={c.repo} />
									</span>
									<span className="tabular-nums">{usd(c.usd)}</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</main>
		</div>
	);
}

function Breakdown({ title, rows, total, color }: { title: string; rows: [string, number][]; total: number; color?: (key: string) => string | undefined }) {
	return (
		<section className="rounded-xl border p-4">
			<h2 className="mb-2.5 text-sm font-medium">{title}</h2>
			{rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : null}
			<ul className="space-y-2 text-sm">
				{rows.map(([key, value]) => (
					<li key={key}>
						<div className="flex justify-between gap-2">
							<span className="truncate">{key}</span>
							<span className="tabular-nums">{usd(value)}</span>
						</div>
						<div className="mt-1 h-1 rounded-full bg-muted">
							<div className="h-full rounded-full bg-foreground/70" style={{ width: `${total ? (value / total) * 100 : 0}%`, background: color?.(key) }} />
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

// Issues and PRs looked up once per page view, shared by every row that names them.
const items = new Map<string, Promise<SwarmItem | null>>();
function loadItem(repo: string, number: number) {
	const key = `${repo}#${number}`;
	if (!items.has(key)) {
		items.set(
			key,
			fetch(`/api/github/item?repo=${encodeURIComponent(repo)}&number=${number}`)
				.then((res) => (res.ok ? (res.json() as Promise<SwarmItem>) : null))
				.catch(() => null),
		);
	}
	return items.get(key)!;
}

/** "#75" with a GitHub-style preview of that issue or PR on hover. */
function RefCard({ repo, ref_ }: { repo: string; ref_: string }) {
	const number = Number(ref_.replace(/^#/, ""));
	const [item, setItem] = useState<SwarmItem | null | undefined>(undefined);
	const url = `https://github.com/${repo}/issues/${number}`;
	if (!Number.isInteger(number) || number < 1) return <span className="text-muted-foreground">{ref_}</span>;
	return (
		<HoverCard openDelay={200} closeDelay={100} onOpenChange={(open) => open && item === undefined && void loadItem(repo, number).then(setItem)}>
			<HoverCardTrigger asChild>
				<a href={item?.url ?? url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground hover:underline">
					#{number}
				</a>
			</HoverCardTrigger>
			<HoverCardContent align="start" className="w-80 p-4">
				{item ? <ItemPreview item={item} repo={repo} /> : (
					<p className="text-xs text-muted-foreground">{item === null ? `Could not load ${repo}#${number}.` : "Loading…"}</p>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}

type RepoSummary = {
	name: string; description: string | null; url: string; stars: number; forks: number; openIssues: number;
	language: string | null; pushedAt: string; private: boolean; owner: { login: string; avatar: string; url: string };
};
const repos = new Map<string, Promise<RepoSummary | null>>();
function loadRepo(repo: string) {
	if (!repos.has(repo)) {
		repos.set(repo, fetch(`/api/github/item?repo=${encodeURIComponent(repo)}`).then((res) => (res.ok ? (res.json() as Promise<RepoSummary>) : null)).catch(() => null));
	}
	return repos.get(repo)!;
}

/** The repository name, with its GitHub profile (owner, description, stars) on hover. */
function RepoCard({ repo }: { repo: string }) {
	const [summary, setSummary] = useState<RepoSummary | null | undefined>(undefined);
	return (
		<HoverCard openDelay={200} closeDelay={100} onOpenChange={(open) => open && summary === undefined && void loadRepo(repo).then(setSummary)}>
			<HoverCardTrigger asChild>
				<a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground hover:underline">
					{repo}
				</a>
			</HoverCardTrigger>
			<HoverCardContent align="start" className="w-80 p-4">
				{summary ? (
					<div>
						<a href={summary.owner.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
							<img src={`${summary.owner.avatar}&s=48`} alt="" className="size-6 rounded-full" />
							{summary.owner.login}
						</a>
						<a href={summary.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm font-semibold hover:underline">
							{summary.name}
							{summary.private ? <span className="ml-2 rounded-full border px-1.5 text-[10px] font-normal text-muted-foreground">Private</span> : null}
						</a>
						{summary.description ? <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{summary.description}</p> : null}
						<div className="mt-3 flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
							{summary.language ? <span>{summary.language}</span> : null}
							<span className="inline-flex items-center gap-1"><Star className="size-3" />{summary.stars}</span>
							<span className="inline-flex items-center gap-1"><GitFork className="size-3" />{summary.forks}</span>
							<span>{summary.openIssues} open</span>
						</div>
					</div>
				) : (
					<p className="text-xs text-muted-foreground">{summary === null ? `Could not load ${repo}.` : "Loading…"}</p>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}
