/**
 * The model proxy swarm runs call instead of Anthropic. A run holds a model session key (minted from its GitHub OIDC
 * token, lib/swarm-tokens.ts); the proxy checks it, refuses the call when the account is out of credits or the project
 * has spent its day, forwards it with formal.team's own Anthropic key, and charges what the response says it used.
 * Usage is measured here, never reported by the run, so a repository can change its prompts but not its bill.
 */
import { getCredits, recordSpend } from "@/lib/billing";
import { getProofsOwner, TokenError, verifyModelSession } from "@/lib/swarm-tokens";

/**
 * Anthropic's list prices, dollars per million tokens: input, output, cache read. Cache writes cost 1.25x input for
 * the 5-minute cache and 2x for the 1-hour one. Most specific first; an unknown model is charged at the Opus 5.5 row.
 */
const PRICES: [RegExp, number, number, number][] = [
	[/opus-5-5/, 4, 20, 0.2],
	[/fable|mythos/, 10, 50, 0.25],
	[/opus/, 5, 25, 0.5],
	[/sonnet-5/, 2, 10, 0.2],
	[/sonnet/, 3, 15, 0.3],
	[/haiku-5-5/, 0.1, 0.5, 0.01],
	[/haiku/, 1, 5, 0.1],
];

type Usage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};

export function costCents(model: string, u: Usage): number {
	const [, inp, out, read] = PRICES.find(([re]) => re.test(model)) ?? PRICES[0];
	const writes1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	const writes5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - writes1h);
	const usd =
		((u.input_tokens ?? 0) * inp + writes5m * inp * 1.25 + writes1h * inp * 2 + (u.cache_read_input_tokens ?? 0) * read + (u.output_tokens ?? 0) * out) / 1e6;
	return usd * 100;
}

const apiError = (status: number, type: string, message: string) => Response.json({ type: "error", error: { type, message } }, { status });

/** Proxies one Anthropic API call; `path` is the part after /api/model (for example /v1/messages). */
export async function proxy(request: Request, path: string): Promise<Response> {
	const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
	let caller: { sub: string; repo: string; run: string };
	try {
		caller = await verifyModelSession(key);
	} catch (error) {
		return apiError(401, "authentication_error", error instanceof TokenError ? error.message : "Invalid model session.");
	}
	const upstreamKey = process.env.ANTHROPIC_API_KEY;
	if (!upstreamKey) return apiError(503, "api_error", "formal.team's model proxy has no Anthropic key configured.");

	const metered = path === "/v1/messages";
	if (metered) {
		const [credits, owner] = await Promise.all([getCredits(caller.sub), getProofsOwner(caller.repo)]);
		if (credits.cents <= 0) return apiError(402, "billing_error", "Out of Formal Mind credits. Add credits at https://formal.team/billing.");
		const today = new Date().toISOString().slice(0, 10);
		const spentToday = -credits.entries.filter((e) => e.kind === "spend" && e.at.startsWith(today) && e.ref.startsWith(`${caller.repo}:`)).reduce((sum, e) => sum + e.cents, 0);
		if (owner?.dailyUsd && spentToday >= owner.dailyUsd * 100) return apiError(402, "billing_error", `${caller.repo} has spent its $${owner.dailyUsd} for today; the swarm resumes tomorrow.`);
	}

	const headers = new Headers();
	for (const name of ["content-type", "anthropic-version", "anthropic-beta", "accept"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set("x-api-key", upstreamKey);
	// An organization-wide key must name the workspace its usage is billed to.
	if (process.env.ANTHROPIC_WORKSPACE_ID) headers.set("anthropic-workspace-id", process.env.ANTHROPIC_WORKSPACE_ID);
	const upstream = await fetch(`https://api.anthropic.com${path}${new URL(request.url).search}`, {
		method: request.method,
		headers,
		body: request.method === "GET" ? undefined : await request.text(),
	});
	if (!upstream.ok) {
		const text = await upstream.text();
		console.error(`[model] ${caller.repo} ${path} → ${upstream.status}: ${text.slice(0, 500)}`);
		return new Response(text, { status: upstream.status, headers: upstream.headers });
	}
	if (!metered || !upstream.body) return upstream;

	const ref = `${caller.repo}:${caller.run}:${crypto.randomUUID().slice(0, 8)}`;
	const charge = (model: string, usage: Usage) => recordSpend(caller.sub, costCents(model, usage), ref).catch((error) => console.error("[model] charging failed:", error));

	if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const json = (await upstream.json()) as { model?: string; usage?: Usage };
		await charge(json.model ?? "", json.usage ?? {});
		return Response.json(json, { status: upstream.status });
	}

	// Server-sent events: message_start carries the input usage, message_delta the output. Charged as the stream closes.
	let model = "";
	const usage: Usage = {};
	let buffer = "";
	const decoder = new TextDecoder();
	const meter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			buffer += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (!line.startsWith("data:")) continue;
				try {
					const event = JSON.parse(line.slice(5)) as { type?: string; message?: { model?: string; usage?: Usage }; usage?: Usage };
					if (event.type === "message_start") {
						model = event.message?.model ?? model;
						Object.assign(usage, event.message?.usage);
					} else if (event.type === "message_delta" && event.usage) Object.assign(usage, event.usage);
				} catch {
					// A keep-alive or partial line: nothing to meter.
				}
			}
		},
		async flush() {
			await charge(model, usage);
		},
	});
	return new Response(upstream.body.pipeThrough(meter), { status: upstream.status, headers: upstream.headers });
}
