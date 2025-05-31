import { EventEmitter } from "events";
import Redis from "ioredis";

export type Delivery = {
	headers: Record<string, string>;
	body: unknown;
	rawdata: string;
	timestamp: number;
};

const events = new EventEmitter();
const REDIS_URL = process.env.REDIS_URL;

let pub: Redis | null = null;
let sub: Redis | null = null;

if (REDIS_URL) {
	pub = new Redis(REDIS_URL);
	sub = new Redis(REDIS_URL);

	sub.subscribe("webhooks");

	sub.on("message", (_, msg) => {
		const { channel, payload } = JSON.parse(msg);
		events.emit(channel, payload);
	});
}

export function emitEvent(channel: string, payload: Delivery) {
	events.emit(channel, payload);
	if (pub) pub.publish("webhooks", JSON.stringify({ channel, payload }));
}

export { events };
