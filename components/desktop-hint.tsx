"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";

const KEY = "fm:desktop-hint-dismissed";

/** On phones, a one-time nudge to the desktop app: the canvas, popovers and pan/zoom are built for a larger screen. */
export function DesktopHint() {
	const isMobile = useIsMobile();
	const [dismissed, setDismissed] = useState(true);

	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(KEY) === "1");
		} catch {
			setDismissed(false);
		}
	}, []);

	if (!isMobile || dismissed) return null;
	const dismiss = () => {
		setDismissed(true);
		try {
			localStorage.setItem(KEY, "1");
		} catch {}
	};
	return (
		<div role="status" className="fixed inset-x-3 bottom-3 z-40 flex items-center gap-3 rounded-2xl border bg-background/95 p-3 pl-4 text-sm shadow-lg backdrop-blur animate-in fade-in-0 slide-in-from-bottom-4 duration-300">
			<p className="min-w-0 flex-1 leading-snug">
				<span className="font-medium">Best on a larger screen.</span>{" "}
				<span className="text-muted-foreground">Open Formal Mind on desktop for the full swarm canvas.</span>
			</p>
			<button type="button" onClick={dismiss} aria-label="Dismiss" className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background transition-colors hover:bg-muted">
				<X className="size-4" />
			</button>
		</div>
	);
}
