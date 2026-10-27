/**
 * The guide at docs.formal.team (and formal.team/docs). Each page is a Markdown file in this folder named by its
 * slug (`index.md` for the home page); this list is the sidebar's order. The site renders the files
 * (components/docs/docs-site.tsx) and the Worker serves them as Markdown to agents (worker/docs.ts).
 */
export const DOCS_ORIGIN = "https://docs.formal.team";

export type DocPage = { slug: string; file: string; title: string; section: string; summary: string };

export const DOC_PAGES: DocPage[] = [
	{ slug: "", file: "index", title: "Formal Mind", section: "Start here", summary: "What Formal Mind does and how its pieces fit." },
	{ slug: "install", file: "install", title: "Install the app", section: "Start here", summary: "Download the desktop app, sign in, and keep it up to date." },
	{ slug: "first-run", file: "first-run", title: "Your first run", section: "Start here", summary: "Add a Foundry project and start the swarm on it." },
	{ slug: "swarm", file: "swarm", title: "The swarm", section: "Prove", summary: "The plan, the agents, and how a function gets proved." },
	{ slug: "statements", file: "statements", title: "Statements", section: "Prove", summary: "Claims in plain words, formalized, confirmed and proved." },
	{ slug: "proofs", file: "proofs", title: "Proofs", section: "Prove", summary: "Lean coverage of your contracts, function by function." },
	{ slug: "bugs", file: "bugs", title: "Bugs and reports", section: "Find bugs", summary: "Findings with their PoCs, audit reports, and Formal Mind's report." },
	{ slug: "models", file: "models", title: "Models and costs", section: "Reference", summary: "Who runs the agents: your Claude plan or your own key." },
	{ slug: "files", file: "files", title: "Files in your project", section: "Reference", summary: "What Formal Mind reads and writes in your folder." },
	{ slug: "agents", file: "agents", title: "Agents and MCP", section: "Reference", summary: "Connect Claude, ChatGPT or Cursor to Formal Mind." },
	{ slug: "audit-format", file: "audit-format", title: "The audit format", section: "Reference", summary: "formalmind.audit/v1, the JSON file per audit report." },
];

/** The page a path names, relative to the docs' root (`/statements`, `statements.md`, `/`). */
export function pageFor(path: string): DocPage | undefined {
	const slug = path.replace(/^\/+|\/+$/g, "").replace(/\.md$/, "").replace(/^index$/, "");
	return DOC_PAGES.find((p) => p.slug === slug);
}
