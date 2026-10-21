import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronRight, FileCode2, Folder, Laptop, Loader2 } from "lucide-react";
import { makeGitBridge } from "@/components/projects/git-bridge";
import { repoOf } from "@/components/projects/use-projects";
import { BellLink } from "./notifications";
import { ChatMarkdown } from "@/components/chat-markdown";
import { cachedTree, syncRepo } from "@/lib/browser-git";
import { AuditView, BugsView, FileView, type Bug } from "@/desktop/src/swarm-panel";
import { FloatingBar, TopBar } from "./bar";
import { ChatButtons, Offline, SessionChat } from "./mac";
import { macOnline, useMac } from "./relay";
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
					<p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading…</p>
				) : "error" in text ? (
					<p className="p-4 text-sm text-red-600">{text.error}</p>
				) : /\.(md|markdown)$/i.test(file) ? (
					<div className="p-4"><ChatMarkdown>{text.text}</ChatMarkdown></div>
				) : (
					<FileView path={file} text={text.text} />
				)}
			</div>
		);
	}
	if (!files) return <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Cloning the repository…</p>;
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
	const bridge = useMemo(() => makeGitBridge(repo), [repo]);
	const [files, setFiles] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [bugs, setBugs] = useState<Bug[]>([]);
	const [openBug, setOpenBug] = useState<string | null>(null);
	useEffect(() => rememberProject(repo), [repo]);

	useEffect(() => {
		let live = true;
		setFiles(null);
		setError(null);
		void (async () => {
			const cached = await cachedTree(repo).catch(() => null);
			if (cached && live) setFiles(cached.files);
			// Fetch the newest commit (a clone the first time); the cached copy serves meanwhile.
			const fresh = await syncRepo(repo).then(() => cachedTree(repo)).catch((e) => {
				if (!cached && live) setError(String(e?.message ?? e));
				return null;
			});
			if (fresh && live) setFiles(fresh.files);
		})();
		void bridge.invoke<Bug[]>("swarm_bugs").then((b) => live && setBugs(b), () => {});
		return () => {
			live = false;
		};
	}, [repo, bridge]);

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

	return (
		<div className="relative flex h-dvh flex-col bg-background">
			{/* Chat is full screen, its controls floating over it; the other tabs keep the bar. */}
			{tab === "chat" ? <FloatingBar back="/" title={name} right={<ChatButtons />} /> : <TopBar back={atRoot ? "/" : true} title={name} sub={owner} right={<BellLink />} />}
			{error ? <p className="m-4 rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">Couldn&apos;t clone {repo}: {error}</p> : null}
			<main className="flex min-h-0 flex-1 flex-col">
				{tab === "code" ? <CodeTab files={files} bridge={bridge} dir={dir} file={file} open={(n) => go(n)} /> : null}
				{tab === "proofs" ? (
					<div className="fm-phone-panel flex min-h-0 flex-1 flex-col overflow-hidden">
						<AuditView folder={repo} scan={scan} invoke={bridge.invoke} onOpenFile={openFile} />
					</div>
				) : null}
				{tab === "chat" ? <ProjectChat repo={repo} /> : null}
				{tab === "bugs" ? (
					<div className="fm-phone-panel relative min-h-0 flex-1 overflow-auto">
						<BugsView folder={repo} files={files ?? []} invoke={bridge.invoke} apiBase={bridge.apiBase} bugs={bugs} openBug={openBug} setOpenBug={setOpenBug} withPoc={async (body) => body} onOpenFile={openFile} />
					</div>
				) : null}
			</main>
			<TabBar active={tab} repo={repo} />
		</div>
	);
}

const folderKey = (repo: string) => `fm:mac-folder:${repo}`;

/**
 * Chat: the swarm working on this repository on your Mac. The Mac says which GitHub repository each folder is; when
 * none matches (a renamed repository), you pick the folder once and it's remembered.
 */
function ProjectChat({ repo }: { repo: string }) {
	const m = useMac();
	const [picked, setPicked] = useState(() => {
		try {
			return localStorage.getItem(folderKey(repo));
		} catch {
			return null;
		}
	});
	const folders = m.state?.folders ?? [];
	const folder = folders.find((f) => f.path === picked) ?? folders.find((f) => f.repo?.toLowerCase() === repo.toLowerCase());
	if (!folder) {
		return (
			<div className="fm-under-tabs fm-under-floating min-h-0 flex-1 overflow-auto">
				<Offline />
				<div className="px-4 py-4">
					<p className="mb-3 text-[14px] text-muted-foreground">{folders.length ? `Which folder on your Mac is ${repo}?` : macOnline(m) ? "No folders on your Mac yet." : "Waiting for your Mac…"}</p>
					<ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-card">
						{folders.map((f) => (
							<li key={f.path}>
								<button
									type="button"
									onClick={() => {
										setPicked(f.path);
										try {
											localStorage.setItem(folderKey(repo), f.path);
										} catch {
											/* asked again next time */
										}
									}}
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

const runKey = (repo: string) => `fm:mac-run:${repo}`;

/** A folder's swarm chat: the session you picked (kept), else one working now, else the folder's default session. */
function FolderChat({ repo, folder }: { repo: string; folder: RelayFolder }) {
	const [chosen, setChosen] = useState(() => {
		try {
			return localStorage.getItem(runKey(repo));
		} catch {
			return null;
		}
	});
	const running = folder.sessions.find((s) => s.running)?.run;
	const run = (chosen && folder.sessions.some((s) => s.run === chosen) ? chosen : null) ?? running ?? "swarm";
	// A session that starts working while you're here is the one you're following from then on.
	useEffect(() => {
		if (!chosen && running) pick(running);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running]);
	const pick = (next: string) => {
		setChosen(next);
		try {
			localStorage.setItem(runKey(repo), next);
		} catch {
			/* kept for this visit */
		}
	};
	const label = (r: string) => {
		const s = folder.sessions.find((x) => x.run === r);
		return `${s?.title || (r === "swarm" ? "Swarm" : r)}${s?.running ? " · running" : ""}`;
	};
	const runs = folder.sessions.some((s) => s.run === run) ? folder.sessions.map((s) => s.run) : [run, ...folder.sessions.map((s) => s.run)];
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<SessionChat
				key={`${folder.path}:${run}`}
				folder={folder.path}
				run={run}
				aboveTabs
				fullScreen
				header={
					<select value={run} onChange={(e) => pick(e.target.value)} aria-label="Session" className="max-w-full truncate bg-transparent text-[13px] text-foreground outline-none">
						{runs.map((r) => (
							<option key={r} value={r}>
								{folder.name} · {label(r)}
							</option>
						))}
					</select>
				}
			/>
		</div>
	);
}
