import { streamObject } from "ai";
import { openai } from "@/lib/openai";
import { getJSON, kv, putJSON } from "@/lib/kv";
import { PLANNER_SYSTEM, parseRepo, planPrompt, planSchema, scanRepo, type RepoPlan } from "@/lib/plan";

/** Plans per visitor per hour; each one runs on our key. */
const PER_HOUR = 5;
const CACHE_SECONDS = 12 * 3600;

export async function POST(request: Request) {
	const { repo: input } = (await request.json().catch(() => ({}))) as { repo?: string };
	const repo = input ? parseRepo(input) : null;
	if (!repo) return Response.json({ error: "Enter a GitHub repository, like owner/name." }, { status: 400 });

	const cacheKey = `plan:${repo.toLowerCase()}`;
	const cached = await getJSON<RepoPlan>(cacheKey).catch(() => null);
	if (cached) return new Response(JSON.stringify(cached), { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Plan-Cache": "hit" } });

	const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
	const bucket = `ratelimit:plan:${ip}:${new Date().toISOString().slice(0, 13)}`;
	const store = await kv();
	const used = Number(await store.get(bucket)) || 0;
	if (used >= PER_HOUR) return Response.json({ error: "That's a lot of plans for one hour. Sign up and the planner will keep going on your repo." }, { status: 429 });
	await store.put(bucket, String(used + 1), { expirationTtl: 3700 });

	let scan;
	try {
		scan = await scanRepo(repo);
	} catch (error) {
		console.error("[plan] scan failed:", repo, error);
		const missing = error instanceof Error && error.message === "not-found";
		return Response.json({ error: missing ? `Couldn't find a public repository at ${repo}.` : "GitHub didn't answer just now. Try again in a minute." }, { status: missing ? 404 : 502 });
	}
	if (!scan.files.length) return Response.json({ error: `${scan.repo} has no Solidity contracts outside tests and libraries.` }, { status: 422 });

	const result = streamObject({
		model: openai.responses("gpt-6-luna"),
		schema: planSchema,
		system: PLANNER_SYSTEM,
		prompt: planPrompt(scan),
		onError: ({ error }) => console.error("[plan] stream failed:", error),
		onFinish: async ({ object }) => {
			if (object) await putJSON(cacheKey, object, { expirationTtl: CACHE_SECONDS }).catch(() => {});
		},
	});
	return result.toTextStreamResponse({ headers: { "X-Plan-Repo": scan.repo } });
}
