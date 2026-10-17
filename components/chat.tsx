"use client";

import { FederatedConnectionInterrupt } from "@auth0/ai/interrupts";
import { EnsureAPIAccessPopup } from "@/components/auth0-ai/FederatedConnections/popup";
import { Check, Copy, Share2 } from "lucide-react"
import { Children, isValidElement, useEffect, useRef, useState } from "react"
import { useParams } from "next/navigation"
import { ChatComposer } from "@/components/chat-composer"
import type { OpenAIModel } from "@/lib/llm"
import { useChatWithInterruptions } from "@/hooks/useChatWithInterruptions";
import { useAuth } from "./auth-context";
import LoginPage from "./login";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { useChatConversations, type ChatConversation } from "@/components/chat-conversations";

const markdownSchema: Schema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames || []), "details", "summary"],
	attributes: {
		...defaultSchema.attributes,
		code: [
			...(defaultSchema.attributes?.code || []),
			["className", "math-inline", "math-display", "language-mermaid"],
		],
		details: [...(defaultSchema.attributes?.details || []), "open"],
	},
};

export function ChatPage() {
	const session = useAuth();
	const { activeConversation, isReady, updateMessages } = useChatConversations();

	if (!session) return <LoginPage />;
	if (!isReady || !activeConversation) return <div className="flex min-h-0 flex-1 bg-background" />;

	return (
		<ChatConversationView
			key={activeConversation.id}
			conversation={activeConversation}
			onMessagesChange={updateMessages}
		/>
	);
}

function ChatConversationView({
	conversation,
	onMessagesChange,
}: {
	conversation: ChatConversation;
	onMessagesChange: (id: string, messages: import("ai").Message[]) => void;
}) {
	const [model, setModel] = useState<OpenAIModel>("gpt-6-luna")
	const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
	const [sharedMessageId, setSharedMessageId] = useState<string | null>(null)
	const { messages, input, handleInputChange, handleSubmit, stop, isLoading, toolInterrupt, error } = useChatWithInterruptions({
		model,
		id: conversation.id,
		initialMessages: conversation.messages,
	})
	const scrollAreaRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const params = useParams<{ owner?: string; repo?: string }>()
	const repo = params?.owner && params?.repo ? { owner: params.owner, name: params.repo } : null

	const copyResponse = async (id: string, content: string) => {
		await navigator.clipboard.writeText(content)
		setCopiedMessageId(id)
		setTimeout(() => setCopiedMessageId((current) => current === id ? null : current), 2000)
	}

	const shareResponse = async (id: string, content: string) => {
		if (navigator.share) {
			try {
				await navigator.share({ title: "Formal Mind response", text: content })
				setSharedMessageId(id)
				setTimeout(() => setSharedMessageId((current) => current === id ? null : current), 2000)
				return
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return
			}
		}
		await copyResponse(id, content)
	}

	useEffect(() => {
		onMessagesChange(conversation.id, messages);
	}, [conversation.id, messages, onMessagesChange]);

	// Scroll to bottom on new messages
	useEffect(() => {
		if (scrollAreaRef.current) {
			scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
		}
	}, [messages]);

	// Auto-focus input when user starts typing
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
				return
			}

			if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 1) {
				return
			}

			inputRef.current?.focus()
		}

		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	}, [])

	return (
		<div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-background">
			<div ref={scrollAreaRef} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
				<div className="mx-auto w-full max-w-3xl space-y-6 py-4">
							{messages.map((message) => (
								<div
									key={message.id}
										className={`flex items-end gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
								>

									<div
										className={message.role === "user"
												? "max-w-[85%] rounded-full bg-secondary px-4 py-2 text-sm text-secondary-foreground sm:max-w-[75%]"
											: "min-w-0 flex-1 text-foreground"}
									>
										{message.role === "assistant" ? (
												<>
							<div className="chat-markdown prose prose-sm max-w-none leading-6 dark:prose-invert prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-4 prose-pre:text-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none">
								<ReactMarkdown
									remarkPlugins={[remarkGfm, remarkMath]}
									rehypePlugins={[
										rehypeRaw,
										[rehypeSanitize, markdownSchema],
										[rehypeHighlight, { plainText: ["mermaid"] }],
										rehypeKatex,
									]}
									components={{
										pre({ children, ...props }) {
											const child = Children.toArray(children).find(isValidElement);
											const codeProps = child?.props as { className?: string; children?: React.ReactNode } | undefined;
											if (codeProps?.className?.split(/\s+/).includes("language-mermaid")) {
												return <MermaidDiagram chart={String(codeProps.children ?? "").replace(/\n$/, "")} />;
											}
											return <pre {...props}>{children}</pre>;
										},
									}}
								>
													{message.content || (isLoading ? "" : "The assistant returned an empty response. Please try again.")}
												</ReactMarkdown>
											</div>
											{message.content && (
												<div className="mt-2 flex items-center gap-1 text-muted-foreground">
													<button type="button" aria-label="Copy response" title={copiedMessageId === message.id ? "Copied" : "Copy response"} onClick={() => void copyResponse(message.id, message.content)} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
														{copiedMessageId === message.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
													</button>
													<button type="button" aria-label="Share response" title={sharedMessageId === message.id ? "Shared" : "Share response"} onClick={() => void shareResponse(message.id, message.content)} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
														<Share2 className="h-4 w-4" />
													</button>
												</div>
											)}
												</>
										) : (
											<p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
										)}
									</div>
								</div>
							))}

							{isLoading && (
								<div className="flex gap-3 justify-start">
									<div className="bg-gray-100 rounded-lg px-4 py-2">
										<div className="flex space-x-1">
											<div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
											<div
												className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
												style={{ animationDelay: "0.1s" }}
											></div>
											<div
												className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
												style={{ animationDelay: "0.2s" }}
											></div>
										</div>
									</div>
								</div>
							)}
							<div className="m-4 p-2">
								{FederatedConnectionInterrupt.isInterrupt(toolInterrupt) && (
									<EnsureAPIAccessPopup
										interrupt={toolInterrupt}
										connectWidget={{
											title: "List GitHub respositories",
											description: "This tool list all the users repos",
											action: { label: "Check" },
										}}
									/>
								)}
							</div>
						</div>
			</div>

				<div className="shrink-0 px-4 pb-4 pt-2 sm:px-6 sm:pb-6">
					<div className="mx-auto w-full max-w-3xl">
					{error && <p role="alert" className="mb-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error.message || "The model request failed. Please try again."}</p>}
						<ChatComposer
							textareaRef={inputRef}
							value={input}
							onChange={handleInputChange}
							onSubmit={() => handleSubmit()}
							onStop={stop}
							isLoading={isLoading}
							model={model}
							onModelChange={setModel}
							repo={repo}
						/>
					</div>
				</div>
		</div>
	)
}
