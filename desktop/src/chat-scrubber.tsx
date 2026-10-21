import { useEffect, useRef, useState } from "react";

export type ScrubItem = { label: string; text: string };

/**
 * A rail of ticks along the chat's left edge, one per message: the one in view is lit, ticks near the pointer grow,
 * hovering shows a preview of that message and a click scrolls to it. The messages are the scroller's children
 * marked `data-msg`, in order.
 */
export function ChatScrubber({ scroller, items }: { scroller: React.RefObject<HTMLDivElement | null>; items: ScrubItem[] }) {
	const rail = useRef<HTMLDivElement>(null);
	const [active, setActive] = useState(0);
	const [hover, setHover] = useState<number | null>(null);
	const [height, setHeight] = useState(0);

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

	// The rail's height, measured once it is on the page (it isn't while there are fewer than two messages).
	const on = items.length >= 2;
	useEffect(() => {
		const r = rail.current;
		if (!r) return;
		setHeight(r.clientHeight);
		const ro = new ResizeObserver(() => setHeight(r.clientHeight));
		ro.observe(r);
		return () => ro.disconnect();
	}, [on]);

	if (!on) return null;
	// Tightly spaced and centred on the chat's height; a very long chat packs them closer (never under 3px apart).
	const step = Math.min(6, Math.max(3, (height - 32) / (items.length - 1)));
	const start = Math.max(16, (height - step * (items.length - 1)) / 2);
	const at = (y: number) => Math.min(items.length - 1, Math.max(0, Math.round((y - start) / step)));
	const go = (i: number) => {
		const n = nodes()[i];
		const el = scroller.current;
		if (n && el) el.scrollTo({ top: n.offsetTop - 8, behavior: "smooth" });
	};
	const shown = hover !== null ? items[hover] : null;

	return (
		<div
			ref={rail}
			className="absolute inset-y-0 left-0 z-10 w-5 cursor-pointer"
			onMouseMove={(e) => setHover(at(e.clientY - e.currentTarget.getBoundingClientRect().top))}
			onMouseLeave={() => setHover(null)}
			onClick={(e) => go(at(e.clientY - e.currentTarget.getBoundingClientRect().top))}
			aria-hidden
		>
			{items.map((_, i) => {
				const near = hover === null ? 99 : Math.abs(hover - i);
				const width = i === active ? 14 : 6 + Math.max(0, 3 - near) * 3;
				return (
					<span
						key={i}
						className={`absolute left-1 h-px rounded-full transition-[width,background-color] duration-150 ${i === active ? "bg-foreground" : near === 0 ? "bg-foreground/70" : "bg-muted-foreground/40"}`}
						style={{ top: start + i * step, width }}
					/>
				);
			})}
			{shown && hover !== null ? (
				<div
					className="pointer-events-none absolute left-6 z-20 w-64 -translate-y-1/2 rounded-xl border bg-popover p-2.5 text-[12px] shadow-pop"
					style={{ top: Math.min(Math.max(start + hover * step, 40), height - 40) }}
				>
					<p className="mb-1 truncate text-[11px] font-medium text-muted-foreground">{shown.label}</p>
					<p className="line-clamp-3 text-popover-foreground">{shown.text}</p>
				</div>
			) : null}
		</div>
	);
}
