import { useRef } from "react";

/**
 * Touch handlers for a sideways swipe. WebKit cancels a touch it takes over as a scroll, so the last point is kept as
 * the finger moves and the swipe is judged on cancel as well as on end.
 */
export function useSwipe(onSwipe: (dir: "left" | "right") => void) {
	const from = useRef<{ x: number; y: number } | null>(null);
	const at = useRef<{ x: number; y: number } | null>(null);
	const done = () => {
		const a = from.current;
		const b = at.current;
		from.current = at.current = null;
		if (!a || !b) return;
		const dx = b.x - a.x;
		if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(b.y - a.y) * 1.5) onSwipe(dx > 0 ? "right" : "left");
	};
	return {
		onTouchStart: (e: React.TouchEvent) => (from.current = at.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }),
		onTouchMove: (e: React.TouchEvent) => (at.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }),
		onTouchEnd: done,
		onTouchCancel: done,
	};
}
