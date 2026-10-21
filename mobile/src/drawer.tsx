import { useRef, useState } from "react";

/** How much of the page stays in view when the drawer is open, as in Mike's chat. */
const PEEK = 64;

/**
 * A drawer behind the page, as Mike's chat history: swipe right (or `open`) and the page slides aside with rounded
 * corners and a shadow, showing the drawer; swipe back or tap the page's edge to close. A swipe locks to an axis
 * first, so scrolling the page up and down never moves it. Fixed children (floating bars, tabs) move with the page.
 */
export function SlideDrawer({ open, onOpenChange, drawer, children }: { open: boolean; onOpenChange: (open: boolean) => void; drawer: React.ReactNode; children: React.ReactNode }) {
	const [drag, setDrag] = useState(0);
	const start = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
	const width = typeof window === "undefined" ? 320 : window.innerWidth - PEEK;
	const offset = Math.min(Math.max((open ? width : 0) + drag, 0), width);
	const progress = width ? offset / width : 0;
	const dragging = drag !== 0;
	return (
		<div
			className="fixed inset-0 overflow-hidden"
			style={{ background: "var(--fm-sunken)" }}
			onTouchStart={(e) => (start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, axis: null })}
			onTouchMove={(e) => {
				const s = start.current;
				if (!s) return;
				const dx = e.touches[0].clientX - s.x;
				const dy = e.touches[0].clientY - s.y;
				if (!s.axis) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
					s.axis = Math.abs(dx) > Math.abs(dy) * 2 ? "x" : "y";
				}
				if (s.axis === "x") setDrag(dx);
			}}
			onTouchEnd={() => {
				const s = start.current;
				start.current = null;
				if (s?.axis === "x") onOpenChange((open ? width : 0) + drag > width * 0.5);
				setDrag(0);
			}}
		>
			<aside className="absolute inset-y-0 left-0 overflow-hidden" style={{ width }} aria-hidden={!open}>
				{drawer}
			</aside>
			<div
				className="absolute inset-0 overflow-hidden"
				style={{
					transform: `translateX(${offset}px)`,
					borderRadius: `${44 * progress}px`,
					boxShadow: `-3px 0 16px rgb(0 0 0 / ${0.14 * progress})`,
					transition: dragging ? "none" : "transform 320ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 320ms, box-shadow 320ms",
				}}
			>
				{/* transform makes this the containing block of fixed children, so the bars slide with the page. */}
				<div className="absolute inset-0" style={{ transform: "translateZ(0)" }}>
					{children}
				</div>
				{progress > 0 ? <button type="button" aria-label="Close history" onClick={() => onOpenChange(false)} className="absolute inset-0 z-50" style={{ background: `rgb(0 0 0 / ${0.06 * progress})` }} /> : null}
			</div>
		</div>
	);
}
