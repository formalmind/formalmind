import { createDataStreamResponse, streamText, type ToolSet } from "ai";
import { setAIContext } from "@auth0/ai-vercel";
import { errorSerializer, withInterruptions } from "@auth0/ai-vercel/interrupts";
import { createOpenAI } from "@ai-sdk/openai";
import { isDevPreview } from "@/lib/auth0";
import { openAIModelNames, type OpenAIModel } from "@/lib/llm";

// AI SDK 4 treats new GPT-6 model IDs as non-reasoning models and adds a
// default temperature to Responses API requests. GPT-6 rejects that field.
	const openAIFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (!url.endsWith("/responses") || typeof init?.body !== "string") {
			return fetch(input, init);
		}

		const body = JSON.parse(init.body);
		if (typeof body.model === "string" && body.model.startsWith("gpt-6")) {
			delete body.temperature;
			delete body.top_p;
			delete body.stop;
		}
		return fetch(input, { ...init, body: JSON.stringify(body) });
	}, { preconnect: fetch.preconnect });

const openai = createOpenAI({ fetch: openAIFetch });

export async function POST(request: Request) {
	if (!process.env.OPENAI_API_KEY) {
		return new Response("Chat is not configured. Set OPENAI_API_KEY in .env.local to enable responses.", { status: 503 });
	}
	const { id, messages, model: requested } = await request.json();
	const model: OpenAIModel = openAIModelNames.includes(requested) ? requested : "gpt-6-luna";
	const tools: ToolSet = isDevPreview ? {} : { listRepositories: (await import("@/lib/tools/list-repositories")).listRepositories };
	setAIContext({ threadID: id });

	return createDataStreamResponse({
		execute: withInterruptions(
			async (dataStream) => {
				const result = streamText({
					model: model.startsWith("gpt-6") ? openai.responses(model) : openai(model),
					system: "You are a friendly assistant! Keep your responses concise and helpful.",
					messages,
					maxSteps: 5,
					tools,
				});

				result.mergeIntoDataStream(dataStream, {
					sendReasoning: true,
				});
			},
			{ messages, tools }
		),
		onError: errorSerializer((err) => {
			console.error("[chat] model request failed:", err);
			if (err instanceof Error) {
				return err.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
			}
			return "The model request failed. Check the server logs for details.";
		}),
	});
}
