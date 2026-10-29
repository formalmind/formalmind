import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { Component, Suspense, createContext, lazy, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** The new version (SPEC.md B64, B65): one project, a copy of Formal Mind itself in ~/.formalmind/formalmind. The
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
		setLines((l) => [...l, { who: "you", text: goal }]);
		setBusy(true);
		invoke("agent_start", { folder, goal })
			.catch((e) => setLines((l) => [...l, { who: "error", text: String(e) }]))
			.finally(() => setBusy(false));
	};
	return { folder, files, chats, chatId, setChatId, left, setLeft, busy, lines, send };
}

const Ctx = createContext<ReturnType<typeof useWorkbenchState> | null>(null);
const useWorkbench = () => useContext(Ctx)!;

export function WorkbenchProvider({ children }: { children: ReactNode }) {
	return <Ctx.Provider value={useWorkbenchState()}>{children}</Ctx.Provider>;
}

/** The sidebar: the project's files, or its chats. */
export function WorkbenchSide() {
	const { folder, files, chats, chatId, setChatId, left, setLeft, busy } = useWorkbench();
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
				<div className="min-h-0 flex-1 overflow-auto px-2 font-mono text-muted-foreground">
					<div className="px-1 pb-2 text-foreground">{folder.split(/[\\/]/).filter(Boolean).pop()}</div>
					{files.map((f) => (
						<div key={f} className="truncate px-1 py-0.5" title={f}>
							{f}
						</div>
					))}
				</div>
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
	const { busy, lines, send } = useWorkbench();
	const [draft, setDraft] = useState("");
	const [viewer, setViewer] = useState(() => localStorage.getItem("fm:viewer") === "1");
	const end = useRef<HTMLDivElement>(null);
	useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);
	useEffect(() => localStorage.setItem("fm:viewer", viewer ? "1" : "0"), [viewer]);
	const submit = () => {
		if (!draft.trim() || busy) return;
		send(draft.trim());
		setDraft("");
	};

	return (
		<div className="flex h-full min-h-0 text-[13px]">
			<section className="flex min-w-0 flex-1 flex-col">
				<div className="flex justify-end border-b px-3 py-1.5">
					<button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setViewer((v) => !v)}>
						{viewer ? "Hide components" : "Components"}
					</button>
				</div>
				<div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
					{lines.map((l, i) => (
						<div key={i} className={l.who === "you" ? "text-foreground" : l.who === "tool" ? "font-mono text-muted-foreground" : l.who === "error" ? "text-destructive" : "whitespace-pre-wrap text-foreground/80"}>
							{l.text}
						</div>
					))}
					{busy ? <div className="text-muted-foreground">Working…</div> : null}
					<div ref={end} />
				</div>
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
			</section>
			{viewer ? (
				<section className="w-1/2 min-w-0 shrink-0 border-l">
					<ComponentViewer />
				</section>
			) : null}
		</div>
	);
}

// AffectUI's components when the private package is checked out (packages/ui); none without it.
const modules = import.meta.glob<Record<string, unknown>>("../../packages/ui/components/*.tsx");
const nameOf = (path: string) => path.split("/").pop()!.replace(/\.tsx$/, "");
const pascal = (name: string) => name.replace(/-clean$/, "").replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());

function ComponentViewer() {
	const names = useMemo(() => Object.keys(modules).map(nameOf).sort(), []);
	const [picked, setPicked] = useState(() => localStorage.getItem("fm:viewer-pick") ?? names[0] ?? "");
	useEffect(() => localStorage.setItem("fm:viewer-pick", picked), [picked]);
	const Shown = useMemo(() => {
		const load = modules[`../../packages/ui/components/${picked}.tsx`];
		if (!load) return null;
		return lazy(async () => {
			const m = await load();
			const C = (m[pascal(picked)] ?? Object.values(m).find((v) => typeof v === "function")) as (() => ReactNode) | undefined;
			return { default: C ?? (() => <p>No component exported.</p>) };
		});
	}, [picked]);
	if (!names.length) return <p className="p-4 text-muted-foreground">AffectUI isn't checked out: git submodule update --init packages/ui</p>;
	return (
		<div className="flex h-full min-h-0">
			<nav className="w-48 shrink-0 overflow-auto border-r py-1">
				{names.map((n) => (
					<button key={n} type="button" onClick={() => setPicked(n)} className={`block w-full truncate px-3 py-0.5 text-left ${n === picked ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
						{n}
					</button>
				))}
			</nav>
			<div className="min-w-0 flex-1 overflow-auto p-4">
				<Caught key={picked}>
					<Suspense fallback={null}>{Shown ? <Shown /> : null}</Suspense>
				</Caught>
			</div>
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
