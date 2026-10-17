import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-light.css";
import "./globals.css";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
