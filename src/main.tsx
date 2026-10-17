import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-light.css";
import "./globals.css";
import { App } from "./app";

// A tab opened before a deploy asks for chunks that no longer exist: reload once to pick up the new build.
window.addEventListener("vite:preloadError", (event) => {
	if (sessionStorage.getItem("fm:reloaded-for-chunk")) return;
	event.preventDefault();
	sessionStorage.setItem("fm:reloaded-for-chunk", "1");
	window.location.reload();
});
window.addEventListener("load", () => setTimeout(() => sessionStorage.removeItem("fm:reloaded-for-chunk"), 10_000));

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
