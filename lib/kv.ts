import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The parts of a Workers KV namespace this app uses. */
export interface KV {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
	delete(key: string): Promise<void>;
	list<M = unknown>(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: M }[]; list_complete: boolean; cursor?: string }>;
}

/** The FORMALMIND namespace (wrangler.jsonc); wrangler's local copy under `next dev`. */
export async function kv(): Promise<KV> {
	const { env } = await getCloudflareContext({ async: true });
	const namespace = (env as unknown as { FORMALMIND?: KV }).FORMALMIND;
	if (!namespace) throw new Error("The FORMALMIND KV binding is missing; see wrangler.jsonc.");
	return namespace;
}

export async function getJSON<T>(key: string): Promise<T | null> {
	const raw = await (await kv()).get(key);
	return raw ? (JSON.parse(raw) as T) : null;
}

export async function putJSON(key: string, value: unknown, options?: { expirationTtl?: number }) {
	await (await kv()).put(key, JSON.stringify(value), options);
}
