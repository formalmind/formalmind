import { useEffect, useState } from "react";

/** Vim keys in the code viewer: a setting kept in this browser, shared by every open view through an event. */
const KEY = "fm:vim";
const EVENT = "fm:vim";

export function getVimMode() {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

export function setVimMode(on: boolean) {
	try {
		localStorage.setItem(KEY, on ? "1" : "0");
	} catch {
		/* not kept */
	}
	window.dispatchEvent(new Event(EVENT));
}

export function useVimMode() {
	const [on, setOn] = useState(getVimMode);
	useEffect(() => {
		const sync = () => setOn(getVimMode());
		window.addEventListener(EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);
	return on;
}

export type Cursor = { line: number; col: number };

const word = (c: string | undefined) => !!c && /[\w$]/.test(c);
const kind = (c: string | undefined) => (c === undefined || /\s/.test(c) ? 0 : word(c) ? 1 : 2);
const clampCol = (lines: string[], c: Cursor): Cursor => ({ line: c.line, col: Math.max(0, Math.min(c.col, (lines[c.line]?.length ?? 1) - 1)) });

/** A read-only cursor motion: where `key` (with a count) moves the cursor. Null when `key` isn't a motion. */
export function motion(lines: string[], cur: Cursor, key: string, count: number, page: number): Cursor | null {
	const last = lines.length - 1;
	const at = (c: Cursor) => lines[c.line]?.[c.col];
	// Steps through the text as one stream (line ends count as whitespace).
	const next = (c: Cursor): Cursor | null => (c.col + 1 < (lines[c.line]?.length ?? 0) ? { line: c.line, col: c.col + 1 } : c.line < last ? { line: c.line + 1, col: -1 } : null);
	const prev = (c: Cursor): Cursor | null => (c.col > 0 ? { line: c.line, col: c.col - 1 } : c.line > 0 ? { line: c.line - 1, col: lines[c.line - 1].length } : null);
	const ch = (c: Cursor) => (c.col < 0 || c.col >= (lines[c.line]?.length ?? 0) ? undefined : at(c));
	let c = cur;
	for (let n = 0; n < count; n++) {
		switch (key) {
			case "h":
			case "ArrowLeft":
				c = { line: c.line, col: Math.max(0, c.col - 1) };
				break;
			case "l":
			case "ArrowRight":
				c = clampCol(lines, { line: c.line, col: c.col + 1 });
				break;
			case "j":
			case "ArrowDown":
				c = clampCol(lines, { line: Math.min(last, c.line + 1), col: cur.col });
				break;
			case "k":
			case "ArrowUp":
				c = clampCol(lines, { line: Math.max(0, c.line - 1), col: cur.col });
				break;
			case "w": {
				const k0 = kind(ch(c));
				let p: Cursor | null = c;
				while (p && kind(ch(p)) === k0 && k0 !== 0) p = next(p);
				while (p && kind(ch(p)) === 0) p = next(p);
				if (p) c = clampCol(lines, { line: p.line, col: Math.max(0, p.col) });
				break;
			}
			case "e": {
				let p: Cursor | null = next(c);
				while (p && kind(ch(p)) === 0) p = next(p);
				const k0 = p ? kind(ch(p)) : 0;
				while (p) {
					const q = next(p);
					if (!q || kind(ch(q)) !== k0) break;
					p = q;
				}
				if (p) c = clampCol(lines, p);
				break;
			}
			case "b": {
				let p: Cursor | null = prev(c);
				while (p && kind(ch(p)) === 0) p = prev(p);
				const k0 = p ? kind(ch(p)) : 0;
				while (p) {
					const q = prev(p);
					if (!q || kind(ch(q)) !== k0) break;
					p = q;
				}
				if (p) c = clampCol(lines, p);
				break;
			}
			case "}": {
				let l = c.line + 1;
				while (l < last && lines[l].trim() !== "") l++;
				c = { line: Math.min(l, last), col: 0 };
				break;
			}
			case "{": {
				let l = c.line - 1;
				while (l > 0 && lines[l].trim() !== "") l--;
				c = { line: Math.max(l, 0), col: 0 };
				break;
			}
			case "ctrl+d":
				c = clampCol(lines, { line: Math.min(last, c.line + page), col: c.col });
				break;
			case "ctrl+u":
				c = clampCol(lines, { line: Math.max(0, c.line - page), col: c.col });
				break;
			default:
				n = count;
				break;
		}
	}
	switch (key) {
		case "0":
			return { line: c.line, col: 0 };
		case "^":
			return { line: c.line, col: Math.max(0, (lines[c.line] ?? "").search(/\S/)) };
		case "$":
			return clampCol(lines, { line: c.line, col: Infinity });
		case "G":
			return { line: count > 1 ? Math.min(last, count - 1) : last, col: 0 };
		case "gg":
			return { line: Math.min(last, count - 1), col: 0 };
	}
	return c === cur && !["h", "l", "j", "k", "w", "b", "e", "{", "}", "ctrl+d", "ctrl+u", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key) ? null : c;
}

/** The next (or previous) match of `pattern` after the cursor, wrapping around. */
export function search(lines: string[], cur: Cursor, pattern: string, back = false): Cursor | null {
	if (!pattern) return null;
	const lower = pattern.toLowerCase() === pattern;
	const find = (s: string, from: number) => (lower ? s.toLowerCase() : s).indexOf(pattern, from);
	const findLast = (s: string, before: number) => (lower ? s.toLowerCase() : s).lastIndexOf(pattern, before);
	for (let i = 0; i <= lines.length; i++) {
		const l = back ? (cur.line - i + lines.length * 2) % lines.length : (cur.line + i) % lines.length;
		const s = lines[l];
		const col = back ? findLast(s, i === 0 ? cur.col - 1 : s.length) : find(s, i === 0 ? cur.col + 1 : 0);
		if (col >= 0 && !(i === 0 && back && cur.col === 0)) return { line: l, col };
	}
	return null;
}
