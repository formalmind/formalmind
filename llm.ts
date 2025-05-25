import { generateText, streamText, generateObject, streamObject } from "ai"
import { openai } from "@ai-sdk/openai"
import { anthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

const lambdaModels = [
	"deepseek-llama3.3-70b",
	"deepseek-r1-671b",
	"deepseek-v3-0324",
	"hermes3-405b",
	"hermes3-70b",
	"hermes3-8b",
	"lfm-40b",
	"lfm-7b",
	"llama-4-maverick-17b-128e-instruct-fp8",
	"llama-4-scout-17b-16e-instruct",
	"llama3.1-405b-instruct-fp8",
	"llama3.1-70b-instruct-fp8",
	"llama3.1-8b-instruct",
	"llama3.1-nemotron-70b-instruct-fp8",
	"llama3.2-11b-vision-instruct",
	"llama3.2-3b-instruct",
	"llama3.3-70b-instruct-fp8",
	"qwen25-coder-32b-instruct"
]

const lambdaModel = createOpenAICompatible({
	name: "lamndaModel",
	apiKey: process.env.NEXT_PUBLIC_LAMBDA_API_KEY!,
	baseURL: process.env.NEXT_PUBLIC_LAMBDA_BASE_URL!
})

const model = lambdaModel(lambdaModels[0])

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
