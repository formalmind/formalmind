"use client";

import { useRef, useState } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { parseRepo, planSchema, type RepoPlan } from "@/lib/plan";

const DRAFT_KEY = "fm-onboarding-draft";
/** A visitor's landing progress is kept for three days, then the page goes back to its demo. */
export const LANDING_KEEP_MS = 3 * 24 * 3600 * 1000;

export type PlanDraft = { repo: string; plan: RepoPlan };

/** The draft a visitor made on the landing page, picked up again after they sign up. */
export function readDraft(): PlanDraft | null {
	try {
		const raw = localStorage.getItem(DRAFT_KEY);
		const draft = raw ? (JSON.parse(raw) as PlanDraft & { savedAt?: number }) : null;
		if (draft && Date.now() - (draft.savedAt ?? 0) > LANDING_KEEP_MS) {
			forgetLandingProgress();
			return null;
		}
		return draft;
	} catch {
		return null;
	}
}

/** Forgets the landing page's progress (plan and setup), so the next visit starts from the demo. */
export function forgetLandingProgress() {
	clearDraft();
	try {
		localStorage.removeItem("fm-landing-setup");
	} catch {
		// Storage refused: nothing was kept.
	}
}

export function clearDraft() {
	try {
		localStorage.removeItem(DRAFT_KEY);
	} catch {
		// Nothing stored, or storage refused: nothing to clear.
	}
}

function saveDraft(draft: PlanDraft) {
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
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
	// A plan brought back from an earlier visit; a new plan replaces it.
	const [resumed, setResumed] = useState<RepoPlan | null>(null);
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
		setResumed(null);
		setRepo(parsed);
		repoRef.current = parsed;
		submit({ repo: parsed });
	};

	/** Picks up a plan finished on an earlier visit, without planning again. */
	const resume = (draft: PlanDraft) => {
		setRepo(draft.repo);
		repoRef.current = draft.repo;
		setResumed(draft.plan);
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
		clearDraft();
		setResumed(null);
		setRepo(null);
		repoRef.current = null;
		setInputError(null);
	};

	const plan = resumed ?? object;
	return { repo, plan, start, stop, reset, resume, isLoading, error: message, done: Boolean(repo && plan && !isLoading && !error) };
}
