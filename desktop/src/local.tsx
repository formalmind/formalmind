import { useCallback, useEffect, useState } from "react";
import { CanvasActions } from "./tabs";
import { useLocation, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { apiBase } from "./api";
import { LocalHeading, SessionFolder } from "@/components/session-folder";
import { SwarmPanel, type Bridge } from "./swarm-panel";

const tauri: Bridge = { invoke, listen, apiBase };
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

type Config = { folders: string[] };
export type Scan = { solidity: string[]; lean: string[]; truncated: boolean; git?: boolean };

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
function FolderItem({ path, current, run }: { path: string; current: boolean; run: string | null }) {
	const sessions = useSessions(path);
	const [live, setLive] = useState<string | null>(null);
	useEffect(() => {
		const look = () => void invoke<string | null>("swarm_running").then(setLive, () => setLive(null));
		look();
		window.addEventListener("fm:sessions", look);
		return () => window.removeEventListener("fm:sessions", look);
	}, []);
	return (
		<SessionFolder
			name={name(path)}
			title={path}
			href={href(path)}
			current={current}
			currentSession={run}
			newHref={`${href(path)}&run=new`}
			sessions={sessions.slice(0, 12).map((x, i) => ({ id: x.run, title: x.title || (x.run === "swarm" ? "Main session" : `Session ${sessions.length - i}`), href: `${href(path)}&run=${x.run}`, live: x.run === live }))}
		/>
	);
}

export function LocalFolders() {
	const { folders, add } = useFolders();
	const location = useLocation();
	const [params] = useSearchParams();
	const current = location.pathname === "/local" ? params.get("path") : null;
	return (
		<SidebarGroup>
			<LocalHeading onAdd={() => void add()} />
			<ul className="flex flex-col gap-0.5">
				{folders.map((path) => (
					<FolderItem key={path} path={path} current={current === path} run={current === path ? params.get("run") : null} />
				))}
			</ul>
			<SidebarMenu>
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
	return path ? <SwarmPanel folder={path} name={name(path)} scan={scan} bridge={tauri} session={params.get("run")} actions={<CanvasActions />} /> : null;
}
