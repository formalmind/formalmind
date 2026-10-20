import { useEffect, useSyncExternalStore } from "react";
import type { Message } from "ai";
import type { Project } from "@/lib/projects";

export type { Project };

/* ── Projects: read once from the Worker, shared by the sidebar and the pages ── */

let projects: Project[] | null = null;
let loading: Promise<void> | null = null;
const projectListeners = new Set<() => void>();

function loadProjects(force = false) {
	if (loading && !force) return loading;
	loading = fetch("/api/projects")
		.then((res) => (res.ok ? res.json() : { projects: [] }))
		.then((body: { projects: Project[] }) => {
			projects = body.projects;
			projectListeners.forEach((fn) => fn());
		})
		.catch(() => {
			projects = projects ?? [];
			projectListeners.forEach((fn) => fn());
		});
	return loading;
}

/** Re-reads the list, e.g. after onboarding saves a plan and the repository becomes a project. */
export const refreshProjects = () => void loadProjects(true);

/** The account's projects; null until the first answer arrives. */
export function useProjects(): Project[] | null {
	useEffect(() => void loadProjects(), []);
	return useSyncExternalStore(
		(fn) => {
			projectListeners.add(fn);
			return () => projectListeners.delete(fn);
		},
		() => projects,
	);
}

/** "owner/name" from route params. */
export const repoOf = (owner?: string, name?: string) => (owner && name ? `${owner}/${name}` : null);
export const projectPath = (repo: string, page = "") => `/projects/${repo}${page ? `/${page}` : ""}`;

/* ── Chats: each project's swarm chats, kept in this browser ── */

export type ProjectChat = { id: string; title: string; messages: Message[]; updatedAt: number };

const CHATS_KEY = "fm-project-chats";
const chatListeners = new Set<() => void>();
let chats: Record<string, ProjectChat[]> | null = null;

function readChats(): Record<string, ProjectChat[]> {
	if (chats) return chats;
	try {
		chats = JSON.parse(localStorage.getItem(CHATS_KEY) ?? "{}");
	} catch {
		chats = {};
	}
	return chats ?? {};
}

function writeChats(next: Record<string, ProjectChat[]>) {
	chats = next;
	try {
		localStorage.setItem(CHATS_KEY, JSON.stringify(next));
	} catch {
		// Storage refused (private window): the chats last until the tab closes.
	}
	chatListeners.forEach((fn) => fn());
}

export function useProjectChats(repo: string): ProjectChat[] {
	const all = useSyncExternalStore(
		(fn) => {
			chatListeners.add(fn);
			return () => chatListeners.delete(fn);
		},
		readChats,
	);
	return all[repo] ?? [];
}

export function getProjectChat(repo: string, id: string): ProjectChat | undefined {
	return readChats()[repo]?.find((c) => c.id === id);
}

/** Saves a chat's messages; the first question becomes its title. Newest chats come first. */
export function saveProjectChat(repo: string, id: string, messages: Message[]) {
	if (messages.length === 0) return;
	const all = readChats();
	const list = all[repo] ?? [];
	const first = messages.find((m) => m.role === "user")?.content ?? "New chat";
	const title = first.replace(/\s+/g, " ").trim().slice(0, 80) || "New chat";
	const existing = list.find((c) => c.id === id);
	const chat: ProjectChat = { id, title: existing?.title ?? title, messages, updatedAt: Date.now() };
	writeChats({ ...all, [repo]: [chat, ...list.filter((c) => c.id !== id)] });
}

export const newChatId = () => crypto.randomUUID().slice(0, 8);

/* Chats whose agent is answering right now, as "repo:id". Memory only: a reload ends every reply anyway. */
const working = new Set<string>();
let workingSnapshot: ReadonlySet<string> = new Set();
const workingListeners = new Set<() => void>();

/** Marks a chat as working (its reply is streaming) or idle; the sidebar shows a dot on working chats. */
export function setChatWorking(repo: string, id: string, on: boolean) {
	const key = `${repo}:${id}`;
	if (working.has(key) === on) return;
	if (on) working.add(key);
	else working.delete(key);
	workingSnapshot = new Set(working);
	workingListeners.forEach((fn) => fn());
}

/** The "repo:id" keys of chats whose agent is working. */
export function useWorkingChats(): ReadonlySet<string> {
	return useSyncExternalStore(
		(fn) => {
			workingListeners.add(fn);
			return () => workingListeners.delete(fn);
		},
		() => workingSnapshot,
		() => workingSnapshot,
	);
}
