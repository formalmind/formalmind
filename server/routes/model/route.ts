import { proxy } from "@/lib/model-gateway";

/** /api/model/v1/*: the Anthropic API for swarm runs holding a formal.team model session (lib/model-gateway.ts). */
const handle = (request: Request) => proxy(request, new URL(request.url).pathname.replace(/^\/api\/model/, ""));

export const POST = handle;
export const GET = handle;
