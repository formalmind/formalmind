import { useEffect, useState } from "react";
import type { Decorator } from "@storybook/nextjs-vite";

type Handler = (init?: RequestInit) => Response | Promise<Response>;

/** Answers the app's API routes in the browser so stories run without the Next.js server. */
export function withMockFetch(routes: Record<string, Handler>): Decorator {
	return function MockFetch(Story) {
		const [ready, setReady] = useState(false);
		useEffect(() => {
			const real = window.fetch;
			window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const path = new URL(url, window.location.href).pathname;
				const handler = routes[path];
				return handler ? Promise.resolve(handler(init)) : real(input, init);
			}) as typeof fetch;
			setReady(true);
			return () => {
				window.fetch = real;
			};
		}, []);
		return ready ? <Story /> : <></>;
	};
}

export const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

/** One assistant turn in the AI SDK data stream protocol: tool calls first, then the answer streamed in words. */
export function chatStream(tools: { name: string; args: Record<string, unknown>; result: unknown }[], answer: string, delayMs = 40) {
	const encoder = new TextEncoder();
	const line = (code: string, value: unknown) => encoder.encode(`${code}:${JSON.stringify(value)}\n`);
	const usage = { promptTokens: 0, completionTokens: 0 };
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(line("f", { messageId: `msg-${Date.now()}` }));
			for (const [i, tool] of tools.entries()) {
				const toolCallId = `call-${i}`;
				controller.enqueue(line("9", { toolCallId, toolName: tool.name, args: tool.args }));
				await wait(delayMs * 12);
				controller.enqueue(line("a", { toolCallId, result: tool.result }));
			}
			if (tools.length) controller.enqueue(line("e", { finishReason: "tool-calls", usage, isContinued: false }));
			for (const word of answer.split(/(?<= )/)) {
				controller.enqueue(line("0", word));
				await wait(delayMs);
			}
			controller.enqueue(line("e", { finishReason: "stop", usage, isContinued: false }));
			controller.enqueue(line("d", { finishReason: "stop", usage }));
			controller.close();
		},
	});
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "x-vercel-ai-data-stream": "v1" } });
}
