import { GoogleGenAI } from "@google/genai";
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"


export type LLMProvider = 'openai' | 'huggingface' | 'lambda' | 'groq' | 'google'

export interface LLMMessage {
	role: 'user' | 'assistant' | 'system'
	content: string
}

export interface CallLLMOptions {
	provider: LLMProvider
	model: OpenAIModel | HuggingFaceModel | LambdaModel | GoogleModel | GroqModel
	messages: LLMMessage[]
}


export type OpenAIModel = (typeof openAIModelNames)[number]
export const openAIModelNames = [
	"gpt-4o",
	"gpt-4o-mini",
] as const;
export const openAIModels: Record<OpenAIModel, string> = Object.fromEntries(
	openAIModelNames.map((m) => [m, m])
) as Record<OpenAIModel, string>

export type HuggingFaceModel = (typeof huggingFaceModelNames)[number]
export const huggingFaceModelNames = [
	"wellecks/ntpctx-llama3-8b",
	"tiiuae/falcon-7b-instruct"
] as const;
export const huggingFaceModels: Record<HuggingFaceModel, string> = Object.fromEntries(
	huggingFaceModelNames.map((m) => [m, m])
) as Record<HuggingFaceModel, string>

export type LambdaModel = (typeof lambdaModelNames)[number]
export const lambdaModelNames = [
	"deepseek-llama3.3-70b",
	"deepseek-r1-0528",
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
	"qwen25-coder-32b-instruct",
	"qwen3-32b-fp8",
] as const;
export const lambdaModels: Record<LambdaModel, string> = Object.fromEntries(
	lambdaModelNames.map((m) => [m, m])
) as Record<LambdaModel, string>

export type GoogleModel = (typeof googleModelNames)[number]
export const googleModelNames = [
	"gemini-2.0-flash"
] as const;
export const googleModels: Record<GoogleModel, string> = Object.fromEntries(
	googleModelNames.map((m) => [m, m])
) as Record<GoogleModel, string>

export type GroqModel = (typeof groqModelNames)[number];
export const groqModelNames = [
	"llama-4-scout-17b-16e-instruct",
	"llama-4-maverick-17b-128e-instruct",
	"deepseek-r1-distill-llama-70b",
	"meta-llama/llama-guard-4-12b",
	"mistral-saba-24b",
	"gemma2-9b-it",
	"compound-beta",
	"compound-beta-mini",
	"lama-3.1-8b-instant",
	"llama-3.3-70b-versatile",
	"llama-guard-3-8b",
	"llama3-70b-8192",
] as const;
export const groqModels: Record<GroqModel, string> = Object.fromEntries(
	groqModelNames.map((m) => [m, m])
) as Record<GroqModel, string>

export type GroqSpeechToTextModel = (typeof groqSpeechToTextModelNames)[number];
export const groqSpeechToTextModelNames = [
	"distil-whisper-large-v3-en",
	"whisper-large-v",
	"whisper-large-v3-turb",
] as const;
export const groqSpeechToTextModels: Record<GroqSpeechToTextModel, string> = Object.fromEntries(
	groqSpeechToTextModelNames.map((m) => [m, m])
) as Record<GroqSpeechToTextModel, string>

export type GroqTextToSpeechModel = (typeof groqTextToSpeechModelNames)[number];
export const groqTextToSpeechModelNames = [
	"playai-tts",
	"playai-tts-arabi",
] as const;
export const groqTextToSpeechModels: Record<GroqTextToSpeechModel, string> = Object.fromEntries(
	groqTextToSpeechModelNames.map((m) => [m, m])
) as Record<GroqTextToSpeechModel, string>

export async function callLLM({ provider, model, messages }: CallLLMOptions) {
	const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n')

	switch (provider) {
		case "openai": {
			const response = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: model,
					messages: messages
				}),
			});

			const json = await response.json();
			return json.choices?.[0]?.message?.content ?? '[No response]';
		}
		case 'huggingface': {
			const modelId = huggingFaceModels[model as HuggingFaceModel];
			if (!modelId) throw new Error(`Unknown HF model: ${model}`);

			console.log(`Calling Hugging Face model: ${modelId}`)
			const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

			const body = JSON.stringify({
				inputs: prompt,
				parameters: {
					max_new_tokens: 100,
					temperature: 0.7,
				},
			})
			console.log(`Request body: ${body}`)

			const res = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.HF_TOKEN!}`,
					'Content-Type': 'application/json',
				},
				body,
			});

			return res.json();
		}

		case 'google': {
			const modelId = googleModels[model as GoogleModel]
			if (!modelId) throw new Error(`Unknown Lambda model: ${model}`)

			const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

			const response = await ai.models.generateContent({
				model: "gemini-2.0-flash",
				contents: JSON.stringify(messages),
			});
			console.log(response.text);
			return response.text;
		}
		case 'lambda': {
			const lambdaModel = createOpenAICompatible({
				name: "lamndaModel",
				apiKey: process.env.LAMBDA_API_KEY!,
				baseURL: process.env.LAMBDA_BASE_URL!
			})

			const modelId = lambdaModel(lambdaModels[model as LambdaModel])

			const { text } = await generateText({
				model: modelId,
				prompt,
				maxRetries: 1,
			})
			return text;
		}

		case 'groq': {
			const modelId = groqModels[model as GroqModel]
			if (!modelId) throw new Error(`Unknown Grok model: ${model}`)
			const body = JSON.stringify({
				model: modelId,
				messages,
			})
			const res = await fetch(`https://api.groq.com/openai/v1/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: body
			})
			const data = await res.json()

			return data.choices[0].message.content || data.choices[0].text || data.choices[0].message.text || '[No response]';
		}

		default:
			throw new Error(`Unsupported provider: ${provider}`)
	}
}
