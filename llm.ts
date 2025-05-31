import { generateText, streamText, generateObject, streamObject } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

import { lambdaModels } from "./lib/llm"

const lambdaModel = createOpenAICompatible({
	name: "lamndaModel",
	apiKey: process.env.LAMBDA_API_KEY!,
	baseURL: process.env.LAMBDA_BASE_URL!
})

const model = lambdaModel(lambdaModels["lfm-7b"])

export const answerMyQuestion = async (prompt: string) => {
	const { text } = await generateText({
		model,
		prompt,
		maxRetries: 1,
	})
	return text;
}

const answer = await answerMyQuestion("What is formal verification?")
console.log(answer)
