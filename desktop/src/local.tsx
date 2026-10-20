import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { HardDrive, Plus, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { apiBase } from "./api";
import { SwarmPanel, type Bridge } from "./swarm-panel";

const tauri: Bridge = { invoke, listen, apiBase };
import { SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

type Config = { folders: string[] };
export type Scan = { solidity: string[]; lean: string[]; truncated: boolean };

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
	if (error) return <p className="p-6 text-sm text-red-600">{error}</p>;
	return path ? <SwarmPanel folder={path} name={name(path)} scan={scan} bridge={tauri} /> : null;
}
