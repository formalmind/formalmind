import { callLLM, OpenAIModel, openAIModels } from "./lib/llm";

callLLM({
	provider: "openai",
	model: openAIModels["gpt-4o"] as OpenAIModel,
	messages: [
		{
			role: "user",
			content: "What is the capital of France?",
		},
	],
})
	.then((res) => {
		console.log("LLM call completed.", res);
	})
	.catch((err) => {
		console.error("Error during LLM call:", err);
	});
