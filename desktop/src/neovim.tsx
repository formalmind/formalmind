import { memo, useEffect, useRef, useState } from "react";
import type { Bridge } from "./swarm-panel";

/**
 * Neovim in the Code tab (Vim mode in the Mac app): the app is an `nvim --embed` UI on the line-grid protocol
 * (src-tauri/src/nvim.rs). The grid lives outside React; a flush re-renders only the rows that changed.
 */

type Attr = { fg?: number; bg?: number; sp?: number; bold?: boolean; italic?: boolean; underline?: boolean; undercurl?: boolean; strikethrough?: boolean; reverse?: boolean };
type Cell = [text: string, hl: number];
type ModeInfo = { cursor_shape?: "block" | "horizontal" | "vertical"; cell_percentage?: number; name?: string };

const FONT_SIZE = 12.5;
const LINE = 19;
const hex = (n: number | undefined) => (n === undefined ? undefined : `#${n.toString(16).padStart(6, "0")}`);

/** A keydown in Neovim's notation, or null when the app should keep it (⌘ shortcuts, bare modifiers). */
function toNvim(e: React.KeyboardEvent): string | null {
	if (e.metaKey || e.nativeEvent.isComposing) return null;
	const special: Record<string, string> = {
		Enter: "CR", Escape: "Esc", Backspace: "BS", Tab: "Tab", Delete: "Del", Insert: "Insert", Home: "Home", End: "End",
		PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space",
	};
	let name = special[e.key] ?? (/^F\d{1,2}$/.test(e.key) ? e.key : null);
	if (!name) {
		if (e.key.length !== 1) return null;
		name = e.key === "<" ? "lt" : e.key === "\\" ? "Bslash" : e.key === "|" ? "Bar" : e.key;
	}
	const mods = `${e.ctrlKey ? "C-" : ""}${e.altKey ? "M-" : ""}${e.shiftKey && (special[e.key] || e.key.length !== 1) ? "S-" : ""}`;
	// Printable keys go as themselves; specials and anything with a modifier go in <…>.
	if (!mods && e.key.length === 1 && e.key !== " ") return name === e.key ? e.key : `<${name}>`;
	if (!mods && name === "Space") return " ";
	return `<${mods}${name}>`;
}

const Row = memo(function Row({ cells, attrs, version, fg: dfg, bg: dbg }: { cells: Cell[]; attrs: Map<number, Attr>; version: number; fg: number; bg: number }) {
	void version;
	// Runs of cells with the same highlight become one span.
	const runs: { text: string; hl: number }[] = [];
	for (const [text, hl] of cells) {
		const last = runs[runs.length - 1];
		if (last && last.hl === hl) last.text += text;
		else runs.push({ text, hl });
	}
	return (
		<div className="whitespace-pre" style={{ height: LINE }}>
			{runs.map((r, i) => {
				const a = attrs.get(r.hl);
				if (!a) return <span key={i}>{r.text}</span>;
				const fg = hex(a.reverse ? (a.bg ?? dbg) : a.fg);
				const bg = hex(a.reverse ? (a.fg ?? dfg) : a.bg);
				return (
					<span
						key={i}
						style={{
							color: fg,
							background: bg,
							fontWeight: a.bold ? 600 : undefined,
							fontStyle: a.italic ? "italic" : undefined,
							textDecoration: [a.underline || a.undercurl ? "underline" : "", a.strikethrough ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
							textDecorationStyle: a.undercurl ? "wavy" : undefined,
							textDecorationColor: hex(a.sp),
						}}
					>
						{r.text}
					</span>
				);
			})}
		</div>
	);
});

export function NeovimView({ bridge, folder, path, line, onFile }: { bridge: Bridge; folder: string; path: string; line: number | null; onFile: (path: string, line: number) => void }) {
	const box = useRef<HTMLDivElement | null>(null);
	const probe = useRef<HTMLSpanElement | null>(null);
	const grid = useRef<{ rows: Cell[][]; versions: number[]; attrs: Map<number, Attr>; fg: number; bg: number; cursor: [number, number]; modes: ModeInfo[]; mode: number }>({
		rows: [],
		versions: [],
		attrs: new Map(),
		fg: 0xd4d4d4,
		bg: 0x1e1e1e,
		cursor: [0, 0],
		modes: [],
		mode: 0,
	});
	const [, setFrame] = useState(0);
	const [cell, setCell] = useState({ w: 7.5, h: LINE });
	const [error, setError] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	// The file Neovim itself moved to, so the URL change it causes doesn't send it back.
	const fromNvim = useRef<string | null>(null);
	const onFileRef = useRef(onFile);
	onFileRef.current = onFile;

	// Redraws, the file in Neovim's window, and Neovim exiting.
	useEffect(() => {
		const g = grid.current;
		const resize = (w: number, h: number) => {
			g.rows = Array.from({ length: h }, (_, r) => g.rows[r]?.slice(0, w).concat(Array.from({ length: Math.max(0, w - (g.rows[r]?.length ?? 0)) }, (): Cell => [" ", 0])) ?? Array.from({ length: w }, (): Cell => [" ", 0]));
			g.versions = Array.from({ length: h }, (_, r) => (g.versions[r] ?? 0) + 1);
		};
		const touch = (r: number) => (g.versions[r] = (g.versions[r] ?? 0) + 1);
		const offs: Promise<() => void>[] = [];
		offs.push(
			bridge.listen<unknown[][]>("nvim:redraw", ({ payload }) => {
				let flush = false;
				for (const [name, ...calls] of payload as [string, ...unknown[][]][]) {
					for (const args of calls) {
						switch (name) {
							case "grid_resize":
								resize(args[1] as number, args[2] as number);
								break;
							case "default_colors_set":
								if ((args[0] as number) >= 0) g.fg = args[0] as number;
								if ((args[1] as number) >= 0) g.bg = args[1] as number;
								g.versions = g.versions.map((v) => v + 1);
								break;
							case "hl_attr_define":
								g.attrs.set(args[0] as number, args[1] as Attr);
								break;
							case "grid_line": {
								const [, r, c0, cells] = args as [number, number, number, [string, number?, number?][]];
								const row = g.rows[r];
								if (!row) break;
								let c = c0;
								let hl = 0;
								for (const [text, h, repeat] of cells) {
									if (h !== undefined) hl = h;
									for (let i = 0; i < (repeat ?? 1); i++) if (c < row.length) row[c++] = [text, hl];
								}
								touch(r);
								break;
							}
							case "grid_clear":
								g.rows = g.rows.map((row) => row.map((): Cell => [" ", 0]));
								g.versions = g.versions.map((v) => v + 1);
								break;
							case "grid_cursor_goto":
								g.cursor = [args[1] as number, args[2] as number];
								break;
							case "grid_scroll": {
								const [, top, bot, left, right, rows] = args as number[];
								// Rows move up (rows > 0) or down within [top, bot), columns [left, right).
								const span = (r: number) => g.rows[r].slice(left, right);
								if (rows > 0) {
									for (let r = top; r < bot - rows; r++) g.rows[r].splice(left, right - left, ...span(r + rows));
								} else {
									for (let r = bot - 1; r >= top - rows; r--) g.rows[r].splice(left, right - left, ...span(r + rows));
								}
								for (let r = top; r < bot; r++) touch(r);
								break;
							}
							case "mode_info_set":
								g.modes = args[1] as ModeInfo[];
								break;
							case "mode_change":
								g.mode = args[1] as number;
								break;
							case "flush":
								flush = true;
								break;
						}
					}
				}
				if (flush) setFrame((f) => f + 1);
			}),
		);
		offs.push(
			bridge.listen<[string, number]>("nvim:buffer", ({ payload }) => {
				const [abs, ln] = payload;
				if (!abs.startsWith(`${folder}/`)) return;
				const rel = abs.slice(folder.length + 1);
				fromNvim.current = rel;
				onFileRef.current(rel, ln);
			}),
		);
		offs.push(bridge.listen("nvim:exit", () => setError("Neovim exited. Switch files or modes to start it again.")));
		return () => {
			// Neovim stays attached: the next view takes it over with a full redraw.
			for (const off of offs) void off.then((f) => f());
		};
	}, [bridge, folder]);

	// Attach at the size of the box, and follow its size.
	useEffect(() => {
		const el = box.current;
		const p = probe.current;
		if (!el || !p) return;
		const w = p.getBoundingClientRect().width / 10 || 7.5;
		setCell({ w, h: LINE });
		const size = () => ({ cols: Math.floor(el.clientWidth / w), rows: Math.floor(el.clientHeight / LINE) });
		let attached = false;
		// Start with a blank grid of this size: a returning view gets lines before any resize.
		const { cols, rows } = size();
		const g = grid.current;
		if (!g.rows.length) {
			g.rows = Array.from({ length: rows }, () => Array.from({ length: cols }, (): Cell => [" ", 0]));
			g.versions = g.rows.map(() => 0);
		}
		void bridge.invoke("nvim_attach", { folder, cols, rows }).then(
			() => {
				attached = true;
				setReady(true);
			},
			(e) => setError(String(e)),
		);
		const ro = new ResizeObserver(() => {
			if (attached) void bridge.invoke("nvim_resize", size()).catch(() => undefined);
		});
		ro.observe(el);
		el.focus();
		return () => ro.disconnect();
	}, [bridge, folder]);

	// Open the file the page shows (unless Neovim is the one that moved there).
	useEffect(() => {
		if (!ready) return;
		if (fromNvim.current === path) {
			fromNvim.current = null;
			return;
		}
		void bridge.invoke("nvim_open", { path, line }).catch((e) => setError(String(e)));
		box.current?.focus();
	}, [bridge, ready, path, line]);

	const g = grid.current;
	const mode = g.modes[g.mode] ?? {};
	const pct = (mode.cell_percentage ?? 100) / 100;
	const [cr, cc] = g.cursor;
	const under = g.rows[cr]?.[cc]?.[0] ?? " ";
	const mouse = (e: React.MouseEvent, action: string) => {
		const r = box.current?.getBoundingClientRect();
		if (!r) return;
		const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
		const mod = `${e.ctrlKey ? "C-" : ""}${e.altKey ? "A-" : ""}${e.shiftKey ? "S-" : ""}`;
		void bridge.invoke("nvim_mouse", { button, action, modifier: mod, row: Math.floor((e.clientY - r.top) / cell.h), col: Math.floor((e.clientX - r.left) / cell.w) }).catch(() => undefined);
	};

	return (
		<div
			ref={box}
			tabIndex={0}
			className="relative h-full w-full cursor-text overflow-hidden font-mono outline-none"
			style={{ fontSize: FONT_SIZE, lineHeight: `${LINE}px`, background: hex(g.bg), color: hex(g.fg) }}
			onKeyDown={(e) => {
				const keys = toNvim(e);
				if (keys === null) return;
				e.preventDefault();
				void bridge.invoke("nvim_input", { keys }).catch(() => undefined);
			}}
			onMouseDown={(e) => {
				box.current?.focus();
				mouse(e, "press");
			}}
			onMouseMove={(e) => {
				if (e.buttons) mouse(e, "drag");
			}}
			onMouseUp={(e) => mouse(e, "release")}
			onWheel={(e) => {
				const r = box.current?.getBoundingClientRect();
				if (!r) return;
				void bridge.invoke("nvim_mouse", { button: "wheel", action: e.deltaY > 0 ? "down" : "up", modifier: "", row: Math.floor((e.clientY - r.top) / cell.h), col: Math.floor((e.clientX - r.left) / cell.w) }).catch(() => undefined);
			}}
			onContextMenu={(e) => e.preventDefault()}
		>
			<span ref={probe} aria-hidden className="invisible absolute">
				MMMMMMMMMM
			</span>
			{g.rows.map((cells, r) => (
				<Row key={r} cells={cells} attrs={g.attrs} version={g.versions[r] ?? 0} fg={g.fg} bg={g.bg} />
			))}
			{g.rows.length ? (
				<span
					aria-hidden
					className="pointer-events-none absolute overflow-hidden"
					style={{
						left: cc * cell.w,
						top: cr * cell.h + (mode.cursor_shape === "horizontal" ? cell.h * (1 - pct) : 0),
						width: mode.cursor_shape === "vertical" ? Math.max(2, cell.w * pct) : cell.w,
						height: mode.cursor_shape === "horizontal" ? Math.max(2, cell.h * pct) : cell.h,
						background: hex(g.fg),
						color: hex(g.bg),
					}}
				>
					{mode.cursor_shape === "block" || !mode.cursor_shape ? under : null}
				</span>
			) : null}
			{error ? <p className="absolute inset-x-0 bottom-0 bg-red-600/90 px-3 py-1 font-sans text-[12px] text-white">{error}</p> : null}
		</div>
	);
}
