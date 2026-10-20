import { useEffect, useMemo, useState } from "react";
import { Download, GitFork, Star } from "lucide-react";
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

/** The ledger names a run by its job (prove, review, ...); colour each by the agent that does it. */
const LEDGER_ROLES: Record<string, SwarmRole> = { plan: "planner", prove: "prover", rebuild: "rebuilder", review: "reviewer", merge: "merger", edit: "editor", chief: "chief", assist: "assistant", answer: "assistant" };
const roleColor = (role: string) => ROLE_COLORS[(LEDGER_ROLES[role] ?? role) as SwarmRole] ?? "hsl(var(--muted-foreground))";
const PAGE = 8;

/** A shimmering block the exact size of what it stands in for, so nothing moves when the data lands. */
const Bone = ({ className = "" }: { className?: string }) => <span className={`fm-shimmer inline-block rounded ${className}`} aria-hidden />;

const Label = ({ children }: { children: React.ReactNode }) => (
	<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</p>
);

/** As in the reference: a gray container carrying the title, and the content on a white card inside it. */
function Card({ label, action, children, className = "", bodyClassName = "p-4" }: { label: string; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
	return (
		<section className={`flex flex-col rounded-2xl border bg-muted/60 p-1.5 ${className}`}>
			<header className="flex h-9 shrink-0 items-center justify-between gap-2 pl-2.5 pr-1">
				<Label>{label}</Label>
				{action}
			</header>
			<div className={`shadow-card flex min-h-0 flex-1 flex-col rounded-xl border bg-card ${bodyClassName}`}>{children}</div>
		</section>
	);
}

/** Up or down against the previous period of the same length. */
function Delta({ now, before }: { now: number; before: number }) {
	if (before === 0 && now === 0) return <span className="font-mono text-xs text-muted-foreground">no change</span>;
	const pct = before === 0 ? 100 : ((now - before) / before) * 100;
	const up = pct >= 0;
	return (
		<span className={`rounded-md px-1.5 py-0.5 font-mono text-xs font-medium ${up ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-red-500/10 text-red-700 dark:text-red-400"}`}>
			{up ? "↗" : "↘"} {Math.abs(pct).toFixed(1)}%
		</span>
	);
}

/** A smooth path through the points (monotone cubic, Fritsch–Carlson): no overshoot between days. */
function smoothPath(pts: [number, number][]) {
	if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
	const n = pts.length;
	const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
	const slope = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
	const m = pts.map((_, i) => (i === 0 ? slope[0] : i === n - 1 ? slope[n - 2] : slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2));
	for (let i = 0; i < n - 1; i++) {
		if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
		const a = m[i] / slope[i], b = m[i + 1] / slope[i], h = Math.hypot(a, b);
		if (h > 3) { m[i] = (3 * a * slope[i]) / h; m[i + 1] = (3 * b * slope[i]) / h; }
	}
	let d = `M${pts[0][0]},${pts[0][1]}`;
	for (let i = 0; i < n - 1; i++) {
		const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i] / 3;
		d += ` C${x0 + h},${y0 + m[i] * h} ${x1 - h},${y1 - m[i + 1] * h} ${x1},${y1}`;
	}
	return d;
}

function Sparkline({ values }: { values: number[] }) {
	const max = Math.max(0.01, ...values);
	const d = smoothPath(values.map((v, i) => [(i / Math.max(1, values.length - 1)) * 100, 28 - (v / max) * 26]));
	return (
		<svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-24" aria-hidden>
			<path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="text-foreground/70" />
		</svg>
	);
}

function MiniBars({ values }: { values: number[] }) {
	const last = values.slice(-8);
	const max = Math.max(1, ...last);
	return (
		<div className="flex h-8 items-end gap-0.5" aria-hidden>
			{last.map((v, i) => (
				<span key={i} className={`w-1.5 rounded-sm ${i === last.length - 1 ? "bg-foreground" : "bg-foreground/25"}`} style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
			))}
		</div>
	);
}

/** Daily spend as a line with an area under it; hovering a day shows its total and runs. */
function TrendChart({ days }: { days: { date: string; usd: number; runs: number }[] }) {
	const [hover, setHover] = useState<number | null>(null);
	const max = Math.max(0.01, ...days.map((d) => d.usd));
	const top = Math.ceil(max * 1.15 * 100) / 100;
	const x = (i: number) => (i / Math.max(1, days.length - 1)) * 100;
	const y = (v: number) => 100 - (v / top) * 100;
	const line = smoothPath(days.map((d, i) => [x(i), y(d.usd)]));
	const h = hover !== null ? days[hover] : null;
	return (
		<div className="relative h-56 pl-10" onMouseLeave={() => setHover(null)}>
			{[0, 0.5, 1].map((f) => (
				<div key={f} className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${(1 - f) * 100}%` }}>
					<span className="absolute -top-2 left-0 font-mono text-[10px] text-muted-foreground">{usd(top * f)}</span>
				</div>
			))}
			<svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-y-0 left-10 right-0 h-full w-[calc(100%-2.5rem)] overflow-visible" aria-hidden>
				<path d={`${line} L100,100 L0,100 Z`} className="fill-foreground/[0.06]" />
				<path d={line} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="text-foreground" />
			</svg>
			<div className="absolute inset-y-0 left-10 right-0 flex">
				{days.map((d, i) => (
					<div key={d.date} className="relative flex-1" onMouseEnter={() => setHover(i)}>
						{hover === i ? (
							<>
								<div className="absolute inset-y-0 left-1/2 w-px bg-foreground/15" />
								<div className="absolute left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-card" style={{ top: `${y(d.usd)}%` }} />
							</>
						) : null}
					</div>
				))}
			</div>
			{h && hover !== null ? (
				<div className="shadow-pop pointer-events-none absolute top-2 z-10 rounded-xl bg-popover px-3 py-2 text-xs" style={{ left: `calc(2.5rem + ${x(hover)}% * (100% - 2.5rem) / 100%)`, transform: `translateX(${x(hover) > 70 ? "-105%" : "8px"})` }}>
					<p className="font-medium">{h.date}</p>
					<p className="mt-1 flex justify-between gap-4 font-mono"><span className="text-muted-foreground">spent</span>{usd(h.usd)}</p>
					<p className="flex justify-between gap-4 font-mono"><span className="text-muted-foreground">runs</span>{h.runs}</p>
				</div>
			) : null}
		</div>
	);
}

/** Runs per day, a column per week, like GitHub's contribution graph. */
function Heatmap({ costs }: { costs: SwarmCost[] }) {
	const weeks = 13;
	const today = new Date();
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (weeks - 1) * 7);
	const counts = new Map<string, number>();
	for (const c of costs) counts.set(day(new Date(c.createdAt)), (counts.get(day(new Date(c.createdAt))) ?? 0) + 1);
	const cells = Array.from({ length: weeks * 7 }, (_, i) => {
		const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
		return { date: day(d), runs: counts.get(day(d)) ?? 0, future: d > today };
	});
	const max = Math.max(1, ...cells.map((c) => c.runs));
	const level = (n: number) => (n === 0 ? 0 : Math.ceil((n / max) * 4));
	const shade = ["bg-muted", "bg-foreground/20", "bg-foreground/40", "bg-foreground/65", "bg-foreground/90"];
	return (
		<div>
			<div className="grid grid-flow-col grid-rows-7 gap-1">
				{cells.map((c) => (
					<span key={c.date} title={`${c.date}: ${c.runs} runs`} className={`aspect-square rounded-[3px] ${c.future ? "opacity-0" : shade[level(c.runs)]}`} />
				))}
			</div>
			<div className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground">
				Less {shade.map((s) => <span key={s} className={`size-2.5 rounded-[2px] ${s}`} />)} More
			</div>
		</div>
	);
}

function toCsv(costs: SwarmCost[]) {
	const rows = [["time", "role", "ref", "repo", "usd"], ...costs.map((c) => [c.createdAt, c.role, c.ref, c.repo, c.usd.toFixed(4)])];
	return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
}

/** Historical spend: every cost line the swarm recorded, by day, role and project. */
export function UsagePage() {
	const [costs, setCosts] = useState<SwarmCost[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [range, setRange] = useState<Range>(30);
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(0);

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
				setCosts([]);
				notify.error("Could not load usage", { id: "usage", description: message });
			});
	}, []);

	const s = useMemo(() => {
		const all = costs ?? [];
		const today = new Date();
		const dayAt = (back: number) => day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
		const days = Array.from({ length: range }, (_, i) => ({ date: dayAt(range - 1 - i), usd: 0, runs: 0 }));
		const index = new Map(days.map((d, i) => [d.date, i]));
		const prevStart = dayAt(2 * range - 1);
		const prevEnd = dayAt(range);
		let prev = 0;
		let prevRuns = 0;
		const inRange: SwarmCost[] = [];
		for (const c of all) {
			const d = day(new Date(c.createdAt));
			const i = index.get(d);
			if (i !== undefined) {
				days[i].usd += c.usd;
				days[i].runs += 1;
				inRange.push(c);
			} else if (d >= prevStart && d <= prevEnd) {
				prev += c.usd;
				prevRuns += 1;
			}
		}
		const total = inRange.reduce((t, c) => t + c.usd, 0);
		const peak = days.reduce((a, b) => (b.usd > a.usd ? b : a), days[0]);
		return {
			days, inRange, total, prev, prevRuns, peak,
			today: days.at(-1)!,
			allTime: all.reduce((t, c) => t + c.usd, 0),
			byRole: sumBy(inRange, (c) => c.role),
			byRepo: sumBy(inRange, (c) => c.repo || "unknown"),
		};
	}, [costs, range]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const rows = [...s.inRange].reverse();
		return q ? rows.filter((c) => `${c.role} ${c.ref} ${c.repo}`.toLowerCase().includes(q)) : rows;
	}, [s.inRange, query]);
	const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
	const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
	useEffect(() => setPage(0), [query, range]);

	const ready = costs !== null;
	const exportCsv = () => {
		const url = URL.createObjectURL(new Blob([toCsv(s.inRange)], { type: "text/csv" }));
		const a = Object.assign(document.createElement("a"), { href: url, download: `formal-mind-usage-${range}d.csv` });
		a.click();
		URL.revokeObjectURL(url);
	};

	const stats: { label: string; value: string; side: React.ReactNode; foot: React.ReactNode }[] = [
		{ label: "Spent", value: usd(s.total), side: <Sparkline values={s.days.map((d) => d.usd)} />, foot: <><Delta now={s.total} before={s.prev} /><span>vs previous {range} days</span></> },
		{ label: "Runs", value: String(s.inRange.length), side: <MiniBars values={s.days.map((d) => d.runs)} />, foot: <><Delta now={s.inRange.length} before={s.prevRuns} /><span>vs previous {range} days</span></> },
		{ label: "Per run", value: usd(s.inRange.length ? s.total / s.inRange.length : 0), side: null, foot: <span>average cost of one agent turn</span> },
		{ label: "Today", value: usd(s.today.usd), side: null, foot: <span>{s.today.runs} runs · {usd(s.allTime)} all time</span> },
	];

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<main className="mx-auto w-full max-w-6xl space-y-4 px-6 pb-10 pt-4">
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
						<p className="mt-1 text-sm text-muted-foreground">What the swarm spent, and on what.</p>
					</div>
					<div className="flex items-center gap-2">
						<div className="inline-flex rounded-xl bg-muted p-1 text-sm">
							{RANGES.map((r) => (
								<button key={r} type="button" onClick={() => setRange(r)} className={`rounded-lg px-3 py-1 ${r === range ? "shadow-card bg-background font-medium" : "text-muted-foreground hover:text-foreground"}`}>
									{r === 7 ? "7 days" : r === 30 ? "30 days" : "90 days"}
								</button>
							))}
						</div>
						<button type="button" onClick={exportCsv} disabled={!ready || s.inRange.length === 0} className="btn-dark h-9 gap-2 px-3 text-sm disabled:opacity-50">
							<Download className="size-4" /> Export CSV
						</button>
					</div>
				</div>
				{error ? <p className="text-sm text-destructive">{error}</p> : null}

				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{stats.map((st) => (
						<section key={st.label} className="rounded-2xl border bg-muted/60 p-1.5">
							<div className="shadow-card rounded-xl border bg-card px-4 py-3">
								<Label>{st.label}</Label>
								<div className="mt-2 flex h-9 items-center justify-between gap-2">
									{ready ? <span className="font-mono text-2xl font-medium tabular-nums">{st.value}</span> : <Bone className="h-7 w-28" />}
									{ready ? st.side : null}
								</div>
							</div>
							<div className="flex h-8 items-center gap-2 px-3 text-xs text-muted-foreground">{ready ? st.foot : <Bone className="h-3 w-40" />}</div>
						</section>
					))}
				</div>

				<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
					<Card label="Spend trend">
						<div className="mb-4 flex items-baseline gap-3">
							{ready ? <span className="font-mono text-xl font-medium tabular-nums">{usd(s.total)}</span> : <Bone className="h-6 w-24" />}
							<span className="text-xs text-muted-foreground">over {range} days</span>
						</div>
						{ready ? <TrendChart days={s.days} /> : <Bone className="h-56 w-full rounded-lg" />}
						<div className="mt-4 grid grid-cols-3 divide-x rounded-xl border text-sm">
							{[
								["Avg / day", usd(s.total / range)],
								["Busiest day", s.peak.usd > 0 ? s.peak.date : "—"],
								["All time", usd(s.allTime)],
							].map(([k, v]) => (
								<div key={k} className="px-4 py-2.5">
									<p className="text-xs text-muted-foreground">{k}</p>
									<p className="mt-0.5 h-5 font-mono tabular-nums">{ready ? v : <Bone className="h-4 w-20" />}</p>
								</div>
							))}
						</div>
					</Card>

					<Card label="By agent">
						{/* One rounded segment per agent with an even gap: widths come from flex-grow, so the gaps never overflow. */}
						<div className="flex h-2 gap-1">
							{ready && s.total > 0 ? (
								s.byRole.map(([k, v]) => (
									<span
										key={k}
										title={`${k}: ${usd(v)}`}
										className="min-w-1 basis-0 rounded-full transition-[flex-grow] duration-500 ease-out motion-reduce:transition-none"
										style={{ flexGrow: v, background: roleColor(k) }}
									/>
								))
							) : (
								<span className={`flex-1 rounded-full ${ready ? "bg-muted" : "fm-shimmer"}`} />
							)}
						</div>
						<ul className="mt-4 space-y-0.5 text-sm">
							{ready
								? s.byRole.map(([k, v]) => (
										<li key={k} className="flex h-9 items-center gap-2 border-b last:border-0">
											<span className="size-2 rounded-sm" style={{ background: roleColor(k) }} />
											<span className="flex-1 capitalize">{k}</span>
											<span className="font-mono tabular-nums">{usd(v)}</span>
											<span className="w-10 text-right font-mono text-xs text-muted-foreground">{s.total ? Math.round((v / s.total) * 100) : 0}%</span>
										</li>
									))
								: Array.from({ length: 5 }, (_, i) => (
										<li key={i} className="flex h-9 items-center gap-2"><Bone className="h-3 w-full" /></li>
									))}
							{ready && s.byRole.length === 0 ? <li className="py-2 text-muted-foreground">Nothing in this range.</li> : null}
						</ul>
					</Card>
				</div>

				<div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
					<Card
						label="Runs"
						action={
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search runs…"
								className="h-7 w-48 rounded-lg border bg-transparent px-2.5 text-xs outline-none focus:border-foreground/30"
							/>
						}
						bodyClassName="p-0 overflow-hidden"
					>
						<div className="grid grid-cols-[8.5rem_1fr_5rem] gap-4 border-b px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
							<span>Time</span>
							<span>Agent · item · project</span>
							<span className="text-right">Cost</span>
						</div>
						<ul className="divide-y text-sm">
							{ready
								? shown.map((c, i) => (
										<li key={`${c.createdAt}-${i}`} className="grid h-11 grid-cols-[8.5rem_1fr_5rem] items-center gap-4 px-4">
											<span className="font-mono text-xs text-muted-foreground tabular-nums">{localTime(c.createdAt)}</span>
											<span className="flex min-w-0 items-center gap-2 truncate">
												<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
													<span className="size-1.5 rounded-full" style={{ background: roleColor(c.role) }} />
													{c.role}
												</span>
												{c.ref ? <RefCard repo={c.repo} ref_={c.ref} /> : null}
												<span className="truncate"><RepoCard repo={c.repo} /></span>
											</span>
											<span className="text-right font-mono tabular-nums">{usd(c.usd)}</span>
										</li>
									))
								: Array.from({ length: PAGE }, (_, i) => (
										<li key={i} className="flex h-11 items-center px-4"><Bone className="h-3 w-full" /></li>
									))}
							{ready && shown.length === 0 ? <li className="flex h-11 items-center px-4 text-muted-foreground">{query ? "No runs match." : "No runs in this range."}</li> : null}
						</ul>
						<div className="flex h-12 items-center justify-between border-t px-4 text-xs text-muted-foreground">
							<span>{ready ? `${filtered.length} runs` : ""}</span>
							<div className="flex items-center gap-1">
								<button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded-md border px-2 py-1 disabled:opacity-40">Previous</button>
								<span className="px-2 font-mono">{page + 1} / {pages}</span>
								<button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded-md border px-2 py-1 disabled:opacity-40">Next</button>
							</div>
						</div>
					</Card>

					<div className="space-y-4">
						<Card label="Activity">
							<p className="text-xs text-muted-foreground">Runs per day, last 13 weeks</p>
							<div className="mt-3">{ready ? <Heatmap costs={costs ?? []} /> : <Bone className="aspect-[13/7] w-full rounded-lg" />}</div>
						</Card>
						<Card label="By project">
							<ul className="space-y-0.5 text-sm">
								{ready
									? s.byRepo.map(([k, v]) => (
											<li key={k} className="flex h-9 items-center gap-2 border-b last:border-0">
												<span className="flex-1 truncate"><RepoCard repo={k} /></span>
												<span className="font-mono tabular-nums">{usd(v)}</span>
											</li>
										))
									: Array.from({ length: 2 }, (_, i) => <li key={i} className="flex h-9 items-center"><Bone className="h-3 w-full" /></li>)}
								{ready && s.byRepo.length === 0 ? <li className="py-2 text-muted-foreground">Nothing in this range.</li> : null}
							</ul>
						</Card>
					</div>
				</div>
			</main>
		</div>
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
	const number = Number(ref_.replace(/^#+/, ""));
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
