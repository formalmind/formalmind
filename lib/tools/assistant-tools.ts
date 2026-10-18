import { tool } from "ai";
import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import { getAppOctokit, getInstallationOctokit } from "@/lib/octokit";
import { ASSISTANT_ISSUE } from "@/lib/swarm";

/**
 * What the private assistant can do on GitHub. Everything goes through the formalmind App's installation, so it
 * appears as formalmind[bot]; the person's own words stay in the private chat.
 */

const ROLES = ["planner", "prover", "rebuilder", "reviewer", "merger", "editor", "chief"] as const;

async function safely<T>(run: () => Promise<T>): Promise<T | { error: string }> {
	try {
		return await run();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

const installations = new Map<string, Promise<Octokit>>();
function appFor(repo: string): Promise<Octokit> {
	const [owner, name] = repo.split("/");
	let hit = installations.get(owner);
	if (!hit) {
		hit = getAppOctokit()
			.request("GET /repos/{owner}/{repo}/installation", { owner, repo: name })
			.then(({ data }) => getInstallationOctokit(data.id));
		hit.catch(() => installations.delete(owner));
		installations.set(owner, hit);
	}
	return hit;
}

/** `focus` is the proofs repository of the project the chat is about; actions default to it. */
export function assistantTools(repos: string[], who: string, focus = repos[0]) {
	const home = repos[0];
	const repo = z.string().describe(`Proofs repository (owner/name), one of: ${repos.join(", ")}`);
	const allowed = (name: string) => {
		if (!repos.includes(name)) throw new Error(`${name} is not one of the swarm's repositories (${repos.join(", ")})`);
		return name;
	};
	const comment = async (target: string, number: number, body: string) => {
		const [owner, name] = allowed(target).split("/");
		const { data } = await (await appFor(target)).rest.issues.createComment({ owner, repo: name, issue_number: number, body });
		return { url: data.html_url };
	};
	return {
		askAgent: tool({
			description: `Hand a question or task to one swarm role: posts "/ask <role> …" as formalmind[bot] on an issue or PR in ${focus}${focus === home ? ` (default: the notebook #${ASSISTANT_ISSUE})` : " (give the issue or PR number; open an issue first if there is none)"}, which gives that role the next turn. Write it as a clear, self-contained request; never paste the user's private words verbatim unless they asked you to.`,
			parameters: z.object({
				role: z.enum(ROLES),
				request: z.string().describe("What the role should answer or do."),
				// OpenAI strict tool schemas need every key required; "no value" is null.
				repo: repo.nullable(),
				number: z.number().int().nullable().describe(focus === home ? `Issue or PR number (default #${ASSISTANT_ISSUE}).` : "Issue or PR number in the project's proofs repository."),
			}),
			execute: ({ role, request, repo: target, number }) =>
				safely(() => {
					const where = target ?? focus;
					if (number == null && where !== home) throw new Error(`Say which issue or PR in ${where}; open one with openIssue first if there is none.`);
					return comment(where, number ?? ASSISTANT_ISSUE, `/ask ${role} ${request}\n\n<sub>Relayed by Formal Mind for @${who}.</sub>`);
				}),
		}),
		commentOn: tool({
			description: "Post a comment as formalmind[bot] on an issue or PR, e.g. to record a decision the user made.",
			parameters: z.object({ repo, number: z.number().int(), body: z.string() }),
			execute: ({ repo: target, number, body }) => safely(() => comment(target, number, body)),
		}),
		openIssue: tool({
			description: "Open an issue as formalmind[bot]. Use fm:todo for work the swarm should pick up, fm:intent for behaviour the user described in words.",
			parameters: z.object({ repo, title: z.string(), body: z.string(), labels: z.array(z.string()).nullable() }),
			execute: ({ repo: target, title, body, labels }) =>
				safely(async () => {
					const [owner, name] = allowed(target).split("/");
					const { data } = await (await appFor(target)).rest.issues.create({ owner, repo: name, title, body, labels: labels ?? undefined });
					return { number: data.number, url: data.html_url };
				}),
		}),
		setLabels: tool({
			description: "Add or remove labels on an issue or PR (for example fm:human-ok to approve, or removing fm:blocked).",
			parameters: z.object({ repo, number: z.number().int(), add: z.array(z.string()).nullable(), remove: z.array(z.string()).nullable() }),
			execute: ({ repo: target, number, add, remove }) =>
				safely(async () => {
					const [owner, name] = allowed(target).split("/");
					const octokit = await appFor(target);
					if (add?.length) await octokit.rest.issues.addLabels({ owner, repo: name, issue_number: number, labels: add });
					for (const label of remove ?? []) await octokit.rest.issues.removeLabel({ owner, repo: name, issue_number: number, name: label }).catch(() => {});
					return { ok: true };
				}),
		}),
	};
}
