import { useEffect, useState } from "react";

export type ScrubItem = { label: string; text: string };

/** The tallest the rail gets, and the closest its ticks sit (a longer chat shares a tick between messages). */
const MAX_HEIGHT = 320;
const MIN_STEP = 3;

/**
 * A rail of ticks along the chat's left edge: the one for the message in view is lit, ticks near the pointer grow,
 * hovering shows a preview of that message and a click scrolls to it. The messages are the scroller's children
 * marked `data-msg`, in order. The rail sits centred on the message list, at most MAX_HEIGHT tall; when the chat has
 * more messages than fit there, each tick stands for a run of them (its first is the one previewed and jumped to).
 */
export function ChatScrubber({ scroller, items }: { scroller: React.RefObject<HTMLDivElement | null>; items: ScrubItem[] }) {
	const [active, setActive] = useState(0);
	const [hover, setHover] = useState<number | null>(null);
	// Where the message list is, relative to the rail's positioned parent.
	const [area, setArea] = useState({ top: 0, height: 0 });

	const nodes = () => [...(scroller.current?.querySelectorAll<HTMLElement>(":scope > [data-msg]") ?? [])];

	// The message in view: the last one whose top has scrolled past the top edge (the last one at the bottom).
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const look = () => {
			const list = nodes();
			const top = el.scrollTop + 12;
			let i = 0;
			list.forEach((n, j) => {
				if (n.offsetTop <= top) i = j;
			});
			if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) i = list.length - 1;
			setActive(Math.max(0, i));
		};
		look();
		el.addEventListener("scroll", look, { passive: true });
		return () => el.removeEventListener("scroll", look);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scroller, items.length]);

	// The message list's box, measured once it is on the page (the rail isn't while there are fewer than two messages).
	const on = items.length >= 2;
	useEffect(() => {
		const el = scroller.current;
		const parent = el?.offsetParent as HTMLElement | null;
		if (!el || !parent) return;
		const measure = () => setArea({ top: el.getBoundingClientRect().top - parent.getBoundingClientRect().top, height: el.clientHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		ro.observe(parent);
		return () => ro.disconnect();
	}, [scroller, on]);

	if (!on || area.height <= 0) return null;
	const n = items.length;
	const band = Math.max(0, Math.min(MAX_HEIGHT, area.height - 32));
	const ticks = Math.max(2, Math.min(n, Math.floor(band / MIN_STEP) + 1));
	const step = Math.min(6, band / (ticks - 1));
	const height = step * (ticks - 1);
	const top = area.top + (area.height - height) / 2;
	// Tick k stands for messages first(k)…first(k + 1) - 1.
	const first = (k: number) => Math.floor((k * n) / ticks);
	const tickOf = (i: number) => Math.min(ticks - 1, Math.floor((i * ticks) / n));
	const at = (y: number) => Math.min(ticks - 1, Math.max(0, Math.round(y / step)));
	const go = (k: number) => {
		const node = nodes()[first(k)];
		const el = scroller.current;
		if (node && el) el.scrollTo({ top: node.offsetTop - 8, behavior: "smooth" });
	};
	const lit = tickOf(active);
	const shown = hover !== null ? items[first(hover)] : null;

	return (
		<div
			className="absolute left-0 z-10 w-5 cursor-pointer"
			// A few pixels of slack above and below the ticks, so the end ones are easy to reach.
			style={{ top: top - 6, height: height + 12 }}
			onMouseMove={(e) => setHover(at(e.clientY - e.currentTarget.getBoundingClientRect().top - 6))}
			onMouseLeave={() => setHover(null)}
			onClick={(e) => go(at(e.clientY - e.currentTarget.getBoundingClientRect().top - 6))}
			aria-hidden
		>
			{Array.from({ length: ticks }, (_, k) => {
				const near = hover === null ? 99 : Math.abs(hover - k);
				const width = k === lit ? 14 : 6 + Math.max(0, 3 - near) * 3;
				return (
					<span
						key={k}
						className={`absolute left-1 h-px rounded-full transition-[width,background-color] duration-150 ${k === lit ? "bg-foreground" : near === 0 ? "bg-foreground/70" : "bg-muted-foreground/40"}`}
						style={{ top: 6 + k * step, width }}
					/>
				);
			})}
			{shown && hover !== null ? (
				<div className="pointer-events-none absolute left-6 z-20 w-64 -translate-y-1/2 rounded-xl border bg-popover p-2.5 text-[12px] shadow-pop" style={{ top: Math.min(Math.max(6 + hover * step, area.top + 40 - (top - 6)), area.top + area.height - 40 - (top - 6)) }}>
					<p className="mb-1 truncate text-[11px] font-medium text-muted-foreground">{shown.label}</p>
					<p className="line-clamp-3 text-popover-foreground">{shown.text}</p>
				</div>
			) : null}
		</div>
	);
}
