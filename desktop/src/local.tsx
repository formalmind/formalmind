import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Archive, ArchiveRestore, FolderSearch, Plus, X } from "lucide-react";
import { AuditFoldersDialog } from "@/components/audit-folders";
import { useArchived } from "@/components/folder-menu";
import { listen } from "@tauri-apps/api/event";
import { apiBase } from "./api";
import { LocalHeading, TreeFolder } from "@/components/session-folder";
import type { RepoSource } from "@/components/app-sidebar";
import { FileTree } from "@/components/file-tree";
import { SwarmPanel, type Bridge } from "./swarm-panel";

const tauri: Bridge = { invoke, listen, apiBase };
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

type Config = { folders: string[] };
export type Scan = { solidity: string[]; lean: string[]; truncated: boolean; git?: boolean };

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const href = (path: string) => `/local?path=${encodeURIComponent(path)}`;

/** Folders on this machine, kept in ~/.formalmind/config.json. Shared by every view through a small event. */
/**
 * Imported GitHub repositories on this machine: cloned once into ~/.formalmind/repos (or mapped to a folder you already
 * have), listed from disk, and opened as a folder page like any local folder.
 */
export function useRepoSource(): RepoSource {
	const navigate = useNavigate();
	// The app routes in the hash, so the page shown comes from the router, kept in a ref for `current`.
	const location = useLocation();
	const at = useRef(location);
	at.current = location;
	return useMemo<RepoSource>(
		() => ({
			local: (repo) => invoke<string>("repo_local", { repo }),
			tree: (path) => invoke<Tree>("folder_tree", { path }),
			open: (path, file) => navigate(file ? `${href(path)}&file=${encodeURIComponent(file)}&mode=code` : href(path)),
			current: () => {
				const q = new URLSearchParams(at.current.search);
				return at.current.pathname === "/local" ? { path: q.get("path"), file: q.get("file") } : { path: null, file: null };
			},
		}),
		[navigate],
	);
}

export function useFolders() {
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

type Tree = { files: string[]; truncated: boolean };

/** A folder's files, read when it's selected (and again when the swarm writes, e.g. new proofs). */
function useTree(folder: string, on: boolean) {
	const [tree, setTree] = useState<Tree | null>(null);
	useEffect(() => {
		if (!on) return;
		const look = () => void invoke<Tree>("folder_tree", { path: folder }).then(setTree, () => setTree({ files: [], truncated: false }));
		look();
		window.addEventListener("fm:sessions", look);
		return () => window.removeEventListener("fm:sessions", look);
	}, [folder, on]);
	return tree;
}

/** Whether a swarm session is running in the folder: asked once, then followed through its start and done events. */
function useSwarmWorking(path: string): boolean {
	const [runs, setRuns] = useState<string[]>([]);
	useEffect(() => {
		void invoke<string[]>("swarm_running", { folder: path }).then(setRuns, () => {});
		const off = listen<{ folder: string; run: string; kind: string }>("swarm", ({ payload }) => {
			if (payload.folder !== path) return;
			if (payload.kind === "start") setRuns((r) => (r.includes(payload.run) ? r : [...r, payload.run]));
			if (payload.kind === "done") setRuns((r) => r.filter((x) => x !== payload.run));
		});
		return () => void off.then((f) => f());
	}, [path]);
	return runs.length > 0;
}

/** A folder in the sidebar: selected, its file tree; a file opens in the canvas's file card. */
function FolderItem({ path, current, file, archived, onArchive, onRemove }: { path: string; current: boolean; file: string | null; archived: boolean; onArchive: (on: boolean) => void; onRemove: () => void }) {
	const tree = useTree(path, current);
	const working = useSwarmWorking(path);
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const [audits, setAudits] = useState(false);
	return (
		<TreeFolder
			name={name(path)}
			title={path}
			href={href(path)}
			current={current}
			dim={archived}
			working={working}
			menu={[
				{ label: "Audit reports…", icon: FolderSearch, onSelect: () => setAudits(true) },
				"separator",
				{ label: archived ? "Unarchive" : "Archive", icon: archived ? ArchiveRestore : Archive, onSelect: () => onArchive(!archived) },
				"separator",
				// Only the sidebar forgets it; the folder stays on disk.
				{ label: "Remove from sidebar", icon: X, danger: true, onSelect: onRemove },
			]}
		>
			{tree ? (
				<FileTree
					paths={tree.files}
					truncated={tree.truncated}
					selected={file}
					storageKey={`fm:tree:${path}`}
					onOpen={(f) => {
						const next = new URLSearchParams(params);
						next.set("file", f);
						next.delete("line");
						next.set("mode", "code");
						navigate(`/local?${next.toString()}`);
					}}
				/>
			) : null}
			{audits ? <AuditFoldersDialog folder={path} label={name(path)} onClose={() => setAudits(false)} /> : null}
		</TreeFolder>
	);
}

export function LocalFolders() {
	const { folders, add, remove } = useFolders();
	const { archived, setArchived } = useArchived();
	const [showArchived, setShowArchived] = useState(false);
	const hidden = folders.filter((p) => archived.includes(p)).length;
	const location = useLocation();
	const [params] = useSearchParams();
	const current = location.pathname === "/local" ? params.get("path") : null;
	return (
		<SidebarGroup>
			<LocalHeading onAdd={() => void add()} />
			<ul className="flex flex-col gap-0.5">
				{folders.filter((p) => showArchived || !archived.includes(p)).map((path) => (
					<FolderItem
						key={path}
						path={path}
						current={current === path}
						file={current === path ? params.get("file") : null}
						archived={archived.includes(path)}
						onArchive={(on) => setArchived(path, on)}
						onRemove={() => void remove(path)}
					/>
				))}
				{hidden ? (
					<li className="list-none group-data-[collapsible=icon]:hidden">
						<button type="button" onClick={() => setShowArchived((v) => !v)} className="px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground">
							{showArchived ? "Hide archived" : `Archived · ${hidden}`}
						</button>
					</li>
				) : null}
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
	return path ? <SwarmPanel folder={path} name={name(path)} scan={scan} bridge={tauri} session={params.get("run")} file={params.get("file")} /> : null;
}
