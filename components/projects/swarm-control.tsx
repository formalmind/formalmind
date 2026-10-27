import { useState } from "react";
import { Link } from "react-router";
import { setVimMode, useVimMode } from "@/components/vim-mode";
import { Archive, ArchiveRestore, FolderSearch, Gauge, Settings } from "lucide-react";
import { AuditFoldersDialog } from "@/components/audit-folders";
import { FolderMenu, type FolderMenuItem } from "@/components/folder-menu";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** A project's ⋯ and right-click menu in the sidebar: its audit folders, and archive it (or bring it back). */
export function ProjectContextMenu({ repo, archived, onArchive, auditKey, children }: { repo: string; archived: boolean; onArchive: (archived: boolean) => void; auditKey?: string; children: (dots: React.ReactNode) => React.ReactNode }) {
	const [audits, setAudits] = useState(false);
	const items: FolderMenuItem[] = [
		{ label: "Audit reports…", icon: FolderSearch, onSelect: () => setAudits(true) },
		"separator",
		{ label: archived ? "Unarchive" : "Archive", icon: archived ? ArchiveRestore : Archive, onSelect: () => onArchive(!archived) },
	];
	return (
		<>
			<FolderMenu items={items}>
				{children}
			</FolderMenu>
			{/* The audit folders are kept by the folder the Bugs tab reads: the repository on the web, its clone in the Mac app. */}
			{audits ? <AuditFoldersDialog folder={auditKey ?? repo} label={repo} onClose={() => setAudits(false)} /> : null}
		</>
	);
}

/** The gear beside the bell: account pages and the editor's vim mode. */
export function SettingsMenu({ className }: { className?: string }) {
	const vim = useVimMode();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger aria-label="Settings" title="Settings" className={className}>
				<Settings className="size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				{/* The Mac app has its own settings page (provider, key, server). */}
				{"__TAURI_INTERNALS__" in window ? (
					<DropdownMenuItem asChild>
						<Link to="/settings"><Settings className="size-3.5" /> Settings</Link>
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem asChild>
					<Link to="/usage"><Gauge className="size-3.5" /> Usage</Link>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{/* Keeps the menu open so the change shows. */}
				<DropdownMenuCheckboxItem checked={vim} onCheckedChange={(on) => setVimMode(on)} onSelect={(e) => e.preventDefault()}>
					Vim mode in code
				</DropdownMenuCheckboxItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
