import { useEffect, useMemo, useState } from "react";
import { notify } from "@/lib/notifications";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { SwarmCost, SwarmRole, SwarmState } from "@/lib/swarm";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const usd = (n: number) => `$${n.toFixed(2)}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

function sumBy(costs: SwarmCost[], key: (c: SwarmCost) => string) {
	const totals = new Map<string, number>();
	for (const c of costs) totals.set(key(c), (totals.get(key(c)) ?? 0) + c.usd);
	return [...totals].sort((a, b) => b[1] - a[1]);
}

/** Historical spend: every cost line the swarm wrote to its ledger issue, by day, role and project. */
export function UsagePage() {
	const [costs, setCosts] = useState<SwarmCost[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [range, setRange] = useState<Range>(30);

	useEffect(() => {
		fetch("/api/swarm/state")
			.then(async (res) => {
				const body = await res.json();
				if (!res.ok) throw new Error(body.error ?? res.statusText);
				setCosts((body as SwarmState).costs);
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
		for (let i = range - 1; i >= 0; i--) days.push({ date: day(new Date(today.getTime() - i * 86_400_000)), usd: 0 });
		const index = new Map(days.map((d, i) => [d.date, i]));
		const inRange = (costs ?? []).filter((c) => index.has(c.createdAt.slice(0, 10)));
		for (const c of inRange) days[index.get(c.createdAt.slice(0, 10))!].usd += c.usd;
		const total = inRange.reduce((s, c) => s + c.usd, 0);
		return { days, inRange, total, peak: Math.max(0.01, ...days.map((d) => d.usd)) };
	}, [costs, range]);

	const byRole = sumBy(inRange, (c) => c.role);
	const byRepo = sumBy(inRange, (c) => c.repo || "unknown");
	const allTime = (costs ?? []).reduce((s, c) => s + c.usd, 0);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<main className="mx-auto w-full max-w-4xl space-y-6 px-4 pb-6">
				{error ? <p className="text-sm text-destructive">{error}</p> : null}
				<div className="flex flex-wrap items-end justify-between gap-4">
					<div>
						<p className="text-sm text-muted-foreground">Spent in the last {range} days</p>
						<p className="text-3xl font-semibold tabular-nums">{costs ? usd(total) : "…"}</p>
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

				<section className="rounded-xl border p-4">
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
					<div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
						<span>{days[0]?.date}</span>
						<span>peak {usd(peak === 0.01 ? 0 : peak)} / day</span>
						<span>{days.at(-1)?.date}</span>
					</div>
				</section>

				<div className="grid gap-4 sm:grid-cols-2">
					<Breakdown title="By role" rows={byRole} total={total} color={(k) => ROLE_COLORS[k as SwarmRole]} />
					<Breakdown title="By project" rows={byRepo} total={total} />
				</div>

				<section className="rounded-xl border">
					<h2 className="border-b px-4 py-2 text-sm font-medium">Runs</h2>
					{inRange.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">No runs in this range.</p>
					) : (
						<ul className="max-h-96 divide-y overflow-y-auto text-sm">
							{[...inRange].reverse().map((c, i) => (
								<li key={`${c.createdAt}-${i}`} className="flex items-center gap-3 px-4 py-2">
									<span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">{c.createdAt.slice(0, 16).replace("T", " ")}</span>
									<span className="min-w-0 flex-1 truncate">
										{c.role}
										{c.ref ? <span className="text-muted-foreground"> on #{c.ref}</span> : null}
										<span className="text-muted-foreground"> · {c.repo}</span>
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
			<h2 className="mb-3 text-sm font-medium">{title}</h2>
			{rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : null}
			<ul className="space-y-2 text-sm">
				{rows.map(([key, value]) => (
					<li key={key}>
						<div className="flex justify-between gap-2">
							<span className="truncate">{key}</span>
							<span className="tabular-nums">{usd(value)}</span>
						</div>
						<div className="mt-1 h-1.5 rounded-full bg-muted">
							<div className="h-full rounded-full bg-foreground/70" style={{ width: `${total ? (value / total) * 100 : 0}%`, background: color?.(key) }} />
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
