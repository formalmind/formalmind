"use client";

import { useChat } from "@ai-sdk/react";
import { useInterruptions } from "@auth0/ai-vercel/react";
import type { OpenAIModel } from "@/lib/llm";
import type { ThinkLevel } from "@/lib/models";
import type { Message } from "ai";

/** `project` ("owner/name") tells the server which repository the chat is about. */
export function useChatWithInterruptions({ model, think, id, initialMessages, project }: { model: OpenAIModel; think?: ThinkLevel; id: string; initialMessages: Message[]; project?: string }) {
  return useInterruptions((handler) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Auth0 useInterruptions wraps useChat by design
    useChat({
      id,
      initialMessages,
      body: { model, think, project },
      onError: handler((error) => console.error("Chat error:", error)),
    })
  );
}
