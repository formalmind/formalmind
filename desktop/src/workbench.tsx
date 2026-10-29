import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { useLocation, useNavigate } from "react-router";
import { FileTree } from "@/components/file-tree";
import { TreeFolder } from "@/components/session-folder";
import { HomeEmpty } from "@/components/home-empty";
import { useResizable } from "./resize-handle";
import { Component, Suspense, createContext, lazy, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** The agent page (SPEC.md B64, B65): one project, a copy of Formal Mind itself in ~/.formalmind/formalmind. The
 * sidebar shows its files or the chats; the page is a chat with the agent that reads and writes those files, with
 * AffectUI's components in a half screen beside it. */

type Step =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; input: Record<string, unknown>; output: string }
	| { kind: "done" }
	| { kind: "error"; error: string };
type Line = { who: "you" | "agent" | "tool" | "error"; text: string };
type Chat = { id: string; title: string; lines: Line[] };

// Chats are kept per folder in this window's storage.
const chatsKey = (folder: string) => `fm:chats:${folder}`;
const loadChats = (folder: string): Chat[] => {
	try {
		return JSON.parse(localStorage.getItem(chatsKey(folder)) ?? "[]");
	} catch {
		return [];
	}
};
const newChat = (): Chat => ({ id: crypto.randomUUID(), title: "New chat", lines: [] });

function useWorkbenchState() {
	const [folder, setFolder] = useState("");
	useEffect(() => void homeDir().then((h) => join(h, ".formalmind", "formalmind")).then(setFolder), []);
	const [files, setFiles] = useState<string[]>([]);
	const [chats, setChats] = useState<Chat[]>([]);
	const [chatId, setChatId] = useState<string | null>(null);
	const [left, setLeft] = useState<"files" | "chats">("files");
	const [busy, setBusy] = useState(false);
	const [file, setFile] = useState<string | null>(null);
	const lines = chats.find((c) => c.id === chatId)?.lines ?? [];
	// Adds lines to the open chat, starting one (titled by its first message) when none is open.
	const live = useRef(chatId);
	live.current = chatId;
	const setLines = (f: (l: Line[]) => Line[]) =>
		setChats((cs) => {
			let id = live.current;
			let next = cs;
			if (!id || !cs.some((c) => c.id === id)) {
				const c = newChat();
				id = live.current = c.id;
				setChatId(c.id);
				next = [c, ...cs];
			}
			return next.map((c) => {
				if (c.id !== id) return c;
				const l = f(c.lines);
				return { ...c, lines: l, title: c.lines.length ? c.title : (l.find((x) => x.who === "you")?.text.slice(0, 60) ?? c.title) };
			});
		});
	useEffect(() => {
		if (!folder) return;
		setChats(loadChats(folder));
		setChatId(loadChats(folder)[0]?.id ?? null);
	}, [folder]);
	useEffect(() => void (folder && localStorage.setItem(chatsKey(folder), JSON.stringify(chats))), [folder, chats]);

	const look = () => void (folder && invoke<{ files: string[] }>("folder_tree", { path: folder }).then((t) => setFiles(t.files), () => setFiles([])));
	useEffect(look, [folder]);
	useEffect(() => {
		const off = listen<{ folder: string; step: Step }>("agent", ({ payload }) => {
			if (payload.folder !== folder) return;
			const s = payload.step;
			if (s.kind === "text" && s.text) setLines((l) => [...l, { who: "agent", text: s.text }]);
			if (s.kind === "tool") {
				setLines((l) => [...l, { who: "tool", text: `${s.name} ${String(s.input.path ?? s.input.pattern ?? s.input.dir ?? "")}` }]);
				if (s.name === "write_file" || s.name === "edit_file") look();
			}
			if (s.kind === "error") setLines((l) => [...l, { who: "error", text: s.error }]);
		});
		return () => void off.then((f) => f());
	}, [folder]);

	const send = (goal: string) => {
		if (!goal || busy || !folder) return;
		// A first message starts its chat here, so the run knows its id.
		if (!live.current) {
			const c = newChat();
			live.current = c.id;
			setChats((cs) => [c, ...cs]);
			setChatId(c.id);
		}
		setLines((l) => [...l, { who: "you", text: goal }]);
		setBusy(true);
		// The chat's id is its Claude Code session (and names its Codex thread), so the agent remembers it.
		invoke("agent_start", { folder, goal, chat: live.current, provider: localStorage.getItem("fm:provider") || "claude-code", model: localStorage.getItem("fm:model") || null })
			.catch((e) => setLines((l) => [...l, { who: "error", text: String(e) }]))
			.finally(() => setBusy(false));
	};
	return { folder, files, file, setFile, chats, chatId, setChatId, left, setLeft, busy, lines, send };
}

/** The project's folder (~/.formalmind/formalmind), once known. */
export function useProjectFolder() {
	return useContext(Ctx)?.folder ?? "";
}

const Ctx = createContext<ReturnType<typeof useWorkbenchState> | null>(null);
const useWorkbench = () => useContext(Ctx)!;

export function WorkbenchProvider({ children }: { children: ReactNode }) {
	return <Ctx.Provider value={useWorkbenchState()}>{children}</Ctx.Provider>;
}

/** The sidebar: the project's files, or its chats. */
export function WorkbenchSide() {
	const w = useWorkbench();
	const { folder, files, file, chats, chatId, left, busy } = w;
	// Anything picked here shows on the project page, so from Settings it goes back there.
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const home = () => pathname !== "/agent" && navigate("/agent");
	const setLeft = (k: "files" | "chats") => (w.setLeft(k), home());
	const setFile = (f: string) => (w.setFile(f), home());
	const setChatId = (id: string | null) => (w.setChatId(id), home());
	return (
		<div className="flex min-h-0 flex-1 flex-col text-[13px] group-data-[collapsible=icon]:hidden">
			<div className="flex gap-3 px-3 py-1.5">
				{(["files", "chats"] as const).map((k) => (
					<button key={k} type="button" onClick={() => setLeft(k)} className={left === k ? "text-foreground" : "text-muted-foreground hover:text-foreground"}>
						{k === "files" ? "Files" : "Chats"}
					</button>
				))}
			</div>
			{left === "files" ? (
				<ul className="min-h-0 flex-1 overflow-auto px-2">
					<TreeFolder name={folder.split(/[\\/]/).filter(Boolean).pop() ?? "formalmind"} title={folder} href="/" current>
						<FileTree paths={files} selected={file} storageKey={`fm:tree:${folder}`} onOpen={setFile} />
					</TreeFolder>
				</ul>
			) : (
				<div className="min-h-0 flex-1 overflow-auto px-2">
					<button type="button" disabled={busy} onClick={() => setChatId(null)} className="block w-full px-1 py-0.5 text-left text-muted-foreground hover:text-foreground">
						New chat
					</button>
					{chats.map((c) => (
						<button key={c.id} type="button" disabled={busy} onClick={() => setChatId(c.id)} className={`block w-full truncate px-1 py-0.5 text-left ${c.id === chatId ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
							{c.title}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** The page: the chat and its input, and the components half screen. */
export function Workbench() {
	const { busy, lines, send, left, folder, file } = useWorkbench();
	const [draft, setDraft] = useState("");
	const [viewer, setViewer] = useState(() => localStorage.getItem("fm:viewer") === "1");
	const end = useRef<HTMLDivElement>(null);
	// The components half screen: its left edge drags.
	const pane = useResizable("fm:viewer-width", Math.round(window.innerWidth / 2), 280, Math.max(320, window.innerWidth - 480), "left");
	useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);
	useEffect(() => localStorage.setItem("fm:viewer", viewer ? "1" : "0"), [viewer]);
	const submit = () => {
		if (!draft.trim() || busy) return;
		send(draft.trim());
		setDraft("");
	};

	const toggle = (
		<button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setViewer((v) => !v)}>
			{viewer ? "Hide components" : "Components"}
		</button>
	);
	return (
		<div className="flex h-full min-h-0 text-[13px]">
			{left === "files" ? <FileView folder={folder} file={file} toggle={toggle} /> : <section className="flex min-w-0 flex-1 flex-col">
				<div className="flex justify-end border-b px-3 py-1.5">{toggle}</div>
				{lines.length || busy ? <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
					{lines.map((l, i) => (
						<div key={i} className={l.who === "you" ? "text-foreground" : l.who === "tool" ? "font-mono text-muted-foreground" : l.who === "error" ? "text-destructive" : "whitespace-pre-wrap text-foreground/80"}>
							{l.text}
						</div>
					))}
					{busy ? <div className="text-muted-foreground">Working…</div> : null}
					<div ref={end} />
				</div> : <HomeEmpty muted="Bugs, proofs and code." strong="What should we change?" />}
				<div className="flex gap-2 border-t p-3">
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit();
							}
						}}
						rows={2}
						placeholder="Ask the agent to change Formal Mind"
						className="min-w-0 flex-1 resize-none rounded-lg border bg-card p-2 outline-none"
					/>
					{busy ? (
						<button type="button" className="rounded-lg border px-3" onClick={() => void invoke("agent_stop")}>
							Stop
						</button>
					) : (
						<button type="button" className="rounded-lg border px-3" disabled={!draft.trim()} onClick={submit}>
							Send
						</button>
					)}
				</div>
			</section>}
			{viewer ? (
				<section className="relative min-w-0 shrink-0 border-l" style={{ width: pane.size }}>
					{pane.handle}
					<ComponentViewer />
				</section>
			) : null}
		</div>
	);
}

/** The file picked in the sidebar's tree, as text; it reads again when the agent writes. */
function FileView({ folder, file, toggle }: { folder: string; file: string | null; toggle: ReactNode }) {
	const [text, setText] = useState("");
	useEffect(() => {
		if (!file) return;
		const read = () => void invoke<string>("folder_read", { folder, path: file }).then(setText, (e) => setText(`Couldn't read ${file}: ${e}`));
		read();
		const off = listen<{ step: Step }>("agent", ({ payload }) => payload.step.kind === "tool" && read());
		return () => void off.then((f) => f());
	}, [folder, file]);
	return (
		<section className="flex min-w-0 flex-1 flex-col">
			<div className="flex justify-between gap-3 border-b px-3 py-1.5">
				<span className="truncate font-mono text-muted-foreground">{file ?? ""}</span>
				{toggle}
			</div>
			{file ? <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5">{text}</pre> : <div className="grid flex-1 place-items-center text-muted-foreground">Pick a file in the sidebar.</div>}
		</section>
	);
}

// AffectUI's components when the private package is checked out (packages/ui); none without it.
// Screens and blocks carry their own demo data; most components need theirs passed in.
const modules = import.meta.glob<Record<string, unknown>>(["../../packages/ui/screens/*.tsx", "../../packages/ui/blocks/*.tsx", "../../packages/ui/components/*.tsx"]);
const KINDS = ["screens", "blocks", "components"];
// Sample data for the ones that need it: packages/ui/formalmind/demos/<kind>--<name>.tsx, each a default export.
const demos = import.meta.glob<{ default: () => ReactNode }>("../../packages/ui/formalmind/demos/*.tsx");
const nameOf = (path: string) => path.split("/").slice(-2).join("/").replace(/\.tsx$/, "");
const rank = (n: string) => KINDS.indexOf(n.split("/")[0]);
const pascal = (name: string) => name.split("/").pop()!.replace(/-clean$/, "").replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());

function ComponentViewer() {
	const names = useMemo(() => Object.keys(modules).map(nameOf).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)), []);
	const list = useResizable("fm:viewer-list", 192, 120, 400, "right");
	const [picked, setPicked] = useState(() => (names.includes(localStorage.getItem("fm:viewer-pick") ?? "") ? localStorage.getItem("fm:viewer-pick")! : names[0]) ?? "");
	useEffect(() => localStorage.setItem("fm:viewer-pick", picked), [picked]);
	const Shown = useMemo(() => {
		const demo = demos[`../../packages/ui/formalmind/demos/${picked.replace("/", "--")}.tsx`];
		if (demo) return lazy(demo);
		const load = modules[`../../packages/ui/${picked}.tsx`];
		if (!load) return null;
		return lazy(async () => {
			const m = await load();
			const C = (m[pascal(picked)] ?? m[`${pascal(picked)}Screen`] ?? Object.values(m).find((v) => typeof v === "function")) as (() => ReactNode) | undefined;
			return { default: C ?? (() => <p>No component exported.</p>) };
		});
	}, [picked]);
	if (!names.length) return <p className="p-4 text-muted-foreground">AffectUI isn't checked out: git submodule update --init packages/ui</p>;
	return (
		<div className="flex h-full min-h-0">
			<nav className="relative shrink-0 overflow-auto border-r py-1" style={{ width: list.size }}>
				{list.handle}
				{names.map((n) => (
					<button key={n} type="button" onClick={() => setPicked(n)} className={`block w-full truncate px-3 py-0.5 text-left ${n === picked ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
						{n}
					</button>
				))}
			</nav>
			<Stage screen={picked.startsWith("screens/")}>
				<Caught key={picked}>
					<Suspense fallback={null}>{Shown ? <Shown /> : null}</Suspense>
				</Caught>
			</Stage>
		</div>
	);
}

/** Where a component is drawn. Screens are whole desktop pages that fold up below 900px, so they get a 1280×800
 * canvas scaled down to the pane's width. */
function Stage({ screen, children }: { screen: boolean; children: ReactNode }) {
	const box = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const zoom = Math.min(1, Math.max(0.2, (width - 32) / 1280));
	return (
		<div ref={box} className="min-w-0 flex-1 overflow-auto p-4">
			{screen ? <div style={{ width: 1280, height: 800, zoom }}>{children}</div> : children}
		</div>
	);
}

class Caught extends Component<{ children: ReactNode }, { error: string | null }> {
	state = { error: null as string | null };
	static getDerivedStateFromError(e: unknown) {
		return { error: String(e) };
	}
	render() {
		return this.state.error ? <p className="text-destructive">{this.state.error}</p> : this.props.children;
	}
}

/** The page at /agent: the project's files or chats beside the chat. */
export function AgentPage() {
	return (
		<WorkbenchProvider>
			<div className="flex h-full min-h-0">
				<aside className="flex w-64 shrink-0 flex-col border-r pt-2">
					<WorkbenchSide />
				</aside>
				<div className="min-w-0 flex-1">
					<Workbench />
				</div>
			</div>
		</WorkbenchProvider>
	);
}
