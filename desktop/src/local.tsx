import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { apiBase } from "./api";
import { LocalHeading, TreeFolder } from "@/components/session-folder";
import { FileTree, type Runnable } from "@/components/file-tree";
import { SwarmPanel, type Bridge } from "./swarm-panel";
import { DebugView } from "./debug";

const tauri: Bridge = { invoke, listen, apiBase };
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

type Config = { folders: string[] };
export type Scan = { solidity: string[]; lean: string[]; truncated: boolean; git?: boolean };

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const href = (path: string) => `/local?path=${encodeURIComponent(path)}`;

/** Folders on this machine, kept in ~/.formalmind/config.json. Shared by every view through a small event. */
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
function FolderItem({ path, current, file }: { path: string; current: boolean; file: string | null }) {
	const tree = useTree(path, current);
	const navigate = useNavigate();
	const [params] = useSearchParams();
	return (
		<TreeFolder name={name(path)} title={path} href={href(path)} current={current}>
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
					runnables={{
						has: (f) => /\.[ts]\.sol$/.test(f),
						list: (f) => invoke<string>("folder_read", { folder: path, path: f }).then((text) => runnablesIn(text, f.endsWith(".s.sol") ? "run" : "test")),
						onRun: (f, r) => {
							const next = new URLSearchParams(params);
							next.set("path", path);
							next.set("file", f);
							next.set("test", `${r.contract}::${r.fn}`);
							next.set("mode", "debug");
							next.delete("line");
							navigate(`/local?${next.toString()}`);
						},
						current: params.get("mode") === "debug" && file && params.get("test") ? `${file}::${params.get("test")}` : null,
					}}
				/>
			) : null}
		</TreeFolder>
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
					<FolderItem key={path} path={path} current={current === path} file={current === path ? params.get("file") : null} />
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
	return path ? <SwarmPanel folder={path} name={name(path)} scan={scan} bridge={tauri} session={params.get("run")} file={params.get("file")} debug={(file, test, onPick) => <DebugView folder={path} file={file} test={test} onPick={onPick} embedded />} /> : null;
}
