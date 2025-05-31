import { createDataStreamResponse, streamText } from "ai";
import { setAIContext } from "@auth0/ai-vercel";
import { errorSerializer, withInterruptions } from "@auth0/ai-vercel/interrupts";
import { openai } from "@ai-sdk/openai";
import { listRepositories } from "@/lib/tools/list-repositories";

export async function POST(request: Request) {
	const { id, messages } = await request.json();
	const tools = { listRepositories };
	setAIContext({ threadID: id });

	return createDataStreamResponse({
		execute: withInterruptions(
			async (dataStream) => {
				const result = streamText({
					model: openai("gpt-4o-mini"),
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
			console.log(err);
			return "Oops, an error occured!";
		}),
	});
}
