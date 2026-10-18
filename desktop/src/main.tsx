import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "katex/dist/katex.min.css";
import "@/src/globals.css";
import "./api";
import { DesktopApp } from "./app";

// Hash routes: the webview serves one index.html, so a reload on #/usage still finds the app.
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<DesktopApp />
		</HashRouter>
	</StrictMode>,
);
