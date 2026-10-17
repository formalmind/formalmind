import { EventEmitter } from "events";
import Redis from "ioredis";

export type Delivery = {
	headers: Record<string, string>;
	body: unknown;
	rawdata: string;
	timestamp: number;
};

const events = new EventEmitter();
const origin = crypto.randomUUID();
const REDIS_URL = process.env.REDIS_URL;

let pub: Redis | null = null;
let sub: Redis | null = null;

if (REDIS_URL) {
	pub = new Redis(REDIS_URL);
	sub = new Redis(REDIS_URL);

	pub.on("error", (error) => console.error("Redis publisher:", error.message));
	sub.on("error", (error) => console.error("Redis subscriber:", error.message));
	sub.subscribe("webhooks").catch((error) => console.error("Redis subscription:", error.message));

	sub.on("message", (_, msg) => {
		try {
			const message = JSON.parse(msg);
			if (message.origin !== origin && typeof message.channel === "string") {
				events.emit(message.channel, message.payload);
			}
		} catch {
			console.warn("Ignoring malformed Redis event");
		}
	});
}

export function emitEvent(channel: string, payload: Delivery) {
	events.emit(channel, payload);
	if (pub) {
		void pub.publish("webhooks", JSON.stringify({ channel, payload, origin }))
			.catch((error) => console.error("Redis publish:", error.message));
	}
}

export { events };
