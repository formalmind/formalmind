import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

export const maxDuration = 30;

export async function POST(req: Request) {
	const { messages } = await req.json();

	const result = streamText({
		model: openai("gpt-4o-mini"),
		maxSteps: 0,
		tools: {},
		messages,
		system: "You are an AI agent for tool calling with Auth0 and can fetch Github repositories.",
		onError({ error }) {
			console.error('streamText error', { error });
		},
	});

	return result.toDataStreamResponse();
}
