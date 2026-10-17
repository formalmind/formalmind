"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Message } from "ai";

const STORAGE_KEY = "formal-mind-chat-conversations";
const ACTIVE_STORAGE_KEY = "formal-mind-active-chat";

export type ChatConversation = {
	id: string;
	title: string;
	updatedAt: number;
	messages: Message[];
	repo?: RepoProject;
};

export type RepoProject = {
	id: number;
	name: string;
	owner: string;
	fullName: string;
	private: boolean;
};

type ChatConversationsContextValue = {
	conversations: ChatConversation[];
	activeConversation: ChatConversation | null;
	isReady: boolean;
	createConversation: (repo?: RepoProject) => void;
	selectConversation: (id: string) => void;
	updateMessages: (id: string, messages: Message[]) => void;
};

const ChatConversationsContext = createContext<ChatConversationsContextValue | null>(null);

export function ChatConversationsProvider({ children }: { children: React.ReactNode }) {
	const [conversations, setConversations] = useState<ChatConversation[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [isReady, setIsReady] = useState(false);

	useEffect(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			let loaded = saved ? JSON.parse(saved) as ChatConversation[] : [];
			if (!Array.isArray(loaded)) loaded = [];

			// Keep conversations from the previous single-chat local storage format.
			if (loaded.length === 0) {
				const legacyMessages = localStorage.getItem("chat-messages");
				if (legacyMessages) {
					const messages = JSON.parse(legacyMessages) as Message[];
					if (Array.isArray(messages) && messages.length > 0) {
						loaded = [{ id: "main-chat", title: "Previous chat", updatedAt: Date.now(), messages }];
					}
				}
			}

			const nextId = localStorage.getItem(ACTIVE_STORAGE_KEY);
			// Open an empty chat on the home screen. Existing conversations stay stored
			// locally, but the rebuilt chat-first landing page starts with a clean canvas.
			const active = loaded.find((conversation) => conversation.id === nextId && conversation.messages.length === 0)
				?? loaded.find((conversation) => conversation.messages.length === 0);
			if (!active) {
				const initial = { id: crypto.randomUUID(), title: "New chat", updatedAt: Date.now(), messages: [] };
				loaded = [initial];
				setActiveId(initial.id);
			} else {
				setActiveId(active.id);
			}
			setConversations(loaded);
		} catch (error) {
			console.error("Failed to load local chats:", error);
			const initial = { id: crypto.randomUUID(), title: "New chat", updatedAt: Date.now(), messages: [] };
			setConversations([initial]);
			setActiveId(initial.id);
		} finally {
			setIsReady(true);
		}
	}, []);

	useEffect(() => {
		if (!isReady) return;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
		if (activeId) localStorage.setItem(ACTIVE_STORAGE_KEY, activeId);
	}, [activeId, conversations, isReady]);

	const createConversation = useCallback((repo?: RepoProject) => {
		const conversation = {
			id: crypto.randomUUID(),
			title: "New chat",
			updatedAt: Date.now(),
			messages: [],
			repo,
		};
		setConversations((current) => [conversation, ...current]);
		setActiveId(conversation.id);
	}, []);

	const selectConversation = useCallback((id: string) => setActiveId(id), []);

	const updateMessages = useCallback((id: string, messages: Message[]) => {
		setConversations((current) => current.map((conversation) => {
			if (conversation.id !== id) return conversation;
			const firstUserMessage = messages.find((message) => message.role === "user")?.content.trim();
			return {
				...conversation,
				title: firstUserMessage ? (firstUserMessage.length > 36 ? `${firstUserMessage.slice(0, 36)}…` : firstUserMessage) : conversation.title,
				updatedAt: Date.now(),
				messages,
			};
		}));
	}, []);

	const activeConversation = conversations.find((conversation) => conversation.id === activeId) ?? null;
	const value = useMemo(() => ({
		conversations,
		activeConversation,
		isReady,
		createConversation,
		selectConversation,
		updateMessages,
	}), [conversations, activeConversation, isReady, createConversation, selectConversation, updateMessages]);

	return <ChatConversationsContext.Provider value={value}>{children}</ChatConversationsContext.Provider>;
}

export function useChatConversations() {
	const context = useContext(ChatConversationsContext);
	if (!context) throw new Error("useChatConversations must be used inside ChatConversationsProvider");
	return context;
}
