import { useState } from "react";
import { Link } from "react-router";
import { setVimMode, useVimMode } from "@/components/vim-mode";
import { Archive, ArchiveRestore, Gauge, Play, Settings, Square, Wallet } from "lucide-react";
import { inDesktop, openOnWeb } from "@/lib/open-web";
import { FolderMenu, type FolderMenuItem } from "@/components/folder-menu";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** A project's swarm, stopped or running: stopping turns its workflow off and cancels runs in flight. */
function useSwarmControl(repo: string) {
	const [paused, setPaused] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const load = () =>
		fetch(`/api/projects/swarm?repo=${encodeURIComponent(repo)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((b: { paused?: boolean } | null) => setPaused(b?.paused ?? null))
			.catch(() => null);
	const set = async (next: boolean) => {
		setBusy(true);
		const res = await fetch("/api/projects/swarm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, paused: next }) }).catch(() => null);
		const body = (await res?.json().catch(() => null)) as { paused?: boolean; error?: string } | null;
		if (res?.ok) setPaused(body?.paused ?? next);
		else window.alert(body?.error ?? "That didn't go through; try again.");
		setBusy(false);
	};
	return { paused, busy, load, set };
}

function SwarmItems({ repo, control, label }: { repo: string; control: ReturnType<typeof useSwarmControl>; label?: boolean }) {
	const { paused, busy, set } = control;
	return (
		<>
			{label ? <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{repo}</DropdownMenuLabel> : null}
			{paused ? (
				<DropdownMenuItem disabled={busy} onSelect={() => void set(false)}>
					<Play className="size-3.5" /> Resume swarm
				</DropdownMenuItem>
			) : (
				<DropdownMenuItem disabled={busy || paused === null} onSelect={() => void set(true)}>
					<Square className="size-3.5" /> Stop swarm
				</DropdownMenuItem>
			)}
		</>
	);
}

/** A project's ⋯ and right-click menu in the sidebar: stop or resume its swarm, and archive it (or bring it back). */
export function ProjectContextMenu({ repo, swarm, archived, onArchive, children }: { repo: string; swarm: boolean; archived: boolean; onArchive: (archived: boolean) => void; children: (dots: React.ReactNode) => React.ReactNode }) {
	const control = useSwarmControl(repo);
	const { paused, busy, set } = control;
	const items: FolderMenuItem[] = [
		...(swarm
			? [
					paused
						? { label: "Resume swarm", icon: Play, disabled: busy, onSelect: () => void set(false) }
						: { label: "Stop swarm", icon: Square, iconClassName: "size-2.5 fill-current", danger: true, disabled: busy || paused === null, onSelect: () => void set(true) },
					"separator" as const,
				]
			: []),
		{ label: archived ? "Unarchive" : "Archive", icon: archived ? ArchiveRestore : Archive, onSelect: () => onArchive(!archived) },
	];
	return (
		<FolderMenu items={items} onOpen={swarm ? () => void control.load() : undefined}>
			{children}
		</FolderMenu>
	);
}

function ProjectItems({ repo, open, label }: { repo: string; open: boolean; label: boolean }) {
	const control = useSwarmControl(repo);
	const [seen, setSeen] = useState(false);
	if (open && !seen) {
		setSeen(true);
		void control.load();
	}
	if (!open && seen) setSeen(false);
	return <SwarmItems repo={repo} control={control} label={label} />;
}

/** Right-click on the canvas: the same options, for each project the board shows. */
export function SwarmContextMenu({ repos, children }: { repos: string[]; children: React.ReactNode }) {
	const [at, setAt] = useState<{ x: number; y: number } | null>(null);
	return (
		<div
			className="contents"
			onContextMenu={(e) => {
				if (repos.length === 0) return;
				e.preventDefault();
				setAt({ x: e.clientX, y: e.clientY });
			}}
		>
			{children}
			<DropdownMenu open={at !== null} onOpenChange={(o) => !o && setAt(null)}>
				<DropdownMenuTrigger asChild>
					<span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{repos.map((repo, i) => (
						<div key={repo}>
							{i > 0 ? <DropdownMenuSeparator /> : null}
							<ProjectItems repo={repo} open={at !== null} label={repos.length > 1} />
						</div>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** The gear beside the bell: account pages, and stopping or resuming each project's swarm. */
export function SettingsMenu({ repos, className }: { repos: string[]; className?: string }) {
	const [open, setOpen] = useState(false);
	const vim = useVimMode();
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
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
				{inDesktop() ? (
					<DropdownMenuItem onSelect={() => openOnWeb("/billing")}><Wallet className="size-3.5" /> Billing</DropdownMenuItem>
				) : (
					<DropdownMenuItem asChild>
						<Link to="/billing"><Wallet className="size-3.5" /> Billing</Link>
					</DropdownMenuItem>
				)}
				<DropdownMenuSeparator />
				{/* Keeps the menu open so the change shows. */}
				<DropdownMenuCheckboxItem checked={vim} onCheckedChange={(on) => setVimMode(on)} onSelect={(e) => e.preventDefault()}>
					Vim mode in code
				</DropdownMenuCheckboxItem>
				{repos.map((repo) => (
					<div key={repo}>
						<DropdownMenuSeparator />
						<ProjectItems repo={repo} open={open} label />
					</div>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
