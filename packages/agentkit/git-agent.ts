import type { PromiseFsClient } from 'isomorphic-git'
import git, { HttpClient } from 'isomorphic-git'
import pgp from "@isomorphic-git/pgp-plugin"
import http from 'isomorphic-git/http/web'
import LightningFS from '@isomorphic-git/lightning-fs'
import { SessionData } from '@auth0/nextjs-auth0/types'
import { Octokit } from '@octokit/rest'

export interface GitAgentOptions {
	owner: string
	repo: string
	session: SessionData
}

interface CreateRepoFromTemplateOptions {
	templateOwner: string
	templateRepo: string
	newRepoName: string
	newRepoOwner: string
	isPrivate?: boolean
	description?: string
}

export interface Author {
	name: string
	email: string
}

/**
	* NOTE: This code is designed to be used in a browser environment.
	* GitAgent class for managing git operations in a browser environment.
 * It uses isomorphic - git to perform git operations like cloning, fetching commit history,
 * and signing commits with PGP (WIP).
 */
export class GitAgent {
	private fs: PromiseFsClient
	private http: HttpClient
	private dir: string
	private session: SessionData
	private url: string
	private octokit: Octokit
	private templateOwner: string
	private templateRepo: string
	private username: string
	private repo: string;

	constructor({ owner, repo, session }: GitAgentOptions) {
		this.fs = new LightningFS('fs')
		this.http = http
		this.dir = `/${owner}/${repo}`
		this.url = `https://github.com/${owner}/${repo}.git`
		this.session = session
		this.templateOwner = "formalmind";
		this.templateRepo = "lean-template";
		this.octokit = new Octokit({ auth: session.tokenSet.accessToken });
		this.username = session.user.nickname!
		this.repo = repo;
	}

	/**
	* NOTE: inbrowser only
	* Initializes the GitAgent by checking if the repository exists and cloning it if necessary.
	* This method is designed to be used in a browser environment.
	*/
	async cloneRepoInBrowser(): Promise<void> {
		const exists = await this.fs.promises.readdir(this.dir);
		if (exists) {
			console.log(`Repository already exists at ${this.dir}. Skipping clone.`)
		} else {
			await this.fs.promises.mkdir(this.dir, { recursive: true })
		}
		const isDirEmpty = (await this.fs.promises.readdir(this.dir)).length === 0;
		console.log(`Directory ${this.dir} is empty: ${isDirEmpty}`);
		if (!isDirEmpty) {
			console.log(`Directory ${this.dir} is not empty. Skipping clone.`)
			return;
		}
		await git.clone({
			fs: this.fs,
			http: this.http,
			dir: this.dir,
			url: this.url,
			corsProxy: 'https://cors.isomorphic-git.org',
		}).then(console.log)
	}

	/**
	 * NOTE: This method is designed to clone a repository from a template.
	 * Clones a repository from GitHub using the provided owner and repo name template.
	 * @param owner The owner of the repository.
	 * @param repo The name of the repository.
	 * @return A promise that resolves when the repository is cloned.
	 */
	async cloneRepoFromTemplate({
		isPrivate = true,
	}: CreateRepoFromTemplateOptions): Promise<string> {
		const result = await this.octokit.repos.createUsingTemplate({
			template_owner: this.templateOwner,
			template_repo: this.templateRepo,
			name: `${this.repo}-verifier`,
			owner: this.username,
			private: isPrivate,
			description: `Lean 4 verification repo from template for ${this.username}/${this.repo}`,
		})

		console.log(`✅ Repo created at ${result.data.html_url}`)
		return result.data.clone_url // or .ssh_url
	}

	/**
	* NOTE: inbrowser only
	* Fetches the commit history of the repository.
	* This method is designed to be used in a browser environment.
	* returns A promise that resolves when the commit history is fetched.
	*/
	async fetchCommitHistoryInBrowser() {
		return await git.log({
			fs: this.fs,
			dir: this.dir,
			depth: 50,
			ref: 'main',
		}).then(console.log);
	}
	async getRemoteInfo(): Promise<void> {
		return await git.getRemoteInfo({
			http,
			url: this.url,
			corsProxy: 'https://cors.isomorphic-git.org',
		})
			.then(console.log)
			.catch(console.error)
	}

	/**
	* NOTE: This method is designed to be used in a browser environment.
	* Signs and commits a message to the repository.
	* @param message The commit message.
	* @param author The author of the commit.
	* @param secretKey The PGP secret key used for signing the commit.
	* @returns A promise that resolves to the commit SHA.
	*/
	async signAndCommit({
		message,
		author,
		secretKey
	}: {
		message: string
		author: Author
		secretKey: string
	}): Promise<string> {
		return git.commit({
			fs: this.fs,
			dir: this.dir,
			message,
			author,
			onSign: async ({ payload }) => {
				const result = await pgp.sign({ payload, secretKey })
				return { signature: result.signature }
			}
		})
	}
}
