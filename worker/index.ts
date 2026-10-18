import { Hono, type ExecutionContext } from "hono";
import { auth, handleAuth } from "@/lib/auth";
import { requestContext, type Env } from "./context";

import * as billingBalance from "@/server/routes/billing/balance/route";
import * as billingCheckout from "@/server/routes/billing/checkout/route";
import * as billingWebhook from "@/server/routes/billing/webhook/route";
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
import * as swarmAgent from "@/server/routes/swarm/agent/route";
import * as swarmChat from "@/server/routes/swarm/chat/route";
import * as swarmState from "@/server/routes/swarm/state/route";
import * as tooltip from "@/server/routes/tooltip/route";
import * as usage from "@/server/routes/usage/route";
import * as githubItem from "@/server/routes/github/item/route";
import * as githubWebhook from "@/server/routes/github/webhook/route";

export { ProjectDO } from "./project-do";

type Handler = (request: Request) => Response | Promise<Response>;
type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;

/** The API, path for path what the Next.js app served; `open` routes need no session. */
const ROUTES: Record<string, { module: RouteModule; open?: boolean }> = {
	"/api/assistant": { module: assistant },
	"/api/billing/balance": { module: billingBalance },
	"/api/billing/checkout": { module: billingCheckout },
	"/api/billing/webhook": { module: billingWebhook, open: true },
	"/api/chat": { module: chat },
	"/api/github/install-status": { module: githubInstallStatus },
	"/api/github/item": { module: githubItem },
	"/api/github/webhook": { module: githubWebhook, open: true },
	"/api/github/marketplace": { module: githubMarketplace, open: true },
	"/api/github/repos": { module: githubRepos },
	"/api/onboarding/install": { module: onboardingInstall },
	"/api/onboarding/plan": { module: onboardingPlan, open: true },
	"/api/onboarding/state": { module: onboardingState },
	"/api/project": { module: project },
	"/api/projects": { module: projects },
	"/api/projects/init": { module: projectsInit },
	"/api/swarm/agent": { module: swarmAgent },
	"/api/swarm/chat": { module: swarmChat },
	"/api/swarm/state": { module: swarmState },
	"/api/tooltip": { module: tooltip },
	"/api/usage": { module: usage },
};

const app = new Hono<{ Bindings: Env }>();

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
	if (!route.open && !(await auth.getSession())) return c.json({ error: "unauthenticated" }, 401);
	return handler(c.req.raw);
});

// Built files. A chunk from an older deploy is gone: answer 404 rather than the app's index.html, which a browser
// would try to run as a script.
app.get("/assets/*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw);
	return res.headers.get("content-type")?.includes("text/html") ? c.text("Not found", 404) : res;
});

// Everything else is the single-page app (wrangler serves files and falls back to index.html first).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const context = { request, env, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), setCookies: [] as string[] };
		return requestContext.run(context, () => app.fetch(request, env, ctx));
	},
};
