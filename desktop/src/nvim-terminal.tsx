import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Bridge } from "./swarm-panel";

/**
 * Vim mode in the Mac app: the bundled Neovim in a real terminal (a pseudo-terminal in src-tauri/src/term.rs, drawn
 * by xterm.js), so it looks and behaves exactly as in your own terminal — colours, cursor, plugins, LSP. Opening
 * another file sends `:edit`; when Neovim exits, any key starts it again.
 */
export function NvimTerminal({ bridge, folder, path, line }: { bridge: Bridge; folder: string; path: string; line: number | null }) {
	const box = useRef<HTMLDivElement | null>(null);
	const api = useRef<{ open: (path: string, line: number | null) => void } | null>(null);
	const first = useRef({ path, line });

	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const dark = document.documentElement.classList.contains("dark") || window.matchMedia("(prefers-color-scheme: dark)").matches;
		const term = new Terminal({
			fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
			fontSize: 12.5,
			lineHeight: 1.25,
			cursorBlink: false,
			allowProposedApi: true,
			macOptionIsMeta: true,
			scrollback: 0,
			theme: dark ? { background: "#1e1e1e", foreground: "#d4d4d4" } : { background: "#ffffff", foreground: "#1f2328", cursor: "#1f2328", selectionBackground: "#b4d5fe" },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(el);
		fit.fit();
		// ⌘ shortcuts belong to the app (new tab, close tab, copy…), not to Neovim.
		term.attachCustomKeyEventHandler((e) => !e.metaKey);

		let id: number | null = null;
		let ended = false;
		let disposed = false;
		const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const start = (p: string | null, l: number | null) => {
			ended = false;
			void bridge.invoke<number>("term_start", { folder, path: p, line: l, cols: term.cols, rows: term.rows }).then(
				(n) => {
					if (disposed) void bridge.invoke("term_kill", { id: n });
					else id = n;
				},
				(e) => term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`),
			);
		};
		const offData = bridge.listen<{ id: number; data: string }>("term:data", ({ payload }) => {
			if (payload.id === id) term.write(decode(payload.data));
		});
		const offExit = bridge.listen<{ id: number }>("term:exit", ({ payload }) => {
			if (payload.id !== id) return;
			id = null;
			ended = true;
			term.write("\r\n\x1b[2mNeovim exited. Press any key to open it again.\x1b[0m");
		});
		const input = term.onData((data) => {
			if (ended) {
				term.reset();
				start(first.current.path, null);
				return;
			}
			if (id !== null) void bridge.invoke("term_write", { id, data }).catch(() => undefined);
		});
		const resize = term.onResize(({ cols, rows }) => {
			if (id !== null) void bridge.invoke("term_resize", { id, cols, rows }).catch(() => undefined);
		});
		const ro = new ResizeObserver(() => fit.fit());
		ro.observe(el);

		api.current = {
			open: (p, l) => {
				first.current = { path: p, line: l };
				if (id === null) return ended ? undefined : start(p, l);
				// Ctrl-\ Ctrl-N reaches normal mode from any mode (a bare Escape before ":" can read as Alt-:).
				const arg = p.replace(/([ \\%#|"])/g, "\\$1");
				void bridge.invoke("term_write", { id, data: `\x1c\x0e:edit ${l ? `+${l} ` : ""}${arg}\r` }).catch(() => undefined);
			},
		};
		start(first.current.path, first.current.line);
		term.focus();

		return () => {
			disposed = true;
			api.current = null;
			ro.disconnect();
			input.dispose();
			resize.dispose();
			void offData.then((f) => f());
			void offExit.then((f) => f());
			if (id !== null) void bridge.invoke("term_kill", { id });
			term.dispose();
		};
	}, [bridge, folder]);

	// A file picked in the sidebar (or a link) opens in the running Neovim.
	useEffect(() => {
		if (first.current.path === path && first.current.line === line) return;
		api.current?.open(path, line);
	}, [path, line]);

	return <div ref={box} className="h-full w-full overflow-hidden px-1 pt-1" />;
}
