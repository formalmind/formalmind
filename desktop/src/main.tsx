import { reportUncaught } from "@/lib/report-error";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import "katex/dist/katex.min.css";
import "@/src/globals.css";
import "./desktop.css";
import "./api";
import { DesktopApp } from "./app";
import { fadeTruncation } from "@/lib/fade-truncate";

fadeTruncation();

// Hash routes: the webview serves one index.html, so a reload on #/usage still finds the app.
reportUncaught();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<DesktopApp />
		</HashRouter>
	</StrictMode>,
);
