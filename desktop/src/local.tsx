import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { HardDrive, Plus, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { apiBase } from "./api";
import { SwarmPanel, type Bridge } from "./swarm-panel";

const tauri: Bridge = { invoke, listen, apiBase };
import { SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";

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
type SessionRow = { run: string; title: string; outcome: string };

/** A folder's swarm sessions, newest first, refreshed when a session starts or ends. */
function useSessions(folder: string) {
	const [rows, setRows] = useState<SessionRow[]>([]);
	useEffect(() => {
		const look = () => void invoke<SessionRow[]>("swarm_sessions", { folder }).then(setRows, () => setRows([]));
		look();
		window.addEventListener("fm:sessions", look);
		return () => window.removeEventListener("fm:sessions", look);
	}, [folder]);
	return rows;
}

/** A folder in the sidebar with its swarm sessions underneath, like a project's chats on the web. */
function FolderItem({ path, current, run, onRemove }: { path: string; current: boolean; run: string | null; onRemove: () => void }) {
	const sessions = useSessions(path);
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={current && !run} tooltip={path} className="font-normal">
				<Link to={href(path)}>
					<HardDrive />
					<span>{name(path)}</span>
				</Link>
			</SidebarMenuButton>
			<SidebarMenuAction showOnHover title="Remove from the list" onClick={onRemove}>
				<X />
			</SidebarMenuAction>
			{sessions.length ? (
				<SidebarMenuSub>
					{sessions.slice(0, 8).map((x, i) => (
						<SidebarMenuSubItem key={x.run}>
							<SidebarMenuSubButton asChild isActive={current && run === x.run} size="sm">
								<Link to={`${href(path)}&run=${x.run}`} title={x.outcome || undefined}>
									<span className="truncate">{x.title || `Session ${sessions.length - i}`}</span>
								</Link>
							</SidebarMenuSubButton>
						</SidebarMenuSubItem>
					))}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuItem>
	);
}

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
					<FolderItem key={path} path={path} current={current === path} run={current === path ? params.get("run") : null} onRemove={() => void remove(path)} />
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
	return path ? <SwarmPanel folder={path} name={name(path)} scan={scan} bridge={tauri} session={params.get("run")} /> : null;
}
