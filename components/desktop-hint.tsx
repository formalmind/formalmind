"use client";

import { useEffect, useState } from "react";
import { Laptop } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { BottomNotice, getTheAppShown } from "@/components/get-the-app";

const KEY = "fm:desktop-hint-dismissed";

/**
 * On phones, a one-time nudge to the desktop app: the canvas, popovers and pan/zoom are built for a larger screen. Drawn
 * as the iPhone app's bar, and only once that bar is out of the way.
 */
export function DesktopHint() {
	const isMobile = useIsMobile();
	const [dismissed, setDismissed] = useState(true);
	const [appBar, setAppBar] = useState(true);

	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(KEY) === "1");
		} catch {
			setDismissed(false);
		}
		const sync = () => setAppBar(getTheAppShown());
		sync();
		window.addEventListener("fm:get-the-app", sync);
		return () => window.removeEventListener("fm:get-the-app", sync);
	}, []);

	if (!isMobile || dismissed || appBar) return null;
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
