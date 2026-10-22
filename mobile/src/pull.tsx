import { useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

const PULL = 64;
const MAX = 110;

/** The nearest scrolling ancestor of `el` inside `root` (the page's own scroller when none). */
function scroller(el: Element | null, root: Element): Element {
	for (let n = el; n && n !== root; n = n.parentElement) {
		const y = getComputedStyle(n).overflowY;
		if ((y === "auto" || y === "scroll") && n.scrollHeight > n.clientHeight) return n;
	}
	return document.scrollingElement ?? root;
}

/**
 * Pull to refresh, as iOS lists do: pulled down from the top of what's scrolling, a pill says what letting go does;
 * let go past the mark and `onRefresh` runs, its answer shown for a moment ("Up to date", "Updated to …").
 */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<string>; children: React.ReactNode }) {
	const root = useRef<HTMLDivElement>(null);
	const start = useRef<{ y: number; top: boolean } | null>(null);
	const [pull, setPull] = useState(0);
	const [state, setState] = useState<"idle" | "busy" | { done: string }>("idle");
	const busy = state !== "idle";

	const end = async () => {
		const was = pull;
		start.current = null;
		if (was < PULL || busy) return setPull(0);
		setPull(44);
		setState("busy");
		let done: string;
		try {
			done = await onRefresh();
		} catch (e) {
			done = `Couldn't reach GitHub: ${e instanceof Error ? e.message : String(e)}`;
		}
		setState({ done });
		setTimeout(() => {
			setPull(0);
			setState("idle");
		}, 1400);
	};

	const label = typeof state === "object" ? state.done : state === "busy" ? "Getting the latest from GitHub…" : pull >= PULL ? "Release to get the latest" : "Pull to get the latest";
	return (
		<div
			ref={root}
			className="relative flex min-h-0 flex-1 flex-col"
			onTouchStart={(e) => {
				if (busy || !root.current) return;
				start.current = { y: e.touches[0].clientY, top: scroller(e.target as Element, root.current).scrollTop <= 0 };
			}}
			onTouchMove={(e) => {
				const s = start.current;
				if (!s?.top || busy) return;
				const dy = e.touches[0].clientY - s.y;
				setPull(dy > 0 ? Math.min(MAX, dy * 0.5) : 0);
			}}
			onTouchEnd={() => void end()}
			onTouchCancel={() => void end()}
		>
			{/* The pill sits under the bar; the content gives way to it. */}
			<div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center" style={{ height: pull, opacity: pull ? 1 : 0 }}>
				<span className="mt-2 flex h-7 items-center gap-1.5 self-start rounded-full bg-muted px-3 text-[12px] text-muted-foreground shadow-card">
					{state === "idle" ? <ArrowDown className={`size-3.5 transition-transform ${pull >= PULL ? "rotate-180" : ""}`} /> : null}
					<span className={state === "busy" ? "fm-shimmer-text" : ""}>{label}</span>
				</span>
			</div>
			<div className={`flex min-h-0 flex-1 flex-col ${start.current ? "" : "transition-transform duration-300"}`} style={{ transform: pull ? `translateY(${pull}px)` : undefined }}>
				{children}
			</div>
		</div>
	);
}
