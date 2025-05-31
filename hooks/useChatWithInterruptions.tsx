"use client";

import { useChat } from "@ai-sdk/react";
import { useInterruptions } from "@auth0/ai-vercel/react";

export function useChatWithInterruptions() {
  return useInterruptions((handler) =>
    useChat({
      id: "main-chat",
      initialMessages: [],
      onFinish: () => {
        const saved = JSON.stringify([]);
        localStorage.setItem("chat-messages", saved);
      },
      onError: handler((error) => console.error("Chat error:", error)),
    })
  );
}
