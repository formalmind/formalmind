import { streamObject } from "ai";
import { openai } from "@/lib/openai";
import { getJSON, kv, putJSON } from "@/lib/kv";
import { EXAMPLE_REPOS, PLANNER_SYSTEM, parseRepo, planPrompt, planAiSchema, scanRepo, type RepoPlan } from "@/lib/plan";

/** Plans per visitor per hour; each one runs on our key. */
const PER_HOUR = 5;
/** A plan made for one visitor serves everyone who asks for the same repository this week. */
const CACHE_SECONDS = 7 * 24 * 3600;
/** Compression holds a stream back until it ends (wrangler dev gzips it whole); identity and no-transform keep it chunk by chunk. */
const STREAMING = { "Cache-Control": "no-cache, no-transform", "Content-Encoding": "identity" };
const isExample = (repo: string) => EXAMPLE_REPOS.some((example) => example.toLowerCase() === repo.toLowerCase());

/**
 * Plays a cached plan back as a stream, a few characters at a time, so the plan board fills in the way it does for a
 * fresh plan, at a readable pace and without a model call.
 */
function playBack(plan: RepoPlan) {
	const text = JSON.stringify(plan);
	// About 100 chunks, 20ms apart: a cached plan unfolds in about two seconds, quick but still seen landing.
	const step = Math.max(12, Math.ceil(text.length / 100));
	const encoder = new TextEncoder();
	let at = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (at >= text.length) return controller.close();
			controller.enqueue(encoder.encode(text.slice(at, at + step)));
			at += step;
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
	});
}

export async function POST(request: Request) {
	const { repo: input } = (await request.json().catch(() => ({}))) as { repo?: string };
	const repo = input ? parseRepo(input) : null;
	if (!repo) return Response.json({ error: "Enter a GitHub repository, like owner/name." }, { status: 400 });

	const cacheKey = `plan:${repo.toLowerCase()}`;
	const cached = await getJSON<RepoPlan>(cacheKey).catch(() => null);
	if (cached) return new Response(playBack(cached), { headers: { ...STREAMING, "Content-Type": "text/plain; charset=utf-8", "X-Plan-Cache": "hit" } });

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
		const reason = error instanceof Error ? error.message : "";
		if (reason === "not-found") return Response.json({ error: `Couldn't find a public repository at ${repo}.` }, { status: 404 });
		if (reason === "rate-limited") return Response.json({ error: "We've used up GitHub's request limit for now. Try again in a few minutes." }, { status: 503 });
		return Response.json({ error: "GitHub didn't answer just now. Try again in a minute." }, { status: 502 });
	}
	if (!scan.files.length) return Response.json({ error: `${scan.repo} has no Solidity contracts outside tests and libraries.` }, { status: 422 });

	const result = streamObject({
		model: openai.responses("gpt-6-luna"),
		schema: planAiSchema,
		system: PLANNER_SYSTEM,
		prompt: planPrompt(scan),
		onError: ({ error }) => console.error("[plan] stream failed:", error),
		onFinish: async ({ object }) => {
			// The examples are kept for good; everything else for a week.
			if (object) await putJSON(cacheKey, object, isExample(repo) ? undefined : { expirationTtl: CACHE_SECONDS }).catch(() => {});
		},
	});
	return result.toTextStreamResponse({ headers: { ...STREAMING, "X-Plan-Repo": scan.repo } });
}
