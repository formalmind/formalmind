import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import type { UIMessage } from "ai";
import type { SwarmRole } from "@/lib/swarm";
import { ProjectPicker } from "@/components/projects/project-picker";
import { cheer } from "./cursor-moods";
import { SwarmChat } from "./swarm-chat";

const SUGGESTIONS: Partial<Record<SwarmRole, string[]>> = {
	assistant: ["Is anything waiting on me?", "What happened today?", "What should the swarm do next?"],
	planner: ["What's planned next?", "Re-plan what's blocked"],
	prover: ["What are you working on?", "What's stuck?"],
	reviewer: ["What's in review?", "Why was the last PR bounced?"],
	merger: ["What's holding the open PRs?"],
	chief: ["Give me today's status"],
};

/**
 * A private chat with the assistant (or about one agent): saved in the person's account, never posted to GitHub.
 * The assistant relays to the agents and acts on GitHub as formalmind[bot].
 */
export function AgentChat({ role, repo }: { role: SwarmRole; repo: string }) {
	const [saved, setSaved] = useState<UIMessage[] | null>(null);
	// Which project the chat is about; the assistant acts in that project's proofs repository.
	const [project, setProject] = useState("asyncswap/v2");

	useEffect(() => {
		void fetch(`/api/assistant?role=${role}`)
			.then((r) => (r.ok ? r.json() : { messages: [] }))
			.then((body: { messages: UIMessage[] }) => setSaved(body.messages ?? []))
			.catch(() => setSaved([]));
	}, [role]);

	if (!saved) return <Loader2 className="m-4 size-4 animate-spin text-muted-foreground" />;
	return (
		<SwarmChat
			repo={repo}
			chatId={`assistant:${role}`}
			api="/api/assistant"
			body={{ role, project }}
			initialMessages={saved}
			// An answer makes the agent's cursor on the board hop.
			onReply={() => cheer(role, "hop")}
			onMessagesChange={(messages) =>
				void fetch("/api/assistant", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, messages }) })
			}
			intro={
				<p className="text-sm text-muted-foreground">
					{role === "assistant" ? "Your assistant reads the swarm and acts for you." : `Talk to the ${role} through your assistant; it relays what you want and reads the ${role}'s replies.`}
				</p>
			}
			suggestions={SUGGESTIONS[role] ?? []}
			placeholder={`Message the ${role}…`}
			chip={<ProjectPicker repo={project} onSelect={setProject} />}
			footer={
				<p className="mt-2 flex items-start gap-1.5 px-3 text-[11px] leading-4 text-muted-foreground">
					<Lock className="mt-px size-3 shrink-0" />
					<span>Private: only you see this chat. When the assistant acts on GitHub, it posts as formalmind[bot].</span>
				</p>
			}
		/>
	);
}
