import { FORKS_ENABLED, ScriptRunDialog, type ScriptTarget } from "./script-run-dialog";
import { fileResult, useRunResults } from "@/lib/run-results";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Archive, ArchiveRestore, Plus, X } from "lucide-react";
import { useArchived } from "@/components/folder-menu";
import { listen } from "@tauri-apps/api/event";
import { apiBase } from "./api";
import { LocalHeading, TreeFolder } from "@/components/session-folder";
import type { RepoSource } from "@/components/app-sidebar";
import { FileTree, type Runnable } from "@/components/file-tree";
import { SwarmPanel, type Bridge } from "./swarm-panel";
import { DebugView } from "./debug";

/** Debug mode (the Debug tab, and run buttons on scripts and tests in the tree). Off for now: the audit comes first. */
const DEBUG_ENABLED = false;

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

/**
 * The functions a script or test file can run as it is: `run…()` or `test…()` without arguments, with the contract
 * each sits in (read from the text; the debugger compiles when one runs).
 */
function runnablesIn(text: string, prefix: "run" | "test"): Runnable[] {
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const out: Runnable[] = [];
	// Abstract contracts can't be deployed to run; their functions run through the contracts that inherit them.
	let contract = "";
	const re = new RegExp(`\\b(abstract\\s+)?contract\\s+(\\w+)|\\bfunction\\s+(${prefix}\\w*)\\s*\\(\\s*\\)`, "g");
	for (const m of clean.matchAll(re)) {
		if (m[2]) contract = m[1] ? "" : m[2];
		else if (m[3] && contract) out.push({ contract, fn: m[3] });
	}
	return out;
}

/** A folder in the sidebar: selected, its file tree; a file opens in the canvas's file card. */
function FolderItem({ path, current, file, archived, onArchive, onRemove }: { path: string; current: boolean; file: string | null; archived: boolean; onArchive: (on: boolean) => void; onRemove: () => void }) {
	const tree = useTree(path, current);
	const navigate = useNavigate();
	const results = useRunResults(path);
	// A script asks where to run first (chain, Anvil fork); tests run straight away.
	const [asking, setAsking] = useState<{ file: string; r: Runnable } | null>(null);
	const debugRun = (f: string, r: Runnable, target?: ScriptTarget) => {
		const next = new URLSearchParams(params);
		next.set("path", path);
		next.set("file", f);
		next.set("test", `${r.contract}::${r.fn}`);
		next.set("mode", "debug");
		next.delete("line");
		next.delete("fork");
		next.delete("chain");
		if (target) {
			next.set("chain", String(target.chainId));
			if (target.fork) next.set("fork", target.fork);
		}
		navigate(`/local?${next.toString()}`);
	};
	const [params] = useSearchParams();
	return (
		<TreeFolder
			name={name(path)}
			title={path}
			href={href(path)}
			current={current}
			dim={archived}
			menu={[
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
					runnables={DEBUG_ENABLED ? {
						has: (f) => /\.[ts]\.sol$/.test(f),
						list: (f) => invoke<string>("folder_read", { folder: path, path: f }).then((text) => runnablesIn(text, f.endsWith(".s.sol") ? "run" : "test")),
						onRun: (f, r) => (FORKS_ENABLED && f.endsWith(".s.sol") ? setAsking({ file: f, r }) : debugRun(f, r)),
						current: params.get("mode") === "debug" && file && params.get("test") ? `${file}::${params.get("test")}` : null,
						result: (f, r) => (r ? results[`${f}::${r.contract}::${r.fn}`] : fileResult(results, f)),
					} : undefined}
				/>
			) : null}
			{asking ? (
				<ScriptRunDialog
					folder={path}
					file={asking.file}
					fn={asking.r.fn}
					onClose={() => setAsking(null)}
					onRun={(t) => {
						const a = asking;
						setAsking(null);
						debugRun(a.file, a.r, t);
					}}
				/>
			) : null}
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
	return path ? <SwarmPanel folder={path} name={name(path)} scan={scan} bridge={tauri} session={params.get("run")} file={params.get("file")} debug={DEBUG_ENABLED ? (file, test, onPick) => <DebugView folder={path} file={file} test={test} onPick={onPick} embedded /> : undefined} /> : null;
}
