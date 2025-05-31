import { Octokit } from "octokit";
import simpleGit from "simple-git";
import fs, { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { format } from "date-fns";
import { diffLines } from "diff";
import { extractJsonCodeBlock, extractLeanCodeBlock } from "./helpers";

interface RepoAgentOptions {
	octokit: Octokit;
	targetOwner: string;
	targetRepo: string;
	commentBody: string;
	meta?: {
		commitSha?: string;
		pullNumber?: number;
		issueNumber?: number;
	};
}

interface ReconcileUpdateOptions {
	repoPath: string;
	branch: string;
	reconciledLean: string;
	originalCommitSha?: string;
}

export class TemplateRepoWriterAgent {
	octokit: Octokit;
	templateOwner: string;
	templateRepo: string;
	targetOwner: string;
	targetRepo: string;
	commentBody: string;
	tmpDir: string;
	meta: RepoAgentOptions["meta"];
	modelingDir: string;

	constructor(options: RepoAgentOptions) {
		this.octokit = options.octokit;
		this.templateOwner = "formalmind";
		this.templateRepo = "lean-template";
		this.targetOwner = options.targetOwner;
		this.targetRepo = options.targetRepo;
		this.commentBody = options.commentBody;
		this.meta = options.meta || {};
		const runId = Date.now().toString();
		this.tmpDir = path.join(os.tmpdir(), `/modeling-agent-${runId}`);
		this.modelingDir = path.join(this.tmpDir, "modeling");
	}

	async repoExists(): Promise<boolean> {
		try {
			await this.octokit.request('GET /repos/{owner}/{repo}', {
				owner: this.targetOwner,
				repo: this.targetRepo,
			});
			return true;
		} catch (e: any) {
			if (e.status === 404) return false;
			throw e;
		}
	}

	extractCodeBlocks() {
		const leanMatch = extractLeanCodeBlock(this.commentBody);
		const jsonMatch = extractJsonCodeBlock(this.commentBody);
		return {
			lean: leanMatch,
			json: jsonMatch,
		};
	}

	async createRepoFromTemplate(): Promise<{ cloneUrl: string, defaultBranch: string }> {
		const { data } = await this.octokit.request(
			"POST /repos/{template_owner}/{template_repo}/generate",
			{
				template_owner: this.templateOwner,
				template_repo: this.templateRepo,
				owner: this.targetOwner,
				name: this.targetRepo,
				private: true,
				include_all_branches: false,
				headers: {
					"x-github-api-version": "2022-11-28"
				}
			}
		);
		return {
			cloneUrl: data.clone_url,
			defaultBranch: data.default_branch // ← This is the magic
		};
	}

	async generateReviewSummary(existing: string, updated: string): Promise<string> {
		const diff = diffLines(existing, updated);
		let review = `# Modeling Agent Review\n\n`;
		review += `This summary reflects changes proposed by the modeling agent.\n\n`;
		review += `## Diff\n\n`;

		for (const part of diff) {
			const prefix = part.added ? "+" : part.removed ? "-" : " ";
			review += part.value
				.split("\n")
				.map((line) => `${prefix} ${line}`)
				.join("\n") + "\n";
		}
		return review;
	}

	async writeModelingFilesEnhanced({
		lean,
		json,
		commitSha,
	}: {
		lean: string | null;
		json: string | null;
		commitSha: string;
	}) {
		const { filePath, namespace } = this.getModelingPathInfoFromJson(json);
		const absPath = path.join(this.modelingDir, filePath);
		await fs.mkdir(path.dirname(absPath), { recursive: true });

		const metaLines = [
			"-- Modeling Agent Output",
			commitSha ? `-- Commit: ${commitSha}` : "",
			this.meta?.pullNumber ? `-- PR: #${this.meta.pullNumber}` : "",
			this.meta?.issueNumber ? `-- Issue: #${this.meta.issueNumber}` : "",
			""
		].filter(Boolean).join("\n");

		if (lean) {
			if (lean && typeof lean !== 'string') {
				console.error("❌ Invalid Lean code provided.");
			}
			const wrappedLean = `namespace ${namespace}\n\n${lean.trim()}\n\nend ${namespace}`;
			await fs.writeFile(absPath, `${metaLines}\n${wrappedLean}`, "utf-8");
			console.log(`📝 Created Lean file at ${filePath}`);
		}

		if (json) {
			try { JSON.parse(json); } catch (e) {
				console.error("❌ Invalid JSON in modeling spec.");
				return;
			}
			const jsonPath = path.join(this.modelingDir, filePath.replace(/\.lean$/, '.json'));
			await fs.writeFile(jsonPath, json, "utf-8");
			console.log(`📝 Created spec JSON at ${jsonPath}`);
		}
	}

	async updateModelingIndex({
		commitSha,
		json,
	}: {
		commitSha: string;
		json: string | null;
	}) {
		const { filePath, namespace } = this.getModelingPathInfoFromJson(json);
		const indexPath = path.join(this.modelingDir, "modeling-index.json");

		let index: Record<string, any> = {};
		try {
			const raw = await fs.readFile(indexPath, "utf-8");
			index = JSON.parse(raw);
		} catch (e) {
			console.warn("📘 Invalid or missing modeling-index.json. Rebuilding...");
			index = {};
		}

		index[namespace] = {
			path: filePath,
			namespace,
			commit: commitSha,
		};

		await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
		console.log(`✅ Updated modeling-index.json with ${namespace}`);
	}

	async writeModelingFiles(leanCodeMap: Record<string, string>) {
		const modelingDir = path.join(this.tmpDir, "modeling");
		await fs.mkdir(modelingDir, { recursive: true });

		const imports: string[] = [];

		for (const [sourceFile, lean] of Object.entries(leanCodeMap)) {
			const baseName = path.parse(sourceFile).name;
			const namespace = baseName[0].toUpperCase() + baseName.slice(1);
			const leanFile = `${namespace}.lean`;
			const leanFilePath = path.join(modelingDir, leanFile);

			const wrappedLean = `namespace ${namespace}\n${lean.trim()}\nend ${namespace}\n`;
			await fs.writeFile(leanFilePath, wrappedLean, "utf-8");
			console.log(`📝 Wrote ${leanFilePath}`);

			imports.push(`import ./${namespace}`);
		}

		const mainLeanPath = path.join(modelingDir, "Main.lean");
		const mainContent = imports.join("\n") + "\n\n" + imports.map(i => `open ${i.split("/").pop()}`).join("\n");

		await fs.writeFile(mainLeanPath, mainContent, "utf-8");
		console.log("📝 Wrote modeling/Main.lean with imports and open directives");
	}

	getModelingFilePathFromJson(json: string): { filePath: string; namespace: string } {
		try {
			const parsed = JSON.parse(json);
			let rawPath = parsed?.source || parsed?.path || '';
			let fileName = parsed?.functionName || 'UnknownFunction';

			// Normalize path (fallback if no path is given)
			if (!rawPath) {
				const safeName = fileName.replace(/[^\w]/g, '');
				const filePath = `modeling/${safeName}.lean`;
				const namespace = safeName;
				return { filePath, namespace };
			}

			// Convert source path to Lean file path and namespace
			const extIndex = rawPath.lastIndexOf('.');
			const withoutExt = extIndex >= 0 ? rawPath.slice(0, extIndex) : rawPath;
			const normalized = withoutExt.replace(/^\/+|\/+$/g, '').replace(/\.[^/.]+$/, '');
			const filePath = `modeling/${normalized}.lean`;

			const parts = normalized.split(/[\\/]/);
			const namespace = parts.map((p: string) => this.capitalize(p)).join('.');

			return { filePath, namespace };
		} catch (e) {
			console.warn("⚠️ Failed to parse JSON for modeling path. Using fallback.");
			return { filePath: `modeling/FallbackModel.lean`, namespace: "FallbackModel" };
		}
	}

	private capitalize(word: string): string {
		return word.charAt(0).toUpperCase() + word.slice(1);
	}

	extractFunctionNameFromJson(json: string | null): string {
		if (!json) return "Unknown";

		try {
			const data = JSON.parse(json);
			if (typeof data.functionName === "string") {
				return data.functionName;
			}
		} catch (e) {
			console.warn("⚠️ Could not parse JSON or extract functionName.");
		}
		return "Unknown";
	}

	async writeMainLean() {
		const indexPath = path.join(this.modelingDir, 'modeling-index.json');
		const mainLeanPath = path.join(this.modelingDir, 'Main.lean');

		try {
			const indexRaw = await fs.readFile(indexPath, 'utf-8');
			const rawIndex = JSON.parse(indexRaw) as Record<string, { namespace: string; path: string }>;
			const index = Object.values(rawIndex);

			const imports = index.map(entry => `import ${entry.namespace}`).join('\n');
			const opens = index.map(entry => `open ${entry.namespace}`).join('\n');

			const content = `-- Auto-generated by the Modeling Agent. Do not edit manually.\n\n${imports}\n\n${opens}\n`;

			await fs.writeFile(mainLeanPath, content, 'utf-8');
			console.log("✅ Main.lean regenerated from modeling-index.json");
		} catch (err) {
			console.error("❌ Failed to generate Main.lean:", err);
		}
	}

	async writeAndPushFiles(
		cloneUrl: string,
		defaultBranch: string,
		lean: string | null,
		json: string | null,
		branchName: string
	) {
		const git = simpleGit();
		await git.clone(cloneUrl, this.tmpDir);

		await fs.mkdir(this.modelingDir, { recursive: true });

		await this.writeModelingFilesEnhanced({
			lean,
			json,
			commitSha: this.meta?.commitSha ?? "",
		});

		await this.updateModelingIndex({
			commitSha: this.meta?.commitSha ?? "",
			json,
		});

		await this.writeMainLean();

		const repoGit = simpleGit({ baseDir: this.tmpDir });
		await repoGit.checkoutLocalBranch(branchName);

		// Important: ensure we're on the correct branch before status
		const status = await repoGit.status();
		const currentBranch = branchName;

		if (status.files.length > 0) {
			console.warn("🔧 Found unstaged changes before pull. Staging and committing them.");
			await repoGit.add(".");
			await repoGit.commit("chore(modeling-agent): auto-stage before rebase pull");
		}

		await repoGit.add(".");
		await repoGit.commit("feat(modeling-agent): add or update modeling artifacts");
		await repoGit.push("origin", currentBranch, ["--set-upstream"]);

		console.log("✅ Repo content added and pushed to", currentBranch);
		await new Promise(res => setTimeout(res, 2000));

		try {
			await this.octokit.rest.pulls.create({
				owner: this.targetOwner,
				repo: this.targetRepo,
				title: "Modeling: Add agent-generated Lean specs",
				head: currentBranch,
				base: defaultBranch,
				body: "This branch contains formal modeling artifacts generated by the agent. ✨ @agent codespaces ✨",
			});
			console.log("🔀 Created pull request from agent branch.");
		} catch (err) {
			console.error("❌ Failed to create pull request:", err);
		}
	}

	async applyReconciledLeanFile({
		repoPath,
		branch,
		reconciledLean,
		originalCommitSha
	}: ReconcileUpdateOptions) {
		const modelingDir = path.join(repoPath, "modeling");
		await fs.mkdir(modelingDir, { recursive: true });

		const mainLeanPath = path.join(modelingDir, "Main.lean");
		const latestPath = path.join(modelingDir, "Main.latest.lean");

		// Determine backup filename
		const backupSuffix = originalCommitSha
			? originalCommitSha
			: new Date().toISOString().replace(/[-:.]/g, "");

		const renamedPath = path.join(modelingDir, `Main.${backupSuffix}.lean`);

		let previousContent = "";
		try {
			previousContent = await fs.readFile(mainLeanPath, "utf-8");
			await fs.rename(mainLeanPath, renamedPath);
			console.log(`🔁 Renamed Main.lean to ${path.basename(renamedPath)}`);
		} catch {
			console.warn("⚠️ No existing Main.lean found to rename.");
		}

		await fs.writeFile(latestPath, reconciledLean, "utf-8");
		console.log("✅ Wrote Main.latest.lean with reconciled content.");

		// Generate diff and write REVIEW.md
		const diff = diffLines(previousContent || "", reconciledLean);
		let reviewContent = `# Modeling Agent Reconciliation\n\n`;
		reviewContent += `This diff shows changes applied by the agent to reconcile modeling logic.\n\n`;
		reviewContent += `## Lean Diff\n\n`;
		for (const part of diff) {
			const prefix = part.added ? "+" : part.removed ? "-" : " ";
			reviewContent += part.value
				.split("\n")
				.map((line) => `${prefix} ${line}`)
				.join("\n") + "\n";
		}

		// await fs.writeFile(reviewPath, reviewContent.trim(), "utf-8");
		const git = simpleGit({ baseDir: repoPath });
		await git.checkoutLocalBranch(branch).catch(async () => {
			await git.checkout(['-b', branch, `origin/${branch}`]);
		});
		await git.add("modeling/*");
		await git.commit("reconcile(modeling-agent): apply reconciled Lean output");
		await git.push("origin", branch);
		console.log("🚀 Pushed reconciled update to GitHub.");
		console.log("📁 Repo path:", repoPath);
		// Create GitHub Issue with the contents of REVIEW.md
		await this.octokit.request('POST /repos/{owner}/{repo}/issues', {
			owner: this.targetOwner,
			repo: this.targetRepo,
			title: '📘 Reconciliation Review from Modeling Agent',
			body: reviewContent,
			labels: ['modeling-agent', 'review', 'reconciliation'],
			headers: {
				'x-github-api-version': '2022-11-28'
			}
		});

		console.log("📝 Created GitHub issue with reconciliation summary.");
	}

	async ensureCleanTmpDir(tmpDir: string) {
		if (existsSync(tmpDir)) {
			await rm(tmpDir, { recursive: true, force: true });
		}
		await mkdir(tmpDir, { recursive: true });
	}

	getModelingPathInfoFromJson(json: string | null): {
		filePath: string;
		namespace: string;
	} {
		if (!json) {
			return {
				filePath: "modeling/Unknown/Unknown.lean",
				namespace: "Unknown.Unknown",
			};
		}

		try {
			const parsed = JSON.parse(json);
			if (!parsed.functionName || typeof parsed.functionName !== 'string') {
				throw new Error("Missing or invalid 'functionName' in modeling JSON.");
			}
			const rawPath = parsed.path || '';
			const functionName = parsed.functionName || 'Unknown';


			let filePath: string;
			let namespace: string;

			if (rawPath) {
				// Normalize path and strip extensions
				const pathParts = rawPath.split(/[\\/]/).filter(Boolean);
				const leanPathParts = pathParts.map((part: string) => toPascalCase(part.replace(/\.[^/.]+$/, '')));
				const filename = toPascalCase(functionName) + '.lean';

				filePath = `modeling/${leanPathParts.join('/')}/${filename}`;
				namespace = [...leanPathParts, toPascalCase(functionName)].join('.');
			} else {
				const fileName = toPascalCase(functionName);
				filePath = `modeling/${fileName}.lean`;
				namespace = fileName;
			}

			return { filePath, namespace };
		} catch (e) {
			return {
				filePath: "modeling/InvalidJson.lean",
				namespace: "InvalidJson",
			};
		}
	}
	async run() {
		const exists = await this.repoExists();
		const { lean, json } = this.extractCodeBlocks();
		if (!lean && !json) {
			console.warn("No Lean or JSON code found in comment. Nothing to do.");
			return;
		}

		let cloneUrl: string;
		let defaultBranch: string;
		const newBranch = `agent-models/${format(new Date(), "yyyy-MM-dd-HHmm")}`;

		if (!exists) {
			console.log("🚀 Creating repo from template...");
			const result = await this.createRepoFromTemplate();
			cloneUrl = result.cloneUrl;
			defaultBranch = result.defaultBranch;
			await new Promise(res => setTimeout(res, 2000)); // give GitHub time to provision
		} else {
			console.log(`⚠️ Repo ${this.targetOwner}/${this.targetRepo} already exists. Attempting recovery.`);
			cloneUrl = `https://github.com/${this.targetOwner}/${this.targetRepo}.git`;
			defaultBranch = 'main';
			const { data } = await this.octokit.rest.repos.get({
				owner: this.targetOwner,
				repo: this.targetRepo
			});
			defaultBranch = data.default_branch;
		}

		console.log("📦 Writing files and committing...");
		await this.writeAndPushFiles(cloneUrl, newBranch, lean, json, newBranch);
		console.log(`✅ Repo content added and pushed to ${newBranch}`);

		// create PR for human review
		await this.octokit.rest.pulls.create({
			owner: this.targetOwner,
			repo: this.targetRepo,
			title: "Modeling: Add agent-generated Lean specs",
			head: newBranch,
			base: defaultBranch,
			body: "This branch contains formal modeling artifacts generated by the a formal agent view ✨ @agent codespaces ✨."
		});
		console.log("🔀 Created pull request from agent branch.");
	}
}


export function toPascalCase(str: string): string {
	return str
		.replace(/[^a-zA-Z0-9]/g, ' ')
		.replace(/\s+(.)/g, (_, group1) => group1.toUpperCase())
		.replace(/^./, str[0].toUpperCase());
}

