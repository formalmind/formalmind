"use client";

import { FederatedConnectionInterrupt } from "@auth0/ai/interrupts";
import { EnsureAPIAccessPopup } from "@/components/auth0-ai/FederatedConnections/popup";
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Send, Bot, User, Download, Trash2, MessageCircleDashed } from "lucide-react"
import { useEffect, useRef } from "react"
import { useChatWithInterruptions } from "@/hooks/useChatWithInterruptions";
import { useAuth } from "./auth-context";
import Image from "next/image";
import { useUser } from "@auth0/nextjs-auth0";
import LoginPage from "./login";

export function ChatPage() {
	const { messages, input, handleInputChange, handleSubmit, isLoading, setMessages, toolInterrupt } = useChatWithInterruptions()
	const scrollAreaRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const session = useAuth();
	const user = useUser()

	if (!user || !session) {
		return <LoginPage />
	}

	// Load messages on component mount
	useEffect(() => {
		const savedMessages = localStorage.getItem("chat-messages")
		if (savedMessages) {
			try {
				const parsedMessages = JSON.parse(savedMessages)
				setMessages(parsedMessages)
			} catch (error) {
				console.error("Failed to load saved messages:", error)
			}
		}
	}, [setMessages])

	// Save messages whenever they change
	useEffect(() => {
		if (messages.length > 0) {
			localStorage.setItem("chat-messages", JSON.stringify(messages))
		}
	}, [messages])

	// Auto-scroll to bottom when new messages arrive
	useEffect(() => {
		if (scrollAreaRef.current) {
			scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight
		}
	}, [messages])

	// Auto-focus input when user starts typing
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
				return
			}

			if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 1) {
				return
			}

			if (inputRef.current && !isLoading) {
				inputRef.current.focus()
			}
		}

		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	}, [isLoading])

	const clearChat = () => {
		setMessages([])
		localStorage.removeItem("chat-messages")
	}

	const exportChat = () => {
		const chatData = {
			messages,
			exportedAt: new Date().toISOString(),
		}
		const blob = new Blob([JSON.stringify(chatData, null, 2)], { type: "application/json" })
		const url = URL.createObjectURL(blob)
		const a = document.createElement("a")
		a.href = url
		a.download = `chat-export-${new Date().toISOString().split("T")[0]}.json`
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}
	return (
		<div className="flex flex-1 flex-col min-h-0 overflow-hidden">
			<Card className="flex flex-1 flex-col overflow-hidden">
				<CardHeader className="border-b">
					<div className="flex items-center justify-between">
						<CardTitle className="flex items-center gap-2 text-xl">
							<MessageCircleDashed className="h-6 w-6 text-blue-600" />
							Chat Assistant
						</CardTitle>
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={exportChat}
								disabled={messages.length === 0}
								className="text-xs"
							>
								<Download className="h-3 w-3 mr-1" />
								Export
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={clearChat}
								disabled={messages.length === 0}
								className="text-xs text-red-600 hover:text-red-700"
							>
								<Trash2 className="h-3 w-3 mr-1" />
								Clear
							</Button>
						</div>
					</div>
				</CardHeader>

				<CardContent className="flex flex-col flex-1 overflow-hidden p-0 min-h-0">
					<ScrollArea className="flex flex-1 flex-col p-4 overflow-y-auto">
						<div className="flex flex-col flex-1 min-h-0 space-y-4 max-h-none">
							{messages.length === 0 && (
								<div className="flex flex-col flex-1 min-h-0 text-center text-gray-500 mt-8">
									<MessageCircleDashed className="h-12 w-12 mx-auto mb-4 text-gray-400" />
									<p className="text-lg font-medium">Welcome to AI Chat!</p>
									<p className="text-sm">Start a conversation by typing a message below.</p>
								</div>
							)}

							{messages.map((message) => (
								<div
									key={message.id}
									className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
								>

									{message.role === "assistant" && (
										<Avatar className="h-8 w-8 bg-blue-100">
											<AvatarFallback>
												<Bot className="h-4 w-4 text-blue-600" />
											</AvatarFallback>
										</Avatar>
									)}

									<div
										className={`max-w-[70%] rounded-lg px-4 ${message.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"
											}`}
									>
										<p className="text-sm">{message.content}</p>
									</div>

									{message.role === "user" && (

										<Avatar className="h-8 w-8">
											<AvatarImage src={session.user.picture} alt={session.user.name || "User"} />
											<AvatarFallback>
												{session.user?.name ?
													session.user.name.charAt(0).toUpperCase()
													: < User className="h-4 w-4 text-white" />
												}
											</AvatarFallback>
										</Avatar>
									)}
								</div>
							))}

							{isLoading && (
								<div className="flex gap-3 justify-start">
									<Avatar className="h-8 w-8 bg-blue-100">
										<AvatarFallback>
											<Bot className="h-4 w-4 text-blue-600" />
										</AvatarFallback>
									</Avatar>
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
					</ScrollArea>
				</CardContent>

				<CardFooter className="border-t shadow-none bg-white/50 p-4">
					<form onSubmit={handleSubmit} className="flex w-full gap-2">
						<Input
							ref={inputRef}
							value={input}
							onChange={handleInputChange}
							placeholder="Type your message here..."
							disabled={isLoading}
							className="flex-1"
							autoFocus
						/>
						<Button
							type="submit"
							disabled={isLoading || !input.trim()}
							size="icon"
							className="bg-blue-600 hover:bg-blue-700"
						>
							<Send className="h-4 w-4" />
						</Button>
					</form>
				</CardFooter>
			</Card>
		</div>
	)
}
