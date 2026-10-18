import { createDataStreamResponse, streamText, type ToolSet } from "ai";
import { isDevPreview } from "@/lib/auth";
import { openAIModelNames, type OpenAIModel } from "@/lib/llm";
import { openai } from "@/lib/openai";

export async function POST(request: Request) {
	if (!process.env.OPENAI_API_KEY) {
		return new Response("Chat is not configured. Set OPENAI_API_KEY in .env.local to enable responses.", { status: 503 });
	}
	const { messages, model: requested, project } = await request.json();
	// A project chat is about one repository; say which, so answers stay on it.
	const scope =
		typeof project === "string" && /^[\w.-]+\/[\w.-]+$/.test(project)
			? ` The user is asking about their project ${project} (https://github.com/${project}).`
			: "";
	const model: OpenAIModel = openAIModelNames.includes(requested) ? requested : "gpt-6-luna";
	const tools: ToolSet = isDevPreview ? {} : { listRepositories: (await import("@/lib/tools/list-repositories")).listRepositories };

	return createDataStreamResponse({
		execute: async (dataStream) => {
			const result = streamText({
				model: model.startsWith("gpt-6") ? openai.responses(model) : openai(model),
				system: `You are a friendly assistant! Keep your responses concise and helpful.${scope}`,
				messages,
				maxSteps: 5,
				tools,
			});

			result.mergeIntoDataStream(dataStream, {
				sendReasoning: true,
			});
		},
		onError: (err) => {
			console.error("[chat] model request failed:", err);
			if (err instanceof Error) {
				return err.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
			}
			return "The model request failed. Check the server logs for details.";
		},
	});
}
