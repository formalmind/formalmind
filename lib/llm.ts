import { Groq } from 'groq-sdk';
type LLMProvider = 'huggingface' | 'lambda' | 'groq' | 'google'

interface LLMMessage {
	role: 'user' | 'assistant' | 'system'
	content: string
}

interface CallLLMOptions {
	provider: LLMProvider
	model: string
	messages: LLMMessage[]
}

const huggingFaceModels: Record<string, string> = {
	"wellecks/ntpctx-llama3-8b": "wellecks/ntpctx-llama3-8b",
}
const lambdaModels: Record<string, string> = {
	"deepseek-llama3.3-70b": "deepseek-llama3.3-70b",
	"deepseek-r1-0528": "deepseek-r1-0528",
	"deepseek-r1-671b": "deepseek-r1-671b",
	"deepseek-v3-0324": "deepseek-v3-0324",
	"hermes3-405b": "hermes3-405b",
	"hermes3-70b": "hermes3-70b",
	"hermes3-8b": "hermes3-8b",
	"lfm-40b": "lfm-40b",
	"lfm-7b": "lfm-7b",
	"llama-4-maverick-17b-128e-instruct-fp8": "llama-4-maverick-17b-128e-instruct-fp8",
	"llama-4-scout-17b-16e-instruct": "llama-4-scout-17b-16e-instruct",
	"llama3.1-405b-instruct-fp8": "llama3.1-405b-instruct-fp8",
	"llama3.1-70b-instruct-fp8": "llama3.1-70b-instruct-fp8",
	"llama3.1-8b-instruct": "llama3.1-8b-instruct",
	"llama3.1-nemotron-70b-instruct-fp8": "llama3.1-nemotron-70b-instruct-fp8",
	"llama3.2-11b-vision-instruct": "llama3.2-11b-vision-instruct",
	"llama3.2-3b-instruct": "llama3.2-3b-instruct",
	"llama3.3-70b-instruct-fp8": "llama3.3-70b-instruct-fp8",
	"qwen25-coder-32b-instruct": "qwen25-coder-32b-instruct",
	"qwen3-32b-fp8": "qwen3-32b-fp8",
}

const googleModels: Record<string, string> = {
	"gemini-2.0-flash": "gemini-2.0-flash",
}

const groqModels: Record<string, string> = {
	"llama-4-scout-17b-16e-instruct": "meta-llama/llama-4-scout-17b-16e-instruct",
	"llama-4-maverick-17b-128e-instruct": "meta-llama/llama-4-maverick-17b-128e-instruct",
	"deepseek-r1-distill-llama-70b": "deepseek-r1-distill-llama-70b",
	"meta-llama/llama-guard-4-12b": "meta-llama/llama-guard-4-12b",
	"mistral-saba-24b": "mistral-saba-24b",
	"gemma2-9b-it": "gemma2-9b-it",
	"compound-beta": "compound-beta",
	"compound-beta-mini": "compound-beta-mini",
	"lama-3.1-8b-instant": "lama-3.1-8b-instant",
	"llama-3.3-70b-versatile": "llama-3.3-70b-versatile",
	"llama-guard-3-8b": "llama-guard-3-8b",
	"llama3-70b-8192": "llama3-70b-8192",
}

const groqSpeechToTextModels: Record<string, string> = {
	"distil-whisper-large-v3-en": "distil-whisper-large-v3-en",
	"whisper-large-v": "whisper-large-v",
	"whisper-large-v3-turb": "whisper-large-v3-turb",
}

const groqTextToSpeechModels: Record<string, string> = {
	"playai-tts": "playai-tts",
	"playai-tts-arabi": "playai-tts-arabi",
}

export async function callLLM({ provider, model, messages }: CallLLMOptions) {
	const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n')

	switch (provider) {
		case 'huggingface': {
			const modelId = huggingFaceModels[model]
			if (!modelId) throw new Error(`Unknown HF model: ${model}`)

			const res = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.HF_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ inputs: prompt }),
			})
			return res.json()
		}

		case 'google': {
			const modelId = googleModels[model]
			if (!modelId) throw new Error(`Unknown Lambda model: ${model}`)

			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY!}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.GEMINI_API_KEY!}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ model: modelId, messages }),
			})
			return res.json()
		}
		case 'lambda': {
			const modelId = lambdaModels[model]
			if (!modelId) throw new Error(`Unknown Lambda model: ${model}`)

			const res = await fetch(process.env.LAMBDA_BASE_URL!, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.LAMBDA_API_KEY!}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ model: modelId, messages }),
			})
			return res.json()
		}

		case 'groq': {
			const groq = new Groq();
			const modelId = groqModels[model]
			if (!modelId) throw new Error(`Unknown Grok model: ${model}`)

			const res = await fetch(process.env.GROQ_BASE_URL!, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ model: modelId, messages }),
			})
			return res.json()
		}

		default:
			throw new Error(`Unsupported provider: ${provider}`)
	}
}
