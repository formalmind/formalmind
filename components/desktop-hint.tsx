"use client";

import { useEffect, useState } from "react";
import { Laptop, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";

const KEY = "fm:desktop-hint-dismissed";

/** A bar along the bottom of a phone: an icon, a title over one line, an optional action, and a dismiss. */
function BottomNotice({ icon, title, sub, action, onClose, label }: { icon: React.ReactNode; title: string; sub: string; action?: React.ReactNode; onClose: () => void; label: string }) {
	return (
		<div role="region" aria-label={label} className="fixed inset-x-3 bottom-[max(env(safe-area-inset-bottom),12px)] z-[70] flex items-center gap-3 rounded-[22px] border bg-background/90 p-2.5 pl-3 shadow-pop backdrop-blur-xl animate-in fade-in-0 slide-in-from-bottom-4 duration-300">
			{icon}
			<span className="min-w-0 flex-1">
				<span className="block text-[14px] font-semibold">{title}</span>
				<span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
			</span>
			{action}
			<button type="button" onClick={onClose} aria-label="Dismiss" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted">
				<X className="size-4" />
			</button>
		</div>
	);
}

/**
 * On phones, a one-time nudge to the desktop app: the canvas, popovers and pan/zoom are built for a larger screen.
 */
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
		<BottomNotice
			label="Best on a larger screen"
			icon={
				<span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-muted text-muted-foreground">
					<Laptop className="size-5" />
				</span>
			}
			title="Best on a larger screen"
			sub="The full swarm canvas is on desktop."
			onClose={dismiss}
		/>
	);
}
