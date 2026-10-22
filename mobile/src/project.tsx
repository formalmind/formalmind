import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Check, ChevronDown, ChevronRight, FileCode2, Folder, Laptop, Plus, Settings } from "lucide-react";
import { useAuth } from "@/components/auth-context";
import { MarkGithubIcon } from "@primer/octicons-react";
import { makeGitBridge } from "@/components/projects/git-bridge";
import { projectPath, repoOf, useProjects } from "@/components/projects/use-projects";
import { BellLink } from "./notifications";
import { ChatMarkdown } from "@/components/chat-markdown";
import { cachedTree, syncRepo } from "@/lib/browser-git";
import { FileView } from "@/desktop/src/swarm-panel";
import type { Diagnostic } from "@/lib/ast/run";
import { ProofsExplorer } from "./proofs";
import { BugsExplorer } from "./bugs";
import { ChatsIcon, CodeSkeleton, FloatingBar, ListSkeleton, TopBar } from "./bar";
import { SlideDrawer } from "./drawer";
import { PullToRefresh } from "./pull";
import { ChatButtons, MacState, SessionChat } from "./mac";
import { CloudChat, cloudChats, newCloudChatId, useCloudChats } from "./cloud-chat";
import { macName, macOnline, useMac } from "./relay";
import type { RelayFolder } from "@/lib/relay";
import { rememberProject, TabBar, type Tab } from "./tabs";

type Scan = { solidity: string[]; lean: string[]; truncated: boolean; git?: boolean };
type Bridge = ReturnType<typeof makeGitBridge>;

const TABS: Tab[] = ["code", "proofs", "bugs", "chat"];

/** The folders and files directly under `dir`, folders first. */
function entries(files: string[], dir: string) {
	const prefix = dir ? `${dir}/` : "";
	const dirs = new Set<string>();
	const here: string[] = [];
	for (const f of files) {
		if (!f.startsWith(prefix)) continue;
		const rest = f.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash === -1) here.push(f);
		else dirs.add(prefix + rest.slice(0, slash));
	}
	return { dirs: [...dirs].sort(), files: here.sort() };
}

/** A path a Markdown file's image points at, from the repository's root; null for a URL (loaded as it is). */
function imagePath(src: string, from: string) {
	if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
	const parts = src.startsWith("/") ? [] : from.split("/").slice(0, -1);
	for (const seg of src.replace(/^\//, "").split(/[?#]/)[0].split("/")) {
		if (seg === "..") parts.pop();
		else if (seg && seg !== ".") parts.push(decodeURIComponent(seg));
	}
	return parts.join("/");
}

/** A Markdown file, its images (relative to it) read from the phone's copy of the repository, as on the Mac. */
function MarkdownFile({ path, text, bridge }: { path: string; text: string; bridge: Bridge }) {
	const [images, setImages] = useState<Record<string, string>>({});
	useEffect(() => {
		let live = true;
		const srcs = [...text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g), ...text.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
		for (const src of new Set(srcs)) {
			const p = imagePath(src, path);
			if (!p) continue;
			bridge.invoke<string>("folder_image", { path: p }).then(
				(url) => live && setImages((m) => ({ ...m, [p]: url })),
				() => undefined,
			);
		}
		return () => {
			live = false;
		};
	}, [bridge, path, text]);
	return (
		<div className="p-4">
			<ChatMarkdown image={(src) => { const p = imagePath(src, path); return p === null ? src : images[p]; }}>{text}</ChatMarkdown>
		</div>
	);
}

/**
 * A Solidity file with solc's errors and warnings underlined: the same compile the Proofs tab runs (in the browser,
 * cached per commit), asked for this file.
 */
function SolidityFile({ path, text, bridge }: { path: string; text: string; bridge: Bridge }) {
	const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
	useEffect(() => {
		let live = true;
		setDiagnostics([]);
		bridge.invoke<Diagnostic[]>("ast_diagnostics", { entry: path }).then(
			(all) => live && setDiagnostics(all.filter((d) => d.file === path)),
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [bridge, path]);
	return <FileView path={path} text={text} diagnostics={diagnostics} />;
}

/** Code: browse the repository's folders, open a file. */
function CodeTab({ files, bridge, dir, file, open }: { files: string[] | null; bridge: Bridge; dir: string; file: string | null; open: (next: { dir?: string; file?: string | null }) => void }) {
	const [text, setText] = useState<{ path: string; text: string } | { path: string; error: string } | null>(null);
	useEffect(() => {
		if (!file) return setText(null);
		let live = true;
		setText(null);
		bridge.invoke<string>("folder_read", { path: file }).then(
			(t) => live && setText({ path: file, text: t }),
			(e) => live && setText({ path: file, error: String(e) }),
		);
		return () => {
			live = false;
		};
	}, [bridge, file]);
	if (file) {
		return (
			<div className="fm-under-tabs min-h-0 flex-1 overflow-auto">
				<div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
					<FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="truncate font-mono text-[12px]">{file}</span>
				</div>
				{!text ? (
					<CodeSkeleton />
				) : "error" in text ? (
					<p className="p-4 text-sm text-red-600">{text.error}</p>
				) : /\.(md|markdown)$/i.test(file) ? (
					<MarkdownFile path={file} text={text.text} bridge={bridge} />
				) : /\.sol$/i.test(file) ? (
					<SolidityFile path={file} text={text.text} bridge={bridge} />
				) : (
					<FileView path={file} text={text.text} />
				)}
			</div>
		);
	}
	if (!files) return <ListSkeleton />;
	const { dirs, files: here } = entries(files, dir);
	const name = (p: string) => p.split("/").pop();
	return (
		<div className="fm-under-tabs min-h-0 flex-1 overflow-auto">
			{dir ? <p className="truncate border-b px-4 py-2 font-mono text-[12px] text-muted-foreground">{dir}/</p> : null}
			<ul className="divide-y">
				{dirs.map((d) => (
					<li key={d}>
						<button type="button" onClick={() => open({ dir: d })} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted">
							<Folder className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
							<span className="min-w-0 flex-1 truncate text-[15px]">{name(d)}</span>
							<ChevronRight className="size-4 text-muted-foreground" />
						</button>
					</li>
				))}
				{here.map((f) => (
					<li key={f}>
						<button type="button" onClick={() => open({ file: f })} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted">
							<FileCode2 className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate text-[15px]">{name(f)}</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * An imported repository on the phone: Code, Proofs and Bugs from the browser's git copy, as on the website
 * (components/projects/git-bridge.ts). Proofs runs formal-ast (wasm) and solc-js here, in the webview.
 */
export function ProjectScreen() {
	const { owner, name } = useParams();
	const repo = repoOf(owner, name) ?? "";
	const [params, setParams] = useSearchParams();
	const navigate = useNavigate();
	const tab = (TABS.find((t) => t === params.get("tab")) ?? "code") as Tab;
	const dir = params.get("dir") ?? "";
	const file = params.get("file");
	// `rev` ticks when a pull to refresh brings a new commit: the bridge and the tabs start over on it.
	const [rev, setRev] = useState(0);
	const head = useRef<string | null>(null);
	const bridge = useMemo(() => makeGitBridge(repo), [repo, rev]);
	const [files, setFiles] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [history, setHistory] = useState(false);
	useEffect(() => rememberProject(repo), [repo]);

	useEffect(() => {
		let live = true;
		setFiles(null);
		setError(null);
		void (async () => {
			const cached = await cachedTree(repo).catch(() => null);
			if (cached && live) setFiles(cached.files);
			// Fetch the newest commit (a clone the first time); the cached copy serves meanwhile.
			const fresh = await syncRepo(repo).then((h) => ((head.current = h), cachedTree(repo))).catch((e) => {
				if (!cached && live) setError(String(e?.message ?? e));
				return null;
			});
			if (fresh && live) setFiles(fresh.files);
		})();
		return () => {
			live = false;
		};
	}, [repo]);

	/** Pull to refresh: the newest commit from GitHub, and the tabs again on it when it's new. */
	const refresh = async () => {
		const before = head.current;
		const h = await syncRepo(repo);
		head.current = h;
		const tree = await cachedTree(repo);
		if (tree) setFiles(tree.files);
		if (h === before) return `Up to date · ${h.slice(0, 7)}`;
		setRev((r) => r + 1);
		return `Updated to ${h.slice(0, 7)}`;
	};

	const scan: Scan | null = useMemo(() => (files ? { solidity: files.filter((f) => f.endsWith(".sol")), lean: files.filter((f) => f.endsWith(".lean")), truncated: false, git: true } : null), [files]);
	// Each step is its own history entry, so the back button walks back through folders and files.
	const go = (next: { tab?: Tab; dir?: string; file?: string | null }) => {
		const p = new URLSearchParams(params);
		if (next.tab) p.set("tab", next.tab);
		if (next.dir !== undefined) p.set("dir", next.dir);
		if (next.file !== undefined) {
			if (next.file) p.set("file", next.file);
			else p.delete("file");
		}
		if (next.dir !== undefined && next.file === undefined) p.delete("file");
		setParams(p);
	};
	const openFile = (path: string) => go({ tab: "code", dir: path.split("/").slice(0, -1).join("/"), file: path });
	const atRoot = tab !== "code" || (!dir && !file);

	const page = (
		<div className="relative flex h-dvh flex-col bg-background">
			{/* Chat is full screen, its controls floating over it (history on the left, as in Mike's); the rest keep the bar. */}
			{tab === "chat" ? (
				<FloatingBar back="/" left={<ChatsIcon className="size-[22px]" />} onLeft={() => setHistory(true)} leftLabel="Chat history" right={<ChatButtons />} />
			) : (
				<TopBar back={atRoot ? "/" : true} title={<ProjectSwitcher repo={repo} tab={tab} />} right={<BellLink />} />
			)}
			{error ? <p className="m-4 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">Couldn&apos;t clone {repo}: {error}</p> : null}
			<main className="flex min-h-0 flex-1 flex-col">
				{tab === "chat" ? (
					<ProjectChat repo={repo} />
				) : (
					<PullToRefresh onRefresh={refresh}>
						<div key={rev} className="flex min-h-0 flex-1 flex-col">
							{tab === "code" ? <CodeTab files={files} bridge={bridge} dir={dir} file={file} open={(n) => go(n)} /> : null}
							{tab === "proofs" ? <ProofsExplorer repo={repo} sources={scan?.solidity ?? null} invoke={bridge.invoke} onOpenFile={openFile} /> : null}
							{tab === "bugs" ? <BugsExplorer repo={repo} files={files} invoke={bridge.invoke} onOpenFile={openFile} /> : null}
						</div>
					</PullToRefresh>
				)}
			</main>
			<TabBar active={tab} repo={repo} />
		</div>
	);
	if (tab !== "chat") return page;
	return (
		<SlideDrawer open={history} onOpenChange={setHistory} drawer={<SessionHistory repo={repo} onPicked={() => setHistory(false)} />}>
			{page}
		</SlideDrawer>
	);
}

const folderKey = (repo: string) => `fm:mac-folder:${repo}`;
const runKey = (repo: string) => `fm:mac-run:${repo}`;
/** Which chat the Chat tab shows: "mac" for your Mac's swarm, else a Formal Mind conversation's id. */
const chatChoiceKey = (repo: string) => `fm:chat-choice:${repo}`;
const read = (key: string) => {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
};
const write = (key: string, value: string) => {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* kept for this visit */
	}
	window.dispatchEvent(new Event("fm:mac-pick"));
};
/** A remembered choice (the folder, the session), shared by the chat and its history drawer. */
function useStored(key: string): [string | null, (v: string) => void] {
	const value = useSyncExternalStore(
		(fn) => {
			window.addEventListener("fm:mac-pick", fn);
			return () => window.removeEventListener("fm:mac-pick", fn);
		},
		() => read(key),
	);
	return [value, (v) => write(key, v)];
}

/** The chat on the Chat tab: Formal Mind on formal.team by default (the latest conversation, or a new one), or your Mac. */
function useChatChoice(repo: string) {
	const [chosen, choose] = useStored(chatChoiceKey(repo));
	const [fresh] = useState(newCloudChatId);
	const latest = cloudChats(repo)[0]?.id;
	const choice = chosen ?? latest ?? fresh;
	return { mac: choice === "mac", chatId: choice === "mac" ? (latest ?? fresh) : choice, choose };
}

/** The Mac folder that is this repository: picked once, else the one whose origin it is. */
function useProjectFolder(repo: string) {
	const m = useMac();
	const [picked, pick] = useStored(folderKey(repo));
	const folders = m.state?.folders ?? [];
	const folder = folders.find((f) => f.path === picked) ?? folders.find((f) => f.repo?.toLowerCase() === repo.toLowerCase());
	return { m, folders, folder, pick };
}

/** The session followed: the one you picked, else one working now, else the folder's default session. */
function useChosenRun(repo: string, folder: RelayFolder | undefined) {
	const [chosen, pick] = useStored(runKey(repo));
	const running = folder?.sessions.find((s) => s.running)?.run;
	const run = chosen ?? running ?? "swarm";
	// A session that starts working while you follow none is the one you follow from then on.
	useEffect(() => {
		if (!chosen && running) pick(running);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running]);
	return { run, pick };
}

/** The chat's history drawer: the folder's sessions, newest first, and a new one. */
function SessionHistory({ repo, onPicked }: { repo: string; onPicked: () => void }) {
	const { user } = useAuth();
	const navigate = useNavigate();
	const { m, folder } = useProjectFolder(repo);
	const { run, pick } = useChosenRun(repo, folder);
	const { mac, chatId, choose } = useChatChoice(repo);
	const chats = useCloudChats(repo);
	const goMac = (r: string) => {
		pick(r);
		choose("mac");
		onPicked();
	};
	const goCloud = (id: string) => {
		choose(id);
		onPicked();
	};
	const row = (on: boolean) => `flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left active:bg-muted ${on ? "bg-card shadow-card" : ""}`;
	const caption = "px-5 pb-1 pt-4 font-mono text-[11px] uppercase tracking-wider text-muted-foreground";
	return (
		<div className="fm-safe-top flex h-full flex-col">
			<div className="px-5 pb-3 pt-4">
				<h2 className="truncate font-display text-[28px] leading-tight">{repo.split("/")[1]}</h2>
				<p className="truncate text-[13px] text-muted-foreground">Chats with Formal Mind, and your Mac's swarm</p>
			</div>
			<div className="px-3 pb-2">
				<button type="button" onClick={() => goCloud(newCloudChatId())} className="flex h-11 w-full items-center gap-2 rounded-full bg-card px-4 text-[15px] font-medium shadow-card active:bg-muted">
					<Plus className="size-4" /> New chat
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-10">
				<p className={caption}>Formal Mind</p>
				<ul>
					{chats.map((c) => (
						<li key={c.id}>
							{/* One line each, as a chat history. */}
							<button type="button" onClick={() => goCloud(c.id)} className={row(!mac && c.id === chatId)}>
								<span className="min-w-0 flex-1 truncate text-[15px]">{c.title}</span>
							</button>
						</li>
					))}
					{!chats.length ? <li className="px-3 py-2 text-[14px] text-muted-foreground">Your chats show here.</li> : null}
				</ul>
				<p className={caption}>{macName(m)}</p>
				<ul>
					{(folder?.sessions ?? []).map((s) => (
						<li key={s.run}>
							<button type="button" onClick={() => goMac(s.run)} className={row(mac && s.run === run)}>
								<span className={`min-w-0 flex-1 truncate text-[15px] ${s.running ? "font-medium" : ""}`}>{s.title || (s.run === "swarm" ? "Swarm" : s.run)}</span>
								<span className={`shrink-0 font-mono text-[12px] ${s.running ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{s.running ? "running" : `$${s.spent.toFixed(2)}`}</span>
							</button>
						</li>
					))}
					{folder ? (
						<li>
							<button type="button" onClick={() => goMac(`s-${Date.now().toString(16)}`)} className={`${row(false)} text-muted-foreground`}>
								<Plus className="size-4" /> New swarm session
							</button>
						</li>
					) : (
						<li>
							<button type="button" onClick={() => goMac(run)} className={`${row(mac)} text-muted-foreground`}>
								<Laptop className="size-4" /> {macName(m)}'s swarm
							</button>
						</li>
					)}
				</ul>
			</div>
			{/* You, and Settings, at the foot of the drawer. */}
			<div className="fm-safe-bottom flex items-center gap-3 border-t px-4 pt-3">
				<span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border bg-muted text-[14px] font-medium">
					{user.picture ? <img src={user.picture} alt="" className="size-full object-cover" /> : (user.name ?? user.nickname ?? "?").slice(0, 1).toUpperCase()}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[15px] font-medium">{user.name ?? user.nickname}</span>
					{user.nickname ? <span className="block truncate text-[12px] text-muted-foreground">@{user.nickname}</span> : null}
				</span>
				<button type="button" onClick={() => navigate("/settings")} aria-label="Settings" className="grid size-10 place-items-center rounded-full bg-card shadow-card active:bg-muted">
					<Settings className="size-5" />
				</button>
			</div>
		</div>
	);
}


/**
 * Chat: the swarm working on this repository on your Mac. The Mac says which GitHub repository each folder is; when
 * none matches (a renamed repository), you pick the folder once and it's remembered.
 */
function ProjectChat({ repo }: { repo: string }) {
	const { mac, chatId, choose } = useChatChoice(repo);
	if (!mac) return <CloudChat key={chatId} repo={repo} chatId={chatId} aboveTabs shelf={<ChatSwitch value="cloud" onChange={(v) => choose(v === "mac" ? "mac" : chatId)} />} />;
	return <MacChat repo={repo} />;
}

/** Which chat: Formal Mind (formal.team) or your Mac's swarm, as the composer's chip. */
function ChatSwitch({ value, onChange }: { value: "cloud" | "mac"; onChange: (v: "cloud" | "mac") => void }) {
	const name = macName(useMac());
	return (
		<select value={value} onChange={(e) => onChange(e.target.value as "cloud" | "mac")} aria-label="Chat with" className="max-w-full truncate bg-transparent text-[13px] text-foreground outline-none">
			<option value="cloud">Formal Mind</option>
			<option value="mac">{name}</option>
		</select>
	);
}

/** The Chat tab on your Mac's swarm (as before Formal Mind's chat was the default). */
function MacChat({ repo }: { repo: string }) {
	const { m, folders, folder, pick } = useProjectFolder(repo);
	if (!folder) {
		// No folder yet: why (centered, as the onboarding draws it), or which of the Mac's folders this repository is.
		if (!folders.length || !macOnline(m)) {
			return (
				<div className="fm-under-tabs fm-under-floating flex min-h-0 flex-1 flex-col">
					<MacState />
				</div>
			);
		}
		return (
			<div className="fm-under-tabs fm-under-floating min-h-0 flex-1 overflow-auto">
				<div className="px-4 py-4">
					<p className="mb-3 text-[14px] text-muted-foreground">Which folder on your Mac is {repo}?</p>
					<ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-card">
						{folders.map((f) => (
							<li key={f.path}>
								<button
									type="button"
									onClick={() => pick(f.path)}
									className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted"
								>
									<Laptop className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium">{f.name}</span>
										<span className="block truncate text-[12px] text-muted-foreground">{f.repo ?? f.path}</span>
									</span>
									<ChevronRight className="size-4 text-muted-foreground" />
								</button>
							</li>
						))}
					</ul>
				</div>
			</div>
		);
	}
	return <FolderChat repo={repo} folder={folder} />;
}

/** A folder's swarm chat, on the session followed (useChosenRun); the history drawer switches sessions, the chip back to Formal Mind. */
function FolderChat({ repo, folder }: { repo: string; folder: RelayFolder }) {
	const { run, pick } = useChosenRun(repo, folder);
	const { chatId, choose } = useChatChoice(repo);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<SessionChat
				key={`${folder.path}:${run}`}
				folder={folder.path}
				run={run}
				aboveTabs
				fullScreen
				header={<ChatSwitch value="mac" onChange={(v) => v === "cloud" && choose(chatId)} />}
			/>
		</div>
	);
}

/** The project's name in the bar, which switches project: your projects drop down under it (same tab), and Add. */
function ProjectSwitcher({ repo, tab }: { repo: string; tab: Tab }) {
	const [open, setOpen] = useState(false);
	const projects = useProjects();
	const navigate = useNavigate();
	return (
		<>
			<button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex max-w-full items-center gap-1 active:opacity-60">
				<span className="truncate">
					<span className="font-light text-muted-foreground">{repo.split("/")[0]}/</span>
					<span className="font-semibold text-foreground">{repo.split("/")[1]}</span>
				</span>
				<ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
			</button>
			{/* On the page itself: the bar's blur would otherwise hold the fixed menu inside it. */}
			{open ? createPortal(
				<>
					<button type="button" aria-label="Close" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
					<div className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-50 rounded-2xl border bg-muted/60 p-1.5 shadow-pop backdrop-blur-xl">
						<p className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Projects</p>
						<ul className="shadow-card max-h-[60dvh] divide-y overflow-y-auto rounded-xl border bg-card">
							{projects?.map((p) => (
								<li key={p.repo}>
									<button
										type="button"
										onClick={() => {
											setOpen(false);
											if (p.repo !== repo) navigate(`${projectPath(p.repo)}?tab=${tab}`);
										}}
										className="flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] font-normal active:bg-muted"
									>
										<MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate">
											<span className="font-light text-muted-foreground">{p.repo.split("/")[0]}/</span>
											<span className="font-semibold text-foreground">{p.repo.split("/")[1]}</span>
										</span>
										{p.repo === repo ? <Check className="size-4 text-foreground" /> : null}
									</button>
								</li>
							))}
							<li>
								<button type="button" onClick={() => navigate("/")} className="flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] font-normal active:bg-muted">
									<Plus className="size-4 text-muted-foreground" /> Add a project
								</button>
							</li>
						</ul>
					</div>
				</>,
				document.body,
			) : null}
		</>
	);
}
