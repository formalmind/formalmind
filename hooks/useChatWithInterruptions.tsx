"use client";

import { useChat } from "@ai-sdk/react";
import { useInterruptions } from "@auth0/ai-vercel/react";
import type { OpenAIModel } from "@/lib/llm";
import type { Message } from "ai";

export function useChatWithInterruptions({ model, id, initialMessages }: { model: OpenAIModel; id: string; initialMessages: Message[] }) {
  return useInterruptions((handler) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Auth0 useInterruptions wraps useChat by design
    useChat({
      id,
      initialMessages,
      body: { model },
      onError: handler((error) => console.error("Chat error:", error)),
    })
  );
}
