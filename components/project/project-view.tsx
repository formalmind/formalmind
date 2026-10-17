"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { FilterIcon } from "@primer/octicons-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { ProjectData } from "@/lib/project";
import { matchesFilter } from "./project-meta";
import { ProjectRoadmap } from "./project-roadmap";

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
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<SidebarTrigger className="-ml-1" />
				<h1 className="text-base font-semibold">{repo}</h1>
				<span className="text-sm text-muted-foreground">
					{data ? `${data.items.length} items · ${open} open · roadmap ${done}/${data.milestones.length} done` : error ?? "Loading the project…"}
				</span>
				<button
					type="button"
					onClick={() => void load()}
					className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
					<div className="flex h-full gap-3">
						{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-64 w-[300px] shrink-0 animate-pulse rounded-lg bg-muted/60" />)}
					</div>
				)}
			</div>
		</div>
	);
}
