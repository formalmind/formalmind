import { PROMPTS } from '@/github-actions';
import fs from 'fs/promises';
import path from 'path';

export abstract class BaseAgent {
	prompt: string;
	model: string;
	systemPrompt: string;
	private promptFile: string;
	me: string;

	constructor(promptFile: string, model = 'gpt-4o') {
		this.model = model;
		this.systemPrompt = 'You are a Formal Verification Agent assisting developers with finding and fixing logic errors in pull requests using Lean 4.';
		this.prompt = '';
		this.promptFile = promptFile;
		this.me = this.constructor.name;
	}

	async init(): Promise<void> {
		try {
			this.prompt = await this.loadPrompt(this.promptFile);
		} catch (err) {
			console.error(`Error loading prompt file ${this.promptFile}:`, err);
			this.prompt = this.systemPrompt;
		}
	}

	async loadPrompt(promptFile: string): Promise<string> {
		const filePath = path.resolve(process.cwd(), promptFile);
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			return content.replace(/<system_prompt>/g, this.systemPrompt);
		} catch (error) {
			throw new Error(`Failed to load prompt file: ${promptFile}`);
		}
	}

	abstract formatInput(data: any): string;

	async getResponse(userPrompt: string) {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: this.model,
				messages: [
					{ role: 'system', content: this.prompt },
					{ role: 'user', content: userPrompt },
				],
			}),
		});

		const json = await response.json();
		return json.choices?.[0]?.message?.content ?? '[No response]';
	}
}

export class VerificationAgent extends BaseAgent {
	constructor(promptFile: string = PROMPTS.verification) {
		super(promptFile, 'gpt-4o');
	}

	formatInput({ addedFiles, fileDiffs, username, userPrompt }: { addedFiles?: {}, fileDiffs: string; username: string, userPrompt: string }) {
		return `${this.prompt}

- Tag this user ${username} to notify them.
- Example: hey @${username} 👋🏾 Thanks for opening this pull request! I am ${this.me} Let's take a closer look together 👀
Now, review the following pull request diff and respond as a Lean 4 formal verification assistant:

${fileDiffs}

---

Additional user message:
${userPrompt}`;
	}
} // Usage example elsewhere:
// const agent = new VerificationAgent()
// await agent.init()
// const reply = await agent.getResponse(agent.formatInput({ fileDiffs, username, userPrompt }))
