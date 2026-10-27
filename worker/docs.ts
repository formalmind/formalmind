/* The guide (content/docs/) for agents: each page as Markdown at docs.formal.team/<page>.md and
 * formal.team/docs/<page>.md, or at the page's own path for a client that prefers text/markdown; plus the docs host's
 * llms.txt, sitemap.xml and robots.txt. Browsers get the site, which renders the same files
 * (components/docs/docs-site.tsx). */

import { DOC_PAGES, DOCS_ORIGIN, pageFor, type DocPage } from "@/content/docs/pages";
import { CONTENT_SIGNAL } from "./markdown";
import index from "@/content/docs/index.md";
import install from "@/content/docs/install.md";
import firstRun from "@/content/docs/first-run.md";
import swarm from "@/content/docs/swarm.md";
import statements from "@/content/docs/statements.md";
import proofs from "@/content/docs/proofs.md";
import bugs from "@/content/docs/bugs.md";
import models from "@/content/docs/models.md";
import files from "@/content/docs/files.md";
import agents from "@/content/docs/agents.md";
import auditFormat from "@/content/docs/audit-format.md";

const TEXT: Record<string, string> = {
  index,
  install,
  "first-run": firstRun,
  swarm,
  statements,
  proofs,
  bugs,
  models,
  files,
  agents,
  "audit-format": auditFormat,
};

const url = (p: DocPage) => `${DOCS_ORIGIN}/${p.slug}`.replace(/\/$/, "");

function respond(body: string, type: string): Response {
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "public, max-age=300",
      "content-signal": CONTENT_SIGNAL,
      vary: "Accept",
    },
  });
}

function llmsTxt(): string {
  const sections = [...new Set(DOC_PAGES.map((p) => p.section))];
  const list = sections
    .map((s) => `## ${s}\n\n${DOC_PAGES.filter((p) => p.section === s).map((p) => `- [${p.title}](${DOCS_ORIGIN}/${p.file}.md): ${p.summary}`).join("\n")}`)
    .join("\n\n");
  return `# Formal Mind Docs\n\n> The guide to Formal Mind: a desktop app whose swarm of agents proves Solidity contracts correct in Lean and finds their bugs, on your own computer. Every page is Markdown at its .md link.\n\n${list}\n\n## Elsewhere\n\n- [formal.team llms.txt](https://formal.team/llms.txt): the API, the MCP servers and the agent skills\n`;
}

/** The answer for a docs request, or null to let the site (or the rest of the Worker) answer. */
export function handleDocs(request: Request, prefersMarkdown: boolean): Response | null {
  const { hostname, pathname } = new URL(request.url);
  const docsHost = hostname.startsWith("docs.");
  let path: string;
  if (docsHost) path = pathname;
  else if (pathname === "/docs" || pathname.startsWith("/docs/")) path = pathname.slice("/docs".length) || "/";
  else return null;

  if (docsHost && path === "/llms.txt") return respond(llmsTxt(), "text/plain");
  if (docsHost && path === "/robots.txt") return respond(`User-agent: *\nAllow: /\nContent-Signal: ${CONTENT_SIGNAL}\n\nSitemap: ${DOCS_ORIGIN}/sitemap.xml\n`, "text/plain");
  if (docsHost && path === "/sitemap.xml") {
    const urls = DOC_PAGES.map((p) => `  <url><loc>${url(p) || DOCS_ORIGIN}</loc><changefreq>weekly</changefreq></url>`).join("\n");
    return respond(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, "application/xml");
  }

  const asked = path.endsWith(".md");
  if (!asked && !prefersMarkdown) return null;
  const page = pageFor(path);
  if (!page) return asked ? new Response("Not found", { status: 404 }) : null;
  return respond(TEXT[page.file] ?? "", "text/markdown");
}
