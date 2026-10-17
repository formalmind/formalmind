/** The chat's model choices. Kept apart from lib/llm so client components don't pull in the server SDKs. */
export const openAIModelNames = [
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6-astra",
] as const;
export type OpenAIModel = (typeof openAIModelNames)[number]
