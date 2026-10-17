"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { CheckCircleFillIcon, MilestoneIcon } from "@primer/octicons-react";
import type { ProjectItem, ProjectMilestone } from "@/lib/project";
import { PROJECT_STATUSES, type ProjectStatus } from "@/lib/project-statuses";
import { ItemStateIcon, STATUS_STYLES, StatusDot, useItemHover } from "./project-meta";

/**
 * The Roadmap layout of a GitHub project: items as bars on a timeline, from when they were
 * opened to when they merged or closed (open work runs to today), grouped by roadmap item or Status.
 */

export type RoadmapZoom = "day" | "week" | "month";
export type RoadmapGroup = "milestone" | "status" | "none";

const DAY = 86_400_000;
const PX_PER_DAY: Record<RoadmapZoom, number> = { day: 960, week: 180, month: 48 };
/** Days of empty timeline after the last item, so there is room to read the end of the bars. */
const TAIL_DAYS: Record<RoadmapZoom, number> = { day: 1, week: 7, month: 30 };
const LEFT = 320;
const ROW = 36;

type Group = { key: string; title: React.ReactNode; count: number; items: ProjectItem[] };

function startOfDay(t: number) {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function ticksFor(zoom: RoadmapZoom, start: number, end: number) {
	const major: { at: number; label: string }[] = [];
	const minor: { at: number; label: string }[] = [];
	for (let day = start; day < end; day = startOfDay(day + DAY * 1.5)) {
		const d = new Date(day);
		if (zoom === "day") {
			major.push({ at: day, label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) });
			for (let h = 0; h < 24; h += 3) minor.push({ at: day + h * 3_600_000, label: `${String(h).padStart(2, "0")}:00` });
		} else {
			if (d.getDate() === 1 || day === start) major.push({ at: day, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) });
			minor.push({ at: day, label: zoom === "week" ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : String(d.getDate()) });
		}
	}
	return { major, minor };
}

export function ProjectRoadmap({ repo, items, milestones, now = Date.now() }: {
	repo: string;
	items: ProjectItem[];
	milestones: ProjectMilestone[];
	/** Pinned in stories so the timeline renders the same every time. */
	now?: number;
}) {
	const [zoom, setZoom] = useState<RoadmapZoom>("week");
	const [groupBy, setGroupBy] = useState<RoadmapGroup>("milestone");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);
	const { bind, card } = useItemHover(repo);

	const ends = (item: ProjectItem) => (item.closedAt ? Date.parse(item.closedAt) : now);
	const start = startOfDay(Math.min(now, ...items.map((i) => Date.parse(i.createdAt))));
	const end = startOfDay(Math.max(now, ...items.map(ends)) + DAY * (TAIL_DAYS[zoom] + 1));
	const px = PX_PER_DAY[zoom];
	const x = (t: number) => ((t - start) / DAY) * px;
	const width = x(end);
	const ticks = useMemo(() => ticksFor(zoom, start, end), [zoom, start, end]);

	const groups: Group[] = useMemo(() => {
		const sorted = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
		if (groupBy === "none") return [{ key: "all", title: "All items", count: sorted.length, items: sorted }];
		if (groupBy === "status") {
			return PROJECT_STATUSES.map((s) => {
				const inGroup = sorted.filter((i) => i.status === s.key);
				return { key: s.key, title: <><StatusDot status={s.key} />{s.name}</>, count: inGroup.length, items: inGroup };
			}).filter((g) => g.count);
		}
		const byMilestone: Group[] = milestones.map((m) => {
			const inGroup = sorted.filter((i) => i.milestone === m.number);
			return {
				key: `m${m.number}`,
				title: (
					<>
						{m.done ? <CheckCircleFillIcon size={14} className="text-violet-600 dark:text-violet-400" aria-label="Done" /> : <MilestoneIcon size={14} className="text-muted-foreground" />}
						<span className="truncate" title={m.summary}>{m.number}. {m.title}</span>
					</>
				),
				count: inGroup.length,
				items: inGroup,
			};
		});
		const rest = sorted.filter((i) => !milestones.some((m) => m.number === i.milestone));
		return [...byMilestone.filter((g) => g.count), { key: "none", title: <span className="text-muted-foreground">No roadmap item</span>, count: rest.length, items: rest }].filter((g) => g.count);
	}, [items, milestones, groupBy]);

	const scrollToToday = () => {
		const el = scrollRef.current;
		if (el) el.scrollTo({ left: Math.max(0, x(now) + LEFT - el.clientWidth * 0.75), behavior: "smooth" });
	};
	// Open on today, the way GitHub does.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(scrollToToday, [zoom]);

	const toggle = (key: string) => setCollapsed((prev) => {
		const next = new Set(prev);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		return next;
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex flex-wrap items-center gap-2 pb-3 text-xs">
				<Segmented label="Group by" value={groupBy} onChange={setGroupBy} options={[["milestone", "Roadmap item"], ["status", "Status"], ["none", "None"]]} />
				<Segmented label="Zoom" value={zoom} onChange={setZoom} options={[["day", "Day"], ["week", "Week"], ["month", "Month"]]} />
				<button type="button" onClick={scrollToToday} className="h-7 rounded-md border px-2.5 font-medium transition-colors hover:bg-muted">Today</button>
				<span className="ml-auto text-muted-foreground">Bars run from opened to merged or closed; open work runs to today.</span>
			</div>

			<div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto rounded-lg border">
				<div style={{ width: LEFT + width }} className="relative">
					<div className="sticky top-0 z-20 flex border-b bg-background">
						<div style={{ width: LEFT }} className="sticky left-0 z-10 flex shrink-0 items-end border-r bg-background px-3 pb-1.5 text-xs font-medium text-muted-foreground">Title</div>
						<div style={{ width }} className="relative h-12 shrink-0 text-[11px] text-muted-foreground">
							{ticks.major.map((t) => (
								<span key={`M${t.at}`} style={{ left: x(t.at) }} className="absolute top-1 whitespace-nowrap border-l pl-1.5 font-medium text-foreground">{t.label}</span>
							))}
							{ticks.minor.map((t) => (
								<span key={`m${t.at}`} style={{ left: x(t.at) }} className="absolute bottom-1 whitespace-nowrap pl-1 tabular-nums">{t.label}</span>
							))}
							<span style={{ left: x(now) }} className="absolute top-1 -translate-x-1/2 rounded bg-red-500 px-1.5 text-[10px] font-medium text-white">Today</span>
						</div>
					</div>

					<div aria-hidden className="pointer-events-none absolute bottom-0 top-12" style={{ left: LEFT, width }}>
						{ticks.minor.map((t) => <span key={t.at} style={{ left: x(t.at) }} className="absolute inset-y-0 border-l border-border/50" />)}
						<span style={{ left: x(now) }} className="absolute inset-y-0 border-l-2 border-red-500/60" />
					</div>

					{groups.map((group) => {
						const open = !collapsed.has(group.key);
						const from = Math.min(...group.items.map((i) => Date.parse(i.createdAt)));
						const to = Math.max(...group.items.map(ends));
						return (
							<Fragment key={group.key}>
								{groupBy !== "none" ? (
									<div className="relative flex border-b bg-muted/40" style={{ height: ROW }}>
										<button
											type="button"
											onClick={() => toggle(group.key)}
											aria-expanded={open}
											style={{ width: LEFT }}
											className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r bg-muted px-2 text-left text-xs font-semibold"
										>
											{open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
											{group.title}
											<span className="ml-auto rounded-full bg-background px-1.5 font-normal tabular-nums text-muted-foreground">{group.count}</span>
										</button>
										<div className="relative shrink-0" style={{ width }}>
											<span style={{ left: x(from), width: Math.max(x(to) - x(from), 4) }} className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-foreground/25" />
										</div>
									</div>
								) : null}
								{open ? group.items.map((item) => (
									<RoadmapRow key={item.number} item={item} from={x(Date.parse(item.createdAt))} to={x(ends(item))} width={width} ongoing={!item.closedAt} bind={bind(item)} />
								)) : null}
							</Fragment>
						);
					})}
					{!items.length ? <p className="sticky left-0 p-6 text-sm text-muted-foreground">No items match this filter.</p> : null}
				</div>
			</div>
			{card}
		</div>
	);
}

function RoadmapRow({ item, from, to, width, ongoing, bind }: {
	item: ProjectItem;
	from: number;
	to: number;
	width: number;
	ongoing: boolean;
	bind: ReturnType<ReturnType<typeof useItemHover>["bind"]>;
}) {
	const barWidth = Math.max(to - from, 6);
	const inside = barWidth > 140;
	const style = STATUS_STYLES[item.status as ProjectStatus];
	return (
		<div className="group relative flex border-b hover:bg-muted/30" style={{ height: ROW }}>
			<a
				href={item.url}
				target="_blank"
				rel="noreferrer"
				style={{ width: LEFT }}
				className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r bg-background px-3 text-sm group-hover:bg-muted"
				{...bind}
			>
				<ItemStateIcon item={item} size={14} />
				<span className="truncate">{item.title}</span>
				<span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">#{item.number}</span>
			</a>
			<div className="relative shrink-0" style={{ width }}>
				<a
					href={item.url}
					target="_blank"
					rel="noreferrer"
					tabIndex={-1}
					aria-label={`${item.title} #${item.number}`}
					style={{ left: from, width: barWidth }}
					className={`absolute top-1.5 flex h-6 items-center overflow-hidden rounded-md border px-2 text-xs ${style.bar} ${ongoing ? "rounded-r-none border-r-2 border-dashed" : ""}`}
					{...bind}
				>
					{inside ? <span className="truncate">{item.title}</span> : null}
				</a>
				{!inside ? (
					<span style={{ left: from + barWidth + 6 }} className="pointer-events-none absolute top-1/2 max-w-[360px] -translate-y-1/2 truncate whitespace-nowrap text-xs text-muted-foreground">
						{item.title}
					</span>
				) : null}
			</div>
		</div>
	);
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
	return (
		<div role="radiogroup" aria-label={label} className="flex items-center gap-1">
			<span className="text-muted-foreground">{label}</span>
			<span className="inline-flex rounded-md border p-0.5">
				{options.map(([key, name]) => (
					<button
						key={key}
						type="button"
						role="radio"
						aria-checked={value === key}
						onClick={() => onChange(key)}
						className={`h-6 rounded px-2 font-medium transition-colors ${value === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
					>
						{name}
					</button>
				))}
			</span>
		</div>
	);
}
