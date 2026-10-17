"use client";

import { useRef, useState } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { parseRepo, planSchema, type RepoPlan } from "@/lib/plan";

const DRAFT_KEY = "fm-onboarding-draft";

export type PlanDraft = { repo: string; plan: RepoPlan };

/** The draft a visitor made on the landing page, picked up again after they sign up. */
export function readDraft(): PlanDraft | null {
	try {
		const raw = localStorage.getItem(DRAFT_KEY);
		return raw ? (JSON.parse(raw) as PlanDraft) : null;
	} catch {
		return null;
	}
}

function saveDraft(draft: PlanDraft) {
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
	} catch {
		// Private windows can refuse storage; the plan is also saved after sign-up.
	}
}

/** Streams a plan for a repository from /api/onboarding/plan and keeps the result as a draft. */
export function usePlan(onDone?: (draft: PlanDraft) => void) {
	const [repo, setRepo] = useState<string | null>(null);
	// onFinish can run with the render it was created in; read the repo from a ref instead.
	const repoRef = useRef<string | null>(null);
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;
	const [inputError, setInputError] = useState<string | null>(null);
	const { object, submit, isLoading, error, stop } = useObject({
		api: "/api/onboarding/plan",
		schema: planSchema,
		onFinish: ({ object: plan }) => {
			const planned = repoRef.current;
			if (plan && planned) {
				saveDraft({ repo: planned, plan });
				onDoneRef.current?.({ repo: planned, plan });
			}
		},
	});

	const start = (input: string) => {
		const parsed = parseRepo(input);
		if (!parsed) {
			setInputError("Enter a GitHub repository, like owner/name or its URL.");
			return;
		}
		setInputError(null);
		setRepo(parsed);
		repoRef.current = parsed;
		submit({ repo: parsed });
	};

	// The route answers errors as JSON; show its message rather than the raw body.
	let message = inputError;
	if (!message && error) {
		try {
			message = (JSON.parse(error.message) as { error?: string }).error ?? null;
		} catch {
			message = null;
		}
		message ??= "The planner stopped early. Try again in a moment.";
	}

	/** Back to no repository: stops a plan in flight and unlocks the repository box. */
	const reset = () => {
		stop();
		setRepo(null);
		repoRef.current = null;
		setInputError(null);
	};

	return { repo, plan: object, start, stop, reset, isLoading, error: message, done: Boolean(repo && object && !isLoading && !error) };
}
