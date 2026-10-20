import { useState } from "react";
import { Link } from "react-router";
import { ChevronRight, Folder, FolderOpen, HardDrive, Plus, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export type FolderSession = { id: string; title: string; href: string; live?: boolean };

const ROW = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-normal text-sidebar-foreground/90 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring";
const ACTIVE = "bg-sidebar-accent text-sidebar-foreground";

/**
 * A folder on this computer in the sidebar, like a project folder: its name opens the folder's swarm, the chevron
 * shows its swarm sessions (long-running, each one opens where it left off), and a live one has a pulsing dot.
 */
export function SessionFolder({ name, title, href, sessions, current, currentSession, onRemove }: {
	name: string;
	title?: string;
	href: string;
	sessions: FolderSession[];
	current: boolean;
	currentSession?: string | null;
	onRemove?: () => void;
}) {
	const [open, setOpen] = useState(true);
	return (
		<Collapsible open={open} onOpenChange={setOpen} asChild>
			<li className="list-none">
				<div className={`group/folder flex h-8 items-center rounded-md pr-1 hover:bg-sidebar-accent ${current && !currentSession ? ACTIVE : ""}`}>
					<Link to={href} title={title ?? name} className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-sm font-normal text-sidebar-foreground/90 outline-none">
						{open && sessions.length ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
						<span className="truncate group-data-[collapsible=icon]:hidden">{name}</span>
					</Link>
					{onRemove ? (
						<button type="button" onClick={onRemove} title="Remove from the list" className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-background group-hover/folder:opacity-100 group-data-[collapsible=icon]:hidden">
							<X className="size-3.5" />
						</button>
					) : null}
					{sessions.length ? (
						<CollapsibleTrigger className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background group-data-[collapsible=icon]:hidden" aria-label={open ? "Hide sessions" : "Show sessions"}>
							<ChevronRight className={`size-3.5 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
						</CollapsibleTrigger>
					) : null}
				</div>
				<CollapsibleContent className="group-data-[collapsible=icon]:hidden">
					<ul className="flex flex-col gap-0.5 pb-2 pl-6">
						{sessions.map((x) => (
							<li key={x.id}>
								<Link to={x.href} title={x.title} className={`${ROW} ${current && currentSession === x.id ? ACTIVE : ""}`}>
									<span className="truncate">{x.title}</span>
									{x.live ? <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-label="running" /> : null}
								</Link>
							</li>
						))}
					</ul>
				</CollapsibleContent>
			</li>
		</Collapsible>
	);
}

/** The heading over folders on this computer, styled like the sidebar's "Projects" heading: a drive icon and "Local". */
export function LocalHeading({ onAdd }: { onAdd?: () => void }) {
	return (
		<div className="mt-2 flex h-7 items-center justify-between pl-2 pr-1 text-xs font-medium text-sidebar-foreground/60 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
			<span className="flex items-center gap-1.5">
				<HardDrive className="size-3.5" />
				<span className="group-data-[collapsible=icon]:hidden">Local</span>
			</span>
			{onAdd ? (
				<button type="button" onClick={onAdd} aria-label="Add a folder" title="Add a folder" className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden">
					<Plus className="size-4" />
				</button>
			) : null}
		</div>
	);
}
