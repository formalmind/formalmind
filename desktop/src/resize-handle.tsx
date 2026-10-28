import { useState } from "react";

const read = (key: string) => {
	try {
		return Number(localStorage.getItem(key)) || null;
	} catch {
		return null;
	}
};

/**
 * A size (px) the viewer sets by dragging, kept per viewer under `key`. `edge` says which side of the panel the handle
 * sits on: dragging it away from the panel makes the panel bigger.
 */
export function useResizable(key: string, initial: number, min: number, max: number, edge: "left" | "right" | "bottom") {
	const [size, setSize] = useState(() => Math.min(max, Math.max(min, read(key) ?? initial)));
	const [dragging, setDragging] = useState(false);
	const vertical = edge === "bottom";
	const start = (e: React.PointerEvent) => {
		e.preventDefault();
		const from = vertical ? e.clientY : e.clientX;
		const begin = size;
		let last = size;
		setDragging(true);
		// No text selection while dragging, and the resize cursor everywhere (the pointer leaves the strip).
		document.body.style.userSelect = "none";
		document.body.style.cursor = vertical ? "row-resize" : "col-resize";
		const move = (m: PointerEvent) => {
			const d = (vertical ? m.clientY : m.clientX) - from;
			last = Math.min(max, Math.max(min, begin + (edge === "left" ? -d : d)));
			setSize(last);
		};
		const up = () => {
			setDragging(false);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			try {
				localStorage.setItem(key, String(Math.round(last)));
			} catch {
				/* not kept */
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const reset = () => {
		setSize(initial);
		try {
			localStorage.removeItem(key);
		} catch {
			/* not kept */
		}
	};
	/** The handle: a thin strip on the panel's edge (place it in a `relative` panel); double-click puts the size back. */
	const handle = (
		<div
			role="separator"
			aria-orientation={vertical ? "horizontal" : "vertical"}
			aria-valuenow={Math.round(size)}
			title="Drag to resize · double-click to reset"
			onPointerDown={start}
			onDoubleClick={reset}
			className={`group absolute z-20 ${vertical ? "inset-x-0 -bottom-1 h-2 cursor-row-resize" : `inset-y-0 w-2 cursor-col-resize ${edge === "left" ? "-left-1" : "-right-1"}`}`}
		>
			<span className={`absolute bg-transparent transition-colors group-hover:bg-ring/40 ${dragging ? "bg-ring/60" : ""} ${vertical ? "inset-x-0 top-[3px] h-0.5" : "inset-y-0 left-[3px] w-0.5"}`} />
		</div>
	);
	return { size, handle, dragging };
}
