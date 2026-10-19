import { currentRequest } from "@/worker/context";

type D1 = { prepare(sql: string): { first<T>(): Promise<T | null> } };

/** Public numbers for the landing page: how many people have signed up. Cached a minute at the edge. */
export async function GET() {
	const db = currentRequest().env.DB as D1 | undefined;
	if (!db) return Response.json({ error: "The DB (D1) binding is missing." }, { status: 503 });
	const row = await db.prepare("SELECT COUNT(*) AS users FROM users").first<{ users: number }>();
	return Response.json({ users: row?.users ?? 0 }, { headers: { "Cache-Control": "public, max-age=60" } });
}
