import { Hono, type ExecutionContext } from "hono";
import { auth, handleAuth, type Principal } from "@/lib/auth";
import { issuer, type Scope } from "@/lib/oauth";
import { requestContext, type Env } from "./context";
import { DISCOVERY_LINK_HEADER, handleDiscovery } from "./discovery";
import { handleOAuth } from "./oauth";
import { CONTENT_SIGNAL, isPagePath, markdownResponse, prefersMarkdown } from "./markdown";

import * as billingBalance from "@/server/routes/billing/balance/route";
import * as billingCheckout from "@/server/routes/billing/checkout/route";
import * as billingWebhook from "@/server/routes/billing/webhook/route";
import * as model from "@/server/routes/model/route";
import * as swarmToken from "@/server/routes/swarm/token/route";
import * as stats from "@/server/routes/stats/route";
import * as chat from "@/server/routes/chat/route";
import * as githubInstallStatus from "@/server/routes/github/install-status/route";
import * as githubRepos from "@/server/routes/github/repos/route";
import * as githubMarketplace from "@/server/routes/github/marketplace/route";
import * as onboardingInstall from "@/server/routes/onboarding/install/route";
import * as onboardingPlan from "@/server/routes/onboarding/plan/route";
import * as onboardingState from "@/server/routes/onboarding/state/route";
import * as project from "@/server/routes/project/route";
import * as projects from "@/server/routes/projects/route";
import * as assistant from "@/server/routes/assistant/route";
import * as projectsInit from "@/server/routes/projects/init/route";
import * as projectsSwarm from "@/server/routes/projects/swarm/route";
import * as projectsTree from "@/server/routes/projects/tree/route";
import * as projectsFile from "@/server/routes/projects/file/route";
import * as projectsGit from "@/server/routes/projects/git/route";
import * as swarmAgent from "@/server/routes/swarm/agent/route";
import * as swarmChat from "@/server/routes/swarm/chat/route";
import * as swarmState from "@/server/routes/swarm/state/route";
import * as tooltip from "@/server/routes/tooltip/route";
import * as usage from "@/server/routes/usage/route";
import * as desktopAuthorize from "@/server/routes/desktop/authorize/route";
import * as desktopToken from "@/server/routes/desktop/token/route";
import * as desktopModelSession from "@/server/routes/desktop/model-session/route";
import * as desktopReport from "@/server/routes/desktop/report/route";
import * as relayMac from "@/server/routes/relay/mac/route";
import * as relayClient from "@/server/routes/relay/client/route";
import * as githubItem from "@/server/routes/github/item/route";
import * as githubWebhook from "@/server/routes/github/webhook/route";

export { ProjectDO } from "./project-do";
export { RelayDO } from "./relay-do";

type Handler = (request: Request) => Response | Promise<Response>;
type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;

/**
 * The API, path for path what the Next.js app served; `open` routes need no session. A route with a `scope` also
 * accepts an OAuth access token carrying that scope (lib/oauth.ts); every other route is the person's own (cookie or
 * desktop session) and answers 403 to a token.
 */
const ROUTES: Record<string, { module: RouteModule; open?: boolean; scope?: Scope }> = {
	"/api/assistant": { module: assistant },
	"/api/billing/balance": { module: billingBalance, scope: "swarm:read" },
	"/api/billing/checkout": { module: billingCheckout },
	"/api/billing/webhook": { module: billingWebhook, open: true },
	"/api/chat": { module: chat },
	// Desktop sign-in: authorize checks the session itself (it sends people to sign in first); token is the code exchange.
	"/api/desktop/authorize": { module: desktopAuthorize, open: true },
	"/api/desktop/token": { module: desktopToken, open: true },
	"/api/desktop/model-session": { module: desktopModelSession },
	"/api/desktop/report": { module: desktopReport },
	// The swarm relay (lib/relay.ts): the Mac app publishes its swarm here and takes commands; the phone reads and steers.
	"/api/relay/mac": { module: relayMac },
	"/api/relay/client": { module: relayClient },
	"/api/github/install-status": { module: githubInstallStatus },
	"/api/github/item": { module: githubItem },
	"/api/github/webhook": { module: githubWebhook, open: true },
	"/api/github/marketplace": { module: githubMarketplace, open: true },
	"/api/github/repos": { module: githubRepos },
	"/api/onboarding/install": { module: onboardingInstall },
	"/api/onboarding/plan": { module: onboardingPlan, open: true },
	"/api/onboarding/state": { module: onboardingState },
	"/api/project": { module: project },
	"/api/projects": { module: projects, scope: "swarm:read" },
	"/api/projects/init": { module: projectsInit, scope: "swarm:write" },
	"/api/projects/swarm": { module: projectsSwarm, scope: "swarm:write" },
	"/api/projects/tree": { module: projectsTree, scope: "swarm:read" },
	"/api/projects/file": { module: projectsFile, scope: "swarm:read" },
	// A read-only git proxy (upload-pack only) so the web app can clone a project into the browser.
	"/api/projects/git": { module: projectsGit, scope: "swarm:read" },
	"/api/swarm/agent": { module: swarmAgent },
	"/api/swarm/chat": { module: swarmChat },
	"/api/stats": { module: stats, open: true },
	"/api/swarm/state": { module: swarmState, scope: "swarm:read" },
	// Zero-secret swarms: a proofs repository's workflow proves itself with its Actions OIDC token (lib/swarm-tokens.ts).
	"/api/swarm/token": { module: swarmToken, open: true },
	// The metered model proxy; callers hold a model session minted by /api/swarm/token.
	"/api/model/v1/messages": { module: model, open: true },
	"/api/model/v1/messages/count_tokens": { module: model, open: true },
	"/api/tooltip": { module: tooltip },
	"/api/usage": { module: usage, scope: "swarm:read" },
};

/** RFC 6750 §3: where a client finds the authorization server (RFC 9728), and why its token was refused. */
function wwwAuthenticate(principal: Principal, scope?: Scope): string {
	const parts = [`resource_metadata="${issuer()}/.well-known/oauth-protected-resource"`];
	if (principal.via === "invalid") parts.push('error="invalid_token"', `error_description="${(principal.reason ?? "invalid token").replace(/"/g, "'")}"`);
	if (scope) parts.push(`scope="${scope}"`);
	return `Bearer ${parts.join(", ")}`;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * The apps' webview origins (macOS/iOS/Linux, Windows, and the Mac and iPhone apps' Vite dev servers). They
 * authenticate with a bearer token, never cookies.
 */
const DESKTOP_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", "http://localhost:1421"]);

app.use("/api/*", async (c, next) => {
	const origin = c.req.header("origin");
	const allowed = origin && DESKTOP_ORIGINS.has(origin);
	if (allowed && c.req.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
				// Authorization and Content-Type, plus what the browser-side git client sends (Git-Protocol).
				"Access-Control-Allow-Headers": "Authorization, Content-Type, Git-Protocol",
				"Access-Control-Max-Age": "86400",
				Vary: "Origin",
			},
		});
	}
	await next();
	if (allowed) {
		c.res = new Response(c.res.body, c.res);
		c.res.headers.set("Access-Control-Allow-Origin", origin);
		c.res.headers.append("Vary", "Origin");
	}
});

// Agent discovery (worker/discovery.ts): robots.txt, sitemap.xml, llms.txt, auth.md, /.well-known/* and the MCP
// servers at /mcp and /mcp/account must never fall through to the SPA's index.html. A page requested with Accept: text/markdown gets a
// markdown rendering instead of the app shell (worker/markdown.ts). Both run before the API and the assets.
app.use("*", async (c, next) => {
	const discovery = await handleDiscovery(c.req.raw);
	if (discovery) return discovery;
	if (isPagePath(new URL(c.req.url).pathname) && prefersMarkdown(c.req.header("accept") ?? null)) {
		return markdownResponse(new URL(c.req.url).pathname);
	}
	await next();
});

app.get("/auth/*", (c) => handleAuth(new URL(c.req.url).pathname));
app.get("/login/callback", (c) => handleAuth(new URL(c.req.url).pathname));

/** Who is signed in, for the browser: the profile only, never tokens. */
app.get("/api/me", async (c) => {
	const session = await auth.getSession();
	return c.json(session ? { user: session.user } : { user: null });
});

app.all("/api/*", async (c) => {
	const route = ROUTES[new URL(c.req.url).pathname];
	const handler = route?.module[c.req.method as keyof RouteModule];
	if (!route || !handler) return c.json({ error: "Not found" }, 404);
	if (!route.open) {
		const principal = await auth.getPrincipal();
		if (!principal.session) {
			// A token-capable route tells the client where to get one; the others stay as they were.
			const headers = route.scope || principal.via === "invalid" ? { "WWW-Authenticate": wwwAuthenticate(principal, route.scope) } : undefined;
			return c.json({ error: "unauthenticated", ...(principal.reason ? { error_description: principal.reason } : {}) }, 401, headers);
		}
		if (principal.via === "token") {
			if (!route.scope) {
				return c.json({ error: "insufficient_scope", error_description: "This route is not open to OAuth tokens; it needs the person's own session." }, 403, { "WWW-Authenticate": 'Bearer error="insufficient_scope"' });
			}
			if (!principal.scopes.includes(route.scope)) {
				return c.json({ error: "insufficient_scope", error_description: `This route needs the ${route.scope} scope.`, scope: route.scope }, 403, {
					"WWW-Authenticate": `Bearer error="insufficient_scope", scope="${route.scope}"`,
				});
			}
		}
	}
	return handler(c.req.raw);
});

// The OAuth 2.0 authorization server (worker/oauth.ts): registration, authorize, token, revoke.
app.all("/oauth/*", (c) => handleOAuth(c.req.raw));

// Built files. A chunk from an older deploy is gone: answer 404 rather than the app's index.html, which a browser
// would try to run as a script.
app.get("/assets/*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw);
	return res.headers.get("content-type")?.includes("text/html") ? c.text("Not found", 404) : res;
});

// Everything else is the single-page app: the asset store serves files and falls back to index.html. HTML responses
// carry the agent entry points (RFC 8288 Link), the Content-Signal policy from robots.txt, and Vary: Accept because the
// same path answers in markdown to a client that prefers it.
app.all("*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw);
	if (!res.headers.get("content-type")?.includes("text/html")) return res;
	const html = new Response(res.body, res);
	html.headers.set("link", DISCOVERY_LINK_HEADER);
	html.headers.set("content-signal", CONTENT_SIGNAL);
	const vary = html.headers.get("vary");
	html.headers.set("vary", vary ? `${vary}, Accept` : "Accept");
	return html;
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const context = { request, env, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), setCookies: [] as string[] };
		return requestContext.run(context, () => app.fetch(request, env, ctx));
	},
};
