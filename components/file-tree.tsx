import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, FileCode2, Folder, FolderOpen, Loader2, Play } from "lucide-react";

type Node = { name: string; path: string; dir: boolean; children: Node[] };

/** A function a file can run in the debugger: a script's run…() or a test's test…(). */
export type Runnable = { contract: string; fn: string };

/** Files that list runnable functions under them, and what running one does. */
export type Runnables = {
	has: (path: string) => boolean;
	list: (path: string) => Promise<Runnable[]>;
	onRun: (path: string, r: Runnable) => void;
	/** The function being debugged, as `path::Contract::fn`. */
	current?: string | null;
	/** The last result of a file (any of its functions) or of one function: filled when it passed, red when it failed. */
	result?: (path: string, r?: Runnable) => "pass" | "fail" | undefined;
};

/** Play: outlined before a run, filled once it passed, red when it failed. */
function playClass(result: "pass" | "fail" | undefined) {
	return result === "pass" ? "fill-current text-emerald-600" : result === "fail" ? "fill-current text-red-500" : "text-emerald-600";
}

/** A tree from flat file paths (`src/vault/Vault.sol`): folders first, then files, each by name. */
function build(paths: string[]): Node[] {
	const root: Node = { name: "", path: "", dir: true, children: [] };
	for (const p of paths) {
		const parts = p.split("/").filter(Boolean);
		let at = root;
		parts.forEach((part, i) => {
			const path = parts.slice(0, i + 1).join("/");
			const dir = i < parts.length - 1;
			let next = at.children.find((c) => c.name === part && c.dir === dir);
			if (!next) {
				next = { name: part, path, dir, children: [] };
				at.children.push(next);
			}
			at = next;
		});
	}
	const sort = (n: Node) => {
		n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
		n.children.forEach(sort);
	};
	sort(root);
	return root.children;
}

const CODE = /\.(sol|lean|ts|tsx|js|rs|py|toml|json|yaml|yml|md)$/;

function readOpen(key: string): Set<string> | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? new Set(JSON.parse(raw) as string[]) : null;
	} catch {
		return null;
	}
}

/**
 * A project's files in the sidebar. Folders fold (remembered per project); a file opens with `onOpen`. Arrow keys
 * move between rows, → / ← open and close a folder, Enter opens a file.
 */
export function FileTree({ paths, selected, onOpen, storageKey, truncated, runnables }: {
	paths: string[];
	selected?: string | null;
	onOpen: (path: string) => void;
	/** Where open folders are remembered. */
	storageKey: string;
	truncated?: boolean;
	/** Scripts and tests: a chevron lists their functions; clicking one debugs it. */
	runnables?: Runnables;
}) {
	// Files whose functions are listed, and the functions read from them.
	const [fnsOpen, setFnsOpen] = useState<Set<string>>(new Set());
	const [fns, setFns] = useState<Record<string, Runnable[] | "loading">>({});
	const toggleFns = (path: string) => {
		const next = new Set(fnsOpen);
		if (next.has(path)) next.delete(path);
		else {
			next.add(path);
			if (!fns[path] && runnables) {
				setFns((f) => ({ ...f, [path]: "loading" }));
				void runnables.list(path).then(
					(list) => setFns((f) => ({ ...f, [path]: list })),
					() => setFns((f) => ({ ...f, [path]: [] })),
				);
			}
		}
		setFnsOpen(next);
	};
	// The row's play button: a file with one function runs it; otherwise its functions are listed to pick from.
	const play = (path: string) => {
		if (!runnables) return;
		const known = fns[path];
		const go = (list: Runnable[]) => {
			if (list.length === 1) runnables.onRun(path, list[0]);
			else setFnsOpen((o) => new Set(o).add(path));
		};
		if (Array.isArray(known)) return go(known);
		setFns((f) => ({ ...f, [path]: "loading" }));
		void runnables.list(path).then(
			(list) => {
				setFns((f) => ({ ...f, [path]: list }));
				go(list);
			},
			() => setFns((f) => ({ ...f, [path]: [] })),
		);
	};
	const tree = useMemo(() => build(paths), [paths]);
	const [open, setOpen] = useState<Set<string>>(() => {
		const saved = readOpen(storageKey);
		if (saved) return saved;
		// First visit: the top-level source folders start open.
		return new Set(tree.filter((n) => n.dir && ["src", "contracts", "formal"].includes(n.name)).map((n) => n.path));
	});
	// The selected file's folders open so it's visible.
	useEffect(() => {
		if (!selected) return;
		const parts = selected.split("/");
		setOpen((o) => {
			const next = new Set(o);
			for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
			return next.size === o.size ? o : next;
		});
	}, [selected]);
	useEffect(() => {
		try {
			localStorage.setItem(storageKey, JSON.stringify([...open]));
		} catch {
			// Not kept: folders start as on a first visit.
		}
	}, [open, storageKey]);

	const toggle = (path: string, to?: boolean) =>
		setOpen((o) => {
			const next = new Set(o);
			if (to ?? !next.has(path)) next.add(path);
			else next.delete(path);
			return next;
		});

	// Visible rows in order, for keyboard navigation.
	const rows: { node: Node; depth: number }[] = [];
	const walk = (nodes: Node[], depth: number) => {
		for (const n of nodes) {
			rows.push({ node: n, depth });
			if (n.dir && open.has(n.path)) walk(n.children, depth + 1);
		}
	};
	walk(tree, 0);

	const list = useRef<HTMLUListElement>(null);
	const focus = (i: number) => list.current?.querySelectorAll<HTMLButtonElement>("button[data-row]")[i]?.focus();
	const onKey = (e: React.KeyboardEvent, i: number, n: Node) => {
		if (e.key === "ArrowDown") focus(Math.min(i + 1, rows.length - 1));
		else if (e.key === "ArrowUp") focus(Math.max(i - 1, 0));
		else if (e.key === "ArrowRight" && n.dir) toggle(n.path, true);
		else if (e.key === "ArrowLeft") {
			if (n.dir && open.has(n.path)) toggle(n.path, false);
			else {
				const parent = n.path.split("/").slice(0, -1).join("/");
				const at = rows.findIndex((r) => r.node.path === parent);
				if (at >= 0) focus(at);
			}
		} else return;
		e.preventDefault();
	};

	return (
		<ul ref={list} role="tree" className="flex flex-col pb-2">
			{rows.map(({ node, depth }, i) => {
				const isOpen = node.dir && open.has(node.path);
				const active = !node.dir && node.path === selected;
				const runs = !node.dir && runnables?.has(node.path);
				const fnOpen = runs && fnsOpen.has(node.path);
				const listed = fns[node.path];
				return (
					<li key={node.path} role="treeitem" aria-expanded={node.dir ? isOpen : undefined} aria-selected={active}>
						<button
							type="button"
							data-row
							onClick={() => (node.dir ? toggle(node.path) : onOpen(node.path))}
							onKeyDown={(e) => onKey(e, i, node)}
							title={node.path}
							style={{ paddingLeft: 8 + depth * 12 }}
							className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring ${active ? "bg-sidebar-accent text-sidebar-foreground" : "text-sidebar-foreground/85"}`}
						>
							{node.dir ? (
								<>
									<ChevronRight className={`size-3 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} />
									{isOpen ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" />}
								</>
							) : (
								<>
									<span className="w-3 shrink-0" />
									{CODE.test(node.name) ? <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
								</>
							)}
							<span className="truncate">{node.name}</span>
							{/* The play button: one function runs it, several open (and close) the list to pick from. */}
							{runs ? (
								<span
									role="button"
									tabIndex={-1}
									aria-label={`Debug ${node.name}`}
									title={fnOpen ? "Hide its functions" : node.path.endsWith(".s.sol") ? "Debug this script" : "Debug a test in this file"}
									onClick={(e) => {
										e.stopPropagation();
										if (fnOpen) toggleFns(node.path);
										else play(node.path);
									}}
									className="-my-1 -mr-1 ml-auto grid shrink-0 place-items-center rounded p-1 text-emerald-600 hover:bg-emerald-500/15"
								>
									{listed === "loading" ? <Loader2 className="size-3 animate-spin" /> : <Play className={`size-3 transition-transform ${playClass(runnables?.result?.(node.path))} ${fnOpen ? "rotate-90" : ""}`} />}
								</span>
							) : null}
						</button>
						{fnOpen ? (
							<ul className="flex flex-col">
								{listed === "loading" ? (
									<li style={{ paddingLeft: 32 + depth * 12 }} className="flex h-6 items-center gap-1.5 text-[12px] text-muted-foreground">
										<Loader2 className="size-3 animate-spin" />
										Reading…
									</li>
								) : listed?.length ? (
									listed.map((r) => {
										const key = `${node.path}::${r.contract}::${r.fn}`;
										return (
											<li key={key}>
												<button
													type="button"
													onClick={() => runnables?.onRun(node.path, r)}
													title={`Debug ${r.contract}.${r.fn}()`}
													style={{ paddingLeft: 32 + depth * 12 }}
													className={`flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left font-mono text-[12px] outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring ${runnables?.current === key ? "bg-amber-500/15 text-sidebar-foreground" : "text-sidebar-foreground/80"}`}
												>
													<Play className={`size-3 shrink-0 ${playClass(runnables?.result?.(node.path, r))}`} />
													<span className="truncate">{r.fn}</span>
												</button>
											</li>
										);
									})
								) : (
									<li style={{ paddingLeft: 32 + depth * 12 }} className="flex h-6 items-center text-[12px] text-muted-foreground">
										{node.path.endsWith(".s.sol") ? "No run…() without arguments" : "No test…() without arguments"}
									</li>
								)}
							</ul>
						) : null}
					</li>
				);
			})}
			{truncated ? <li className="px-2 pt-1 text-[11px] text-muted-foreground">Only the first files are listed.</li> : null}
		</ul>
	);
}
