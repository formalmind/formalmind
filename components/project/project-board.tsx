"use client";

import { MilestoneIcon } from "@primer/octicons-react";
import { LABEL_STYLES } from "@/components/swarm/swarm-canvas";
import { PROJECT_STATUSES, type ProjectItem, type ProjectMilestone } from "@/lib/project";
import { ItemStateIcon, StatusDot, useItemHover } from "./project-meta";

/** The Board layout of a GitHub project: one column per Status, newest activity on top. */
export function ProjectBoard({ repo, items, milestones }: { repo: string; items: ProjectItem[]; milestones: ProjectMilestone[] }) {
	const { bind, card } = useItemHover(repo);
	const repoName = repo.split("/")[1] ?? repo;
	const milestoneTitle = new Map(milestones.map((m) => [m.number, m.title]));

	return (
		<div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-2">
			{PROJECT_STATUSES.map((status) => {
				const column = items.filter((item) => item.status === status.key).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
				return (
					<section key={status.key} aria-label={status.name} className="flex max-h-full w-[300px] shrink-0 flex-col rounded-lg border bg-muted/40">
						<header className="px-3 pb-2 pt-3">
							<h3 className="flex items-center gap-2 text-sm font-semibold">
								<StatusDot status={status.key} />
								{status.name}
								<span className="rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">{column.length}</span>
							</h3>
							<p className="mt-1 text-xs text-muted-foreground">{status.description}</p>
						</header>
						<ol className="flex min-h-16 flex-col gap-2 overflow-y-auto px-2 pb-2">
							{column.map((item) => (
								<li key={item.number}>
									<a
										href={item.url}
										target="_blank"
										rel="noreferrer"
										{...bind(item)}
										className="block rounded-md border bg-card p-2.5 shadow-sm transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
											<ItemStateIcon item={item} size={14} />
											{repoName} #{item.number}
										</span>
										<span className="mt-1 block text-sm leading-snug">{item.title}</span>
										{item.labels.length || item.milestone ? (
											<span className="mt-2 flex flex-wrap items-center gap-1">
												{item.labels.map((label) => (
													<span key={label} className={`rounded-full px-1.5 py-px font-mono text-[10px] ${LABEL_STYLES[label] ?? LABEL_STYLES.README}`}>{label}</span>
												))}
												{item.milestone ? (
													<span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
														<MilestoneIcon size={10} />
														{milestoneTitle.get(item.milestone) ?? `Roadmap ${item.milestone}`}
													</span>
												) : null}
											</span>
										) : null}
										<span className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
											<span>{item.comments ? `${item.comments} comment${item.comments === 1 ? "" : "s"}` : ""}</span>
											{item.authorAvatar ? (
												// eslint-disable-next-line @next/next/no-img-element -- tiny GitHub avatar, not worth the image optimizer
												<img src={`${item.authorAvatar}${item.authorAvatar.includes("?") ? "&" : "?"}s=40`} alt={item.author} title={item.author} className="size-4 rounded-full" />
											) : null}
										</span>
									</a>
								</li>
							))}
							{!column.length ? <li className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">Nothing here</li> : null}
						</ol>
					</section>
				);
			})}
			{card}
		</div>
	);
}
