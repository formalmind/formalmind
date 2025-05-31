import { events } from "@/lib/eventBus";
import type { WebhookEvent } from "@octokit/webhooks-types";
export async function GET(request: Request) {
	let isClosed = false;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const write = (payload: WebhookEvent) => {
				if (!isClosed) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				}
			};

			const keepAlive = setInterval(() => {
				if (!isClosed) {
					try {
						controller.enqueue(encoder.encode(":\n\n")); // keep-alive
					} catch (err) {
						console.warn("💀 SSE connection closed:", err);
						clearInterval(keepAlive);
					}
				}
			}, 30_000);

			events.on("default", write);

			controller.enqueue(encoder.encode("data: ready\n\n"));

			// Graceful shutdown
			const close = () => {
				if (!isClosed) {
					isClosed = true;
					clearInterval(keepAlive);
					events.off("default", write);
					controller.close();
				}
			};

			// Defensive: abort on request close
			request.signal.addEventListener("abort", close);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
		},
	});
}
