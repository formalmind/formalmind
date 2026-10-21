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

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HashRouter>
			<MobileApp />
		</HashRouter>
	</StrictMode>,
);
