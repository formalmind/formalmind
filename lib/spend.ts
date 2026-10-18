import type { SwarmCost } from "@/lib/swarm";
import { currentRequest } from "@/worker/context";

/** The swarm's spend lives in one Project Durable Object for now (the shared ledger); later one per project. */
export const SPEND_OBJECT = "swarm:asyncswap/v2-proofs";

type ProjectStub = {
	costs(): Promise<{ costs: SwarmCost[]; syncedAt: number | null }>;
	addComments(comments: { body: string; created_at: string; updated_at: string; html_url: string }[]): Promise<number>;
};

export function projectObject(name = SPEND_OBJECT): ProjectStub | null {
	const ns = currentRequest().env.PROJECT;
	return ns ? (ns.get(ns.idFromName(name)) as unknown as ProjectStub) : null;
}
