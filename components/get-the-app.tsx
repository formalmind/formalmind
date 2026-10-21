import { useState } from "react";
import { X } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { IPHONE_APP } from "@/lib/downloads";
import { inDesktop } from "@/lib/open-web";

const DISMISSED = "fm:get-the-app";

/** A phone or tablet's browser (not the apps' own webviews). */
const onPhone = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && !inDesktop();

/**
 * On a phone, the website offers Formal Mind for iPhone: a bar along the bottom, until it's dismissed. Before the app
 * is on the App Store it says it's coming.
 */
export function GetTheApp() {
	const [shown, setShown] = useState(() => {
		try {
			return onPhone() && localStorage.getItem(DISMISSED) !== "1";
		} catch {
			return onPhone();
		}
	});
	if (!shown) return null;
	const close = () => {
		setShown(false);
		try {
			localStorage.setItem(DISMISSED, "1");
		} catch {
			/* asked again next visit */
		}
	};
	return (
		<div role="region" aria-label="Formal Mind for iPhone" className="fixed inset-x-3 bottom-[max(env(safe-area-inset-bottom),12px)] z-[70] flex items-center gap-3 rounded-[22px] border bg-background/90 p-2.5 pl-3 shadow-pop backdrop-blur-xl">
			<LogoMark size={40} />
			<span className="min-w-0 flex-1">
				<span className="block text-[14px] font-semibold">Formal Mind for iPhone</span>
				<span className="block truncate text-[12px] text-muted-foreground">{IPHONE_APP ? "Proofs, bugs and your Mac's swarm, in the app." : "Coming soon to the App Store."}</span>
			</span>
			{IPHONE_APP ? (
				<a href={IPHONE_APP} className="btn-dark inline-flex h-8 shrink-0 items-center px-3.5 text-[13px]">
					Get the app
				</a>
			) : null}
			<button type="button" onClick={close} aria-label="Dismiss" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted">
				<X className="size-4" />
			</button>
		</div>
	);
}
