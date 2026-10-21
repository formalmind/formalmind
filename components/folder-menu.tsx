import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type FolderMenuItem =
	| { label: string; icon: React.ComponentType<{ className?: string }>; onSelect: () => void; danger?: boolean; disabled?: boolean; iconClassName?: string }
	| "separator";

/**
 * A sidebar folder's options: the ⋯ on its row (shown on hover) and a right-click anywhere on the row open the same
 * small menu. `children` renders the row and puts `dots` where the ⋯ goes.
 */
export function FolderMenu({ items, onOpen, children }: { items: FolderMenuItem[]; onOpen?: () => void; children: (dots: React.ReactNode) => React.ReactNode }) {
	const [at, setAt] = useState<{ x: number; y: number } | null>(null);
	const open = (x: number, y: number) => {
		setAt({ x, y });
		onOpen?.();
	};
	const dots = (
		<button
			type="button"
			aria-label="Folder options"
			title="Options"
			onClick={(e) => {
				const r = e.currentTarget.getBoundingClientRect();
				open(r.left, r.bottom + 4);
			}}
			className={`flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-sidebar-foreground group-hover/folder:opacity-100 focus-visible:opacity-100 group-data-[collapsible=icon]:hidden ${at ? "opacity-100" : "opacity-0"}`}
		>
			<MoreHorizontal className="size-3.5" />
		</button>
	);
	return (
		<div
			className="contents"
			onContextMenu={(e) => {
				e.preventDefault();
				open(e.clientX, e.clientY);
			}}
		>
			{children(dots)}
			<DropdownMenu open={at !== null} onOpenChange={(o) => !o && setAt(null)}>
				<DropdownMenuTrigger asChild>
					<span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-36 [&_[role=menuitem]]:py-1 [&_[role=menuitem]]:text-[12px]">
					{items.map((item, i) =>
						item === "separator" ? (
							<DropdownMenuSeparator key={i} className="my-0.5" />
						) : (
							<DropdownMenuItem
								key={item.label}
								disabled={item.disabled}
								onSelect={item.onSelect}
								className={item.danger ? "text-red-600 focus:bg-red-500/10 focus:text-red-600 dark:text-red-400" : undefined}
							>
								<item.icon className={item.iconClassName ?? "size-3"} /> {item.label}
							</DropdownMenuItem>
						),
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** Folders archived from the sidebar (imported repos, demo folders), remembered in this browser. */
export function useArchived() {
	const [list, setList] = useState<string[]>(() => {
		try {
			return JSON.parse(localStorage.getItem("fm:archived-projects") ?? "[]") as string[];
		} catch {
			return [];
		}
	});
	const set = (key: string, on: boolean) => {
		const next = on ? [...list.filter((k) => k !== key), key] : list.filter((k) => k !== key);
		setList(next);
		try {
			localStorage.setItem("fm:archived-projects", JSON.stringify(next));
		} catch {
			// Private windows can refuse storage; the list still holds for this visit.
		}
	};
	return { archived: list, setArchived: set };
}
