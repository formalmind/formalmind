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

// While a text field has the keyboard, the floating tabs step aside and the composer sits on the keyboard (mobile.css).
const typing = (e: FocusEvent) => (e.target as Element | null)?.matches?.("textarea, input:not([type=checkbox]):not([type=range])") ?? false;
window.addEventListener("focusin", (e) => typing(e) && document.documentElement.classList.add("fm-typing"));
window.addEventListener("focusout", (e) => typing(e) && document.documentElement.classList.remove("fm-typing"));
// WKWebView doesn't shrink the page for the keyboard: the visible height becomes --fm-visible-height, the screens
// size to it while typing (mobile.css), and the page stays put instead of scrolling under the status bar.
const viewport = window.visualViewport;
if (viewport) {
	const fit = () => {
		document.documentElement.style.setProperty("--fm-visible-height", `${Math.round(viewport.height)}px`);
		if (document.documentElement.classList.contains("fm-typing") && window.scrollY) window.scrollTo(0, 0);
	};
	viewport.addEventListener("resize", fit);
	viewport.addEventListener("scroll", fit);
	fit();
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<MobileApp />
		</HashRouter>
	</StrictMode>,
);
