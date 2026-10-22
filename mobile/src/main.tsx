import { reportUncaught } from "@/lib/report-error";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "katex/dist/katex.min.css";
import "@/src/globals.css";
import "./mobile.css";
// The shared components' fetch("/api/…") goes to formal.team with the app's token, as in the Mac app.
import "@/desktop/src/api";
import { MobileApp } from "./app";

reportUncaught();

// While the keyboard is up, the floating tabs step aside and the composer sits on it (mobile.css). That's decided by
// the keyboard itself (the visible height shrinking) with a text field focused, not by focus alone: with no on-screen
// keyboard (a hardware one) nothing moves.
const typingField = () => document.activeElement?.matches?.("textarea, input:not([type=checkbox]):not([type=range])") ?? false;
// WKWebView doesn't shrink the page for the keyboard: the visible height becomes --fm-visible-height, the screens
// size to it while typing (mobile.css), and the page stays put instead of scrolling under the status bar.
const viewport = window.visualViewport;
const fit = () => {
	const root = document.documentElement;
	const visible = viewport?.height ?? window.innerHeight;
	root.style.setProperty("--fm-visible-height", `${Math.round(visible)}px`);
	const keyboard = typingField() && window.innerHeight - visible > 120;
	root.classList.toggle("fm-typing", keyboard);
	if (keyboard && window.scrollY) window.scrollTo(0, 0);
};
viewport?.addEventListener("resize", fit);
viewport?.addEventListener("scroll", fit);
window.addEventListener("focusin", fit);
// After focus leaves, the next field (if any) has it by the time this runs.
window.addEventListener("focusout", () => setTimeout(fit));
fit();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<MobileApp />
		</HashRouter>
	</StrictMode>,
);
