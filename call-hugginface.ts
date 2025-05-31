import { callLLM, HuggingFaceModel, huggingFaceModels } from "./lib/llm";

const res = await callLLM({
	provider: "huggingface",
	model: huggingFaceModels["tiiuae/falcon-7b-instruct"] as HuggingFaceModel,
	messages: [
		{
			role: "user",
			content: "What is formal verification?",
		},
	],
});

console.log("LLM call completed.", res);
