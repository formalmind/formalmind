import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { HardDrive, Plus, X } from "lucide-react";
import { SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

type Config = { folders: string[] };
type Scan = { solidity: string[]; lean: string[]; truncated: boolean };

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const href = (path: string) => `/local?path=${encodeURIComponent(path)}`;

/** Folders on this machine, kept in ~/.formalmind/config.json. Shared by every view through a small event. */
function useFolders() {
	const [folders, setFolders] = useState<string[]>([]);
	useEffect(() => {
		const load = () => void invoke<Config>("config_get").then((c) => setFolders(c.folders), () => {});
		load();
		window.addEventListener("fm:folders", load);
		return () => window.removeEventListener("fm:folders", load);
	}, []);
	const changed = () => window.dispatchEvent(new Event("fm:folders"));
	const add = useCallback(async () => {
		const path = await open({ directory: true, title: "Add a folder" });
		if (typeof path === "string") await invoke("folder_add", { path }).then(changed);
		return typeof path === "string" ? path : null;
	}, []);
	const remove = useCallback((path: string) => invoke("folder_remove", { path }).then(changed), []);
	return { folders, add, remove };
}

/** The sidebar section: local folders, with + to add one. */
export function LocalFolders() {
	const { folders, add, remove } = useFolders();
	const location = useLocation();
	const [params] = useSearchParams();
	const current = location.pathname === "/local" ? params.get("path") : null;
	return (
		<SidebarGroup>
			<SidebarGroupLabel>On this computer</SidebarGroupLabel>
			<SidebarGroupAction title="Add a folder" onClick={() => void add()}>
				<Plus />
			</SidebarGroupAction>
			<SidebarMenu>
				{folders.map((path) => (
					<SidebarMenuItem key={path}>
						<SidebarMenuButton asChild isActive={current === path} tooltip={path} className="font-normal">
							<Link to={href(path)}>
								<HardDrive />
								<span>{name(path)}</span>
							</Link>
						</SidebarMenuButton>
						<SidebarMenuAction showOnHover title="Remove from the list" onClick={() => void remove(path)}>
							<X />
						</SidebarMenuAction>
					</SidebarMenuItem>
				))}
				{folders.length === 0 ? (
					<SidebarMenuItem>
						<SidebarMenuButton onClick={() => void add()} className="font-normal text-muted-foreground">
							<Plus />
							<span>Add a folder</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				) : null}
			</SidebarMenu>
		</SidebarGroup>
	);
}

function FileList({ title, files }: { title: string; files: string[] }) {
	return (
		<section className="space-y-2">
			<h2 className="text-sm font-medium">
				{title} <span className="text-muted-foreground">{files.length}</span>
			</h2>
			{files.length ? (
				<ul className="shadow-card max-h-[50vh] overflow-auto rounded-xl bg-card p-2 font-mono text-xs">
					{files.map((f) => (
						<li key={f} className="truncate rounded px-2 py-1 hover:bg-muted">{f}</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">None here.</p>
			)}
		</section>
	);
}

/** A local folder: what's in it to prove. The files stay on this machine. */
export function LocalFolderPage() {
	const [params] = useSearchParams();
	const path = params.get("path") ?? "";
	const [scan, setScan] = useState<Scan | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setScan(null);
		setError(null);
		invoke<Scan>("folder_scan", { path }).then(setScan, (e) => setError(String(e)));
	}, [path]);
	return (
		<div className="mx-auto w-full max-w-3xl space-y-6 p-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold">{name(path)}</h1>
				<p className="truncate font-mono text-xs text-muted-foreground">{path}</p>
			</header>
			{error ? <p className="text-sm text-red-600">{error}</p> : null}
			{scan ? (
				<>
					<div className="grid gap-6 md:grid-cols-2">
						<FileList title="Solidity" files={scan.solidity} />
						<FileList title="Lean" files={scan.lean} />
					</div>
					{scan.truncated ? <p className="text-xs text-muted-foreground">Big folder: stopped after 5,000 entries.</p> : null}
					<p className="text-sm text-muted-foreground">Running the swarm on a local folder comes with the local executor. Files stay on this computer.</p>
				</>
			) : !error ? (
				<p className="text-sm text-muted-foreground">Reading the folder…</p>
			) : null}
		</div>
	);
}
