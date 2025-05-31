import { callLLM, CallLLMOptions, lambdaModels, LambdaModel } from "./lib/llm";

const opts: CallLLMOptions = {
	provider: "lambda",
	model: lambdaModels["llama3.2-3b-instruct"] as LambdaModel,
	messages: [
		{
			role: "user",
			content: "What is formal verification?",
		},
	],
}
const result = await callLLM(opts)

console.log(result);
