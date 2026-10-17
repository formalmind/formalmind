"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitMergeIcon, GitPullRequestIcon, IssueClosedIcon, IssueOpenedIcon } from "@primer/octicons-react";
import { ItemHoverCard } from "@/components/swarm/swarm-canvas";
import type { ProjectItem, ProjectStatus } from "@/lib/project";

/** GitHub Projects' single-select colors, one per Status option. */
export const STATUS_STYLES: Record<ProjectStatus, { dot: string; bar: string }> = {
	none: { dot: "border-dashed border-muted-foreground/60", bar: "border-dashed border-muted-foreground/50 bg-muted text-muted-foreground" },
	todo: { dot: "border-slate-500 bg-slate-500/20", bar: "border-slate-500/50 bg-slate-500/15 text-slate-700 dark:text-slate-300" },
	"in-progress": { dot: "border-amber-500 bg-amber-500/20", bar: "border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-300" },
	review: { dot: "border-blue-500 bg-blue-500/20", bar: "border-blue-500/50 bg-blue-500/15 text-blue-700 dark:text-blue-300" },
	approved: { dot: "border-emerald-500 bg-emerald-500/20", bar: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
	blocked: { dot: "border-red-500 bg-red-500/20", bar: "border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300" },
	done: { dot: "border-violet-500 bg-violet-500/20", bar: "border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300" },
};

export function StatusDot({ status }: { status: ProjectStatus }) {
	return <span className={`inline-block size-3 shrink-0 rounded-full border-2 ${STATUS_STYLES[status].dot}`} aria-hidden />;
}

export function ItemStateIcon({ item, size = 16 }: { item: ProjectItem; size?: number }) {
	const open = "text-emerald-600 dark:text-emerald-400";
	const closed = "text-violet-600 dark:text-violet-400";
	if (item.kind === "pr") {
		return item.merged ? <GitMergeIcon size={size} className={closed} aria-label="Merged pull request" /> : <GitPullRequestIcon size={size} className={open} aria-label="Open pull request" />;
	}
	return item.state === "open" ? <IssueOpenedIcon size={size} className={open} aria-label="Open issue" /> : <IssueClosedIcon size={size} className={closed} aria-label="Closed issue" />;
}

/**
 * GitHub's filter bar syntax, the useful subset: free words match the title or number, and
 * `is:open|closed|merged|issue|pr`, `status:`, `label:`, `author:` and `roadmap:` narrow by field.
 * A leading `-` negates a qualifier.
 */
export function matchesFilter(item: ProjectItem, query: string) {
	return query.trim().split(/\s+/).filter(Boolean).every((token) => {
		const negate = token.startsWith("-") && token.includes(":");
		const [key, ...rest] = (negate ? token.slice(1) : token).split(":");
		const value = rest.join(":").toLowerCase();
		let hit: boolean;
		if (!rest.length) {
			const word = token.toLowerCase().replace(/^#/, "");
			return item.title.toLowerCase().includes(word) || String(item.number) === word;
		}
		switch (key.toLowerCase()) {
			case "is":
				hit = value === item.state || value === item.kind || (value === "closed" && item.state === "merged");
				break;
			case "status":
				hit = item.status === value || item.status.replace("-", "") === value.replace(/[-\s]/g, "");
				break;
			case "label":
				hit = item.labels.some((l) => l.toLowerCase() === value);
				break;
			case "author":
				hit = item.author.toLowerCase().startsWith(value);
				break;
			case "roadmap":
				hit = String(item.milestone ?? "none") === value;
				break;
			default:
				hit = true;
		}
		return negate ? !hit : hit;
	});
}

/** Shows the GitHub-style preview card for whichever item the pointer rests on. */
export function useItemHover(repo: string) {
	const [hover, setHover] = useState<{ item: ProjectItem; left: number; top: number; below: boolean } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clear = () => {
		if (timer.current) clearTimeout(timer.current);
	};
	const leave = () => {
		clear();
		timer.current = setTimeout(() => setHover(null), 150);
	};
	const enter = (item: ProjectItem, el: HTMLElement) => {
		clear();
		timer.current = setTimeout(() => {
			const rect = el.getBoundingClientRect();
			const below = rect.top < window.innerHeight / 2;
			setHover({
				item,
				left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)),
				top: below ? rect.bottom + 6 : rect.top - 6,
				below,
			});
		}, 300);
	};

	const bind = (item: ProjectItem) => ({
		onMouseEnter: (e: React.MouseEvent<HTMLElement>) => enter(item, e.currentTarget),
		onMouseLeave: leave,
		onFocus: (e: React.FocusEvent<HTMLElement>) => enter(item, e.currentTarget),
		onBlur: leave,
	});

	const card = hover
		? createPortal(
			<div className="pointer-events-none fixed inset-0 z-50">
				<div className="pointer-events-auto">
					<ItemHoverCard item={hover.item} repo={repo} left={hover.left} top={hover.top} below={hover.below} onEnter={clear} onLeave={leave} />
				</div>
			</div>,
			document.body,
		)
		: null;

	return { bind, card };
}
