"use client";

import { ChatPage } from "@/components/chat"
import { GitAgent } from "@/packages/agentkit/git-agent"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/auth-context";


export default function OwnerRepoPage() {
	const { owner, repo } = useParams();
	const session = useAuth();
	console.log(`Github repo session:`, session);

	if (!owner || !repo) {
		return <p>Repository not found</p>;
	}
	const agent = new GitAgent({
		owner: owner.toString(),
		repo: repo.toString(),
		session: session
	});
	console.log(`Agent initialized for ${owner.toString()}/${repo.toString()}`);
	console.log(`Agent:`, agent);
	async function initAgent() {
		await agent.cloneRepoInBrowser();
		window.gitAgent = agent;
		return agent.fetchCommitHistoryInBrowser();
	}

	return (
		<div>
			<ChatPage />
			<Button
				variant="outline"
				className="mt-4"
				onClick={async () => { await initAgent().then(console.log) }}
			>
				Get Commit History
			</Button>
		</div>
	)
}
