import type { SwarmRole } from "@/lib/swarm";

/** One colour per swarm role, shared by the canvas cursors and the docs. */
export const ROLE_COLORS: Record<SwarmRole, string> = {
	dispatcher: "#64748b",
	planner: "#8b5cf6",
	prover: "#3b82f6",
	rebuilder: "#06b6d4",
	reviewer: "#f59e0b",
	merger: "#10b981",
	editor: "#d946ef",
	chief: "#f43f5e",
	assistant: "#eab308",
	hunter: "#f97316",
};

/** What people see a role called, where it isn't the role's id (the hunter is the Bug Hunter). */
export const ROLE_NAMES: Partial<Record<SwarmRole, string>> = { hunter: "Bug Hunter" };
export const roleName = (role: string) => ROLE_NAMES[role as SwarmRole] ?? role;
