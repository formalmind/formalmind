/* Markdown for Agents, done in the Worker.
 *
 * Cloudflare's zone-level "Markdown for Agents" converts origin HTML, but
 * this host is served by a Worker with static assets and the feature does
 * not touch those responses. So when a request prefers text/markdown over
 * text/html, the Worker answers with a markdown page built from what the
 * route is for and the agent entry points, which is more useful to an agent
 * than a converted SPA shell with no content in it. HTML responses carry
 * `Vary: Accept` so caches keep the two variants apart. */

import { AGENT_LINKS_MARKDOWN, PUBLIC_PATHS } from "./discovery";
import { DESCRIPTION, SITE_NAME, STATUS_LINE } from "./narrative";

export const CONTENT_SIGNAL = "search=yes, ai-input=yes, ai-train=no";

/* RFC 9110 Accept parsing, just enough to rank text/markdown against
 * text/html. A bare "text/markdown" with no html entry counts as a
 * preference; so does a higher q, or equal q listed first. */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let md: { q: number; i: number } | null = null;
  let html: { q: number; i: number } | null = null;
  accept.split(",").forEach((part, i) => {
    const [type, ...params] = part.trim().split(";");
    const q = params
      .map((p) => p.trim().match(/^q=([0-9.]+)$/))
      .reduce<number>((acc, m) => (m ? Number(m[1]) : acc), 1);
    const t = type.trim().toLowerCase();
    if (t === "text/markdown" && !md) md = { q, i };
    if ((t === "text/html" || t === "application/xhtml+xml") && !html) html = { q, i };
  });
  if (!md) return false;
  const m = md as { q: number; i: number };
  if (m.q <= 0) return false;
  if (!html) return true;
  const h = html as { q: number; i: number };
  return m.q > h.q || (m.q === h.q && m.i < h.i);
}

/* Titles match the <Title> each route sets in src/app.tsx. */
const ROUTES: Record<string, { title: string; body: string }> = {
  "/": {
    title: "Formal Mind",
    body: "The front door. Signed out it is the landing page: paste a public GitHub repository and the planner plans it, live. Signed in it is home: your projects and Add a project (a public GitHub repository here; a local folder in the desktop app), each with Code, Bugs and Proofs. Agents: the same plan is `POST /api/onboarding/plan`; the `onboard-a-repository` skill covers the rest.",
  },
  "/welcome": {
    title: "Formal Mind · Prove your Solidity correct",
    body: "The landing page: paste a repository and watch the planner read your contracts and plan the work, then sign in and add it as a project. Download the desktop app (macOS, Windows) to run the swarm on your own computer. Agents: `POST /api/onboarding/plan` with `{\"repo\":\"owner/name\"}` returns the same plan without signing in.",
  },
  "/login": {
    title: "Log in · Formal Mind",
    body: "Sign in with GitHub. There is no password. An agent acting for you uses an OAuth access token from formal.team's authorization server instead; see /auth.md.",
  },
  "/terms": { title: "Terms of Service · Formal Mind", body: "Terms of service for the Formal Mind app." },
  "/privacy": { title: "Privacy Policy · Formal Mind", body: "Privacy policy for the Formal Mind app." },
  "/brand": { title: "Formal Mind brand kit", body: "Logos and brand files for Formal Mind, with a downloadable kit." },
  "/usage": { title: "Usage · Formal Mind", body: "Signed in: every metered cost line formal.team's model route charged." },
  "/chat": { title: "Chat · Formal Mind", body: "Signed in: a private chat with your assistant, kept under your account and never posted to GitHub." },
};

function routeFor(pathname: string): { title: string; body: string; signedIn: boolean } | null {
  const known = ROUTES[pathname];
  if (known) return { ...known, signedIn: !PUBLIC_PATHS.includes(pathname) };
  if (/^\/projects\/[^/]+\/[^/]+(\/code|\/file|\/chat(\/[^/]+)?)?$/.test(pathname)) {
    return { title: "Project · Formal Mind", body: "Signed in: one project's code, Proofs and Bugs, or a chat about it.", signedIn: true };
  }
  if (/^\/github\/[^/]+\/[^/]+$/.test(pathname)) {
    return { title: "Repository · Formal Mind", body: "Signed in: chat about one repository.", signedIn: true };
  }
  return null;
}

export function markdownForPath(pathname: string): string {
  const route = routeFor(pathname);
  const title = route?.title ?? SITE_NAME;
  const body = route
    ? `${route.body}${route.signedIn ? "\n\nThis page needs a GitHub sign-in; a signed-out request is redirected to /login." : ""}`
    : `There is no page at \`${pathname}\`; unknown paths show the front door. ${ROUTES["/"].body}`;
  return `# ${title}

> ${DESCRIPTION}

**${STATUS_LINE}**

${body}

${AGENT_LINKS_MARKDOWN}
`;
}

export function markdownResponse(pathname: string): Response {
  const body = markdownForPath(pathname);
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      vary: "Accept",
      "cache-control": "public, max-age=3600",
      "content-signal": CONTENT_SIGNAL,
      /* Rough token estimate, the same header Cloudflare's converter sets. */
      "x-markdown-tokens": String(Math.ceil(body.length / 4)),
    },
  });
}

/* Paths the Worker's own handlers or the asset store own are never pages:
 * the API, sign-in, built assets, and anything that looks like a file. */
export function isPagePath(pathname: string): boolean {
  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname.startsWith("/oauth/") || pathname === "/login/callback" || pathname.startsWith("/assets/") || pathname === "/mcp" || pathname.startsWith("/mcp/")) return false;
  const last = pathname.split("/").pop() ?? "";
  return !last.includes(".");
}
