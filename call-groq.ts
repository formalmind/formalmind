import { callLLM, GroqModel, groqModels } from "./lib/llm";


const res = await callLLM({
	provider: "groq",
	model: groqModels["gemma2-9b-it"] as GroqModel,
	messages: [
		{
			role: "user",
			content: "What is the capital of France?",
		},
	],
})

console.log("LLM call completed.", res);
