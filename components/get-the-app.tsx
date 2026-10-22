import { useState } from "react";
import { X } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { IPHONE_APP } from "@/lib/downloads";
import { inDesktop } from "@/lib/open-web";

const DISMISSED = "fm:get-the-app";

/** A phone or tablet's browser (not the apps' own webviews). */
const onPhone = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && !inDesktop();

/** Whether the iPhone bar is up (a phone's browser, not dismissed): the other bottom notices wait for it. */
export function getTheAppShown() {
	try {
		return onPhone() && localStorage.getItem(DISMISSED) !== "1";
	} catch {
		return onPhone();
	}
}

/**
 * The website's bar along the bottom of a phone: a 40px mark, a title over one line, an optional action, and a dismiss.
 * The iPhone app's offer and the larger-screen hint both use it, so they look the same.
 */
export function BottomNotice({ icon, title, sub, action, onClose, label }: { icon: React.ReactNode; title: string; sub: string; action?: React.ReactNode; onClose: () => void; label: string }) {
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
 * On a phone, the website offers Formal Mind for iPhone: a bar along the bottom, until it's dismissed. Before the app
 * is on the App Store it says it's coming.
 */
export function GetTheApp() {
	const [shown, setShown] = useState(getTheAppShown);
	if (!shown) return null;
	const close = () => {
		setShown(false);
		try {
			localStorage.setItem(DISMISSED, "1");
		} catch {
			/* asked again next visit */
		}
		window.dispatchEvent(new Event("fm:get-the-app"));
	};
	return (
		<BottomNotice
			label="Formal Mind for iPhone"
			icon={<LogoMark size={40} />}
			title="Formal Mind for iPhone"
			sub={IPHONE_APP ? "Proofs, bugs and your Mac's swarm, in the app." : "Coming soon to the App Store."}
			action={
				IPHONE_APP ? (
					<a href={IPHONE_APP} className="btn-dark inline-flex h-8 shrink-0 items-center px-3.5 text-[13px]">
						Get the app
					</a>
				) : null
			}
			onClose={close}
		/>
	);
}
