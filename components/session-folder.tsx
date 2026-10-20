import { useState } from "react";
import { useNavigate } from "react-router";
import { Folder, FolderOpen, HardDrive, Plus } from "lucide-react";

/**
 * A project or folder in the sidebar. Selected, it shows its files underneath (`children`, the file tree); its name
 * opens it, and folds the tree when it's already open.
 */
export function TreeFolder({ name, title, href, current, action, children }: {
	name: string;
	title?: string;
	href: string;
	current: boolean;
	/** A control on the row's right (shown on hover), like + for a new chat. */
	action?: React.ReactNode;
	children?: React.ReactNode;
}) {
	const [open, setOpen] = useState(true);
	const navigate = useNavigate();
	const shown = current && open;
	return (
		<li className="list-none">
			<div className={`group/folder flex h-8 items-center rounded-md pr-1 hover:bg-sidebar-accent ${current ? "text-sidebar-foreground" : ""}`}>
				<button
					type="button"
					onClick={() => (current ? setOpen(!open) : (setOpen(true), navigate(href)))}
					title={title ?? name}
					aria-expanded={current ? open : undefined}
					className={`flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${current ? "font-medium" : "font-normal text-sidebar-foreground/90"}`}
				>
					{shown ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
					<span className="truncate group-data-[collapsible=icon]:hidden">{name}</span>
				</button>
				{action ? <span className="opacity-0 group-hover/folder:opacity-100 focus-within:opacity-100 group-data-[collapsible=icon]:hidden">{action}</span> : null}
			</div>
			{shown && children ? <div className="pl-3 group-data-[collapsible=icon]:hidden">{children}</div> : null}
		</li>
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
