import { createOpenAI } from "@ai-sdk/openai";

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

export const openai = createOpenAI({ fetch: openAIFetch });
