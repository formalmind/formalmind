"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { FilterIcon } from "@primer/octicons-react";
import type { ProjectData } from "@/lib/project";
import { matchesFilter } from "./project-meta";
import { ProjectRoadmap } from "./project-roadmap";
import { RoadmapSkeleton } from "./roadmap-skeleton";

const POLL_MS = 30_000;

/** A GitHub Projects-style roadmap over the proofs repository. The swarm canvas is the board. */
export function ProjectView({ repo, now }: { repo: string; now?: number }) {
	const [data, setData] = useState<ProjectData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [query, setQuery] = useState("");

	const load = async (quiet = false) => {
		if (!quiet) setLoading(true);
		try {
			const res = await fetch("/api/project");
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? res.statusText);
			setData(body);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load the project.");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void load(true);
		}, POLL_MS);
		return () => clearInterval(timer);
	}, []);

	const items = data?.items.filter((item) => matchesFilter(item, query)) ?? [];
	const open = data?.items.filter((item) => item.state === "open").length ?? 0;
	const done = data?.milestones.filter((m) => m.done).length ?? 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col p-4 sm:p-6">
			<div className="flex items-start gap-3">
				{/* The counts sit under the title, so a narrow window never squeezes them beside it. */}
				<div className="min-w-0">
					<h1 className="truncate text-sm font-semibold">{repo}</h1>
					<p className="text-sm text-muted-foreground">
						{data ? `${data.items.length} items · ${open} open · roadmap ${done}/${data.milestones.length} done` : error ?? <span className="fm-shimmer mt-1 inline-block h-3.5 w-56 rounded align-middle" aria-label="Loading" />}
					</p>
				</div>
				<button
					type="button"
					onClick={() => void load()}
					className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
				>
					<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
					Refresh
				</button>
			</div>

			<label className="mt-4 flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-sm focus-within:ring-2 focus-within:ring-ring">
				<FilterIcon size={14} className="text-muted-foreground" />
				<input
					value={query}
					aria-label="Filter items"
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter by keyword or by field, e.g. is:open status:in-progress label:fm:todo roadmap:6"
					className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
				/>
				{query ? (
					<button type="button" onClick={() => setQuery("")} aria-label="Clear filter" className="text-muted-foreground hover:text-foreground">
						<X className="size-3.5" />
					</button>
				) : null}
			</label>

			<div className="mt-3 min-h-[480px] flex-1">
				{data ? (
					<ProjectRoadmap repo={repo} items={items} milestones={data.milestones} now={now} />
				) : (
					<RoadmapSkeleton />
				)}
			</div>
		</div>
	);
}
