"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * transitions.dev text states swap for React: when `value` changes the old content exits up with a blur,
 * then the new content enters from below. `children` renders a value, so a swap can carry more than text.
 */
export function TextSwap<T>({ value, children, className = "" }: { value: T; children?: (value: T) => ReactNode; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [shown, setShown] = useState(value);
	const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el || Object.is(value, shown)) return;
		const dur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur")) || 150;
		el.classList.add("is-exit");
		if (pending.current) clearTimeout(pending.current);
		pending.current = setTimeout(() => {
			setShown(value);
			el.classList.remove("is-exit");
			el.classList.add("is-enter-start");
		}, dur);
		return () => {
			if (pending.current) clearTimeout(pending.current);
		};
	}, [value, shown]);

	// After the new content has rendered at the start position, reflow and let it animate back to rest.
	useEffect(() => {
		const el = ref.current;
		if (!el?.classList.contains("is-enter-start")) return;
		void el.offsetHeight;
		el.classList.remove("is-enter-start");
	}, [shown]);

	return (
		<span ref={ref} className={`t-text-swap ${className}`}>
			{children ? children(shown) : (shown as ReactNode)}
		</span>
	);
}
