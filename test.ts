import { VerificationAgent } from "./packages/agentkit/base-agent";

async function main() {
	const agent = new VerificationAgent();
	await agent.init();

	console.log("✅ Prompt loaded:", agent.prompt.slice(0, 200));
	const reply = await agent.getResponse(agent.formatInput({
		fileDiffs: "--- dummy diff ---",
		username: "mmsaki",
		userPrompt: "Check this logic"
	}));
	console.log("🧠 Agent reply:\n", reply);
}

main();
