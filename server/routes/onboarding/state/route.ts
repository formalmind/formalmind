import { auth0 } from "@/lib/auth0";
import { getJSON, putJSON } from "@/lib/kv";
import { addProject } from "@/lib/projects";
import type { RepoPlan } from "@/lib/plan";
import type { TeamPreset } from "@/lib/teams";

/** Where a signed-in user is in onboarding; saved as they go so they can come back to it. */
export type OnboardingState = {
	repo: string | null;
	plan: RepoPlan | null;
	team: TeamPreset;
	squadSize: number;
	dailyUsd: number;
	updatedAt: string;
};

const key = (sub: string) => `onboarding:${sub}`;

export async function GET() {
	const session = await auth0.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	return Response.json(await getJSON<OnboardingState>(key(session.user.sub)));
}

export async function PUT(request: Request) {
	const session = await auth0.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const body = (await request.json()) as Partial<OnboardingState>;
	const previous = await getJSON<OnboardingState>(key(session.user.sub));
	const next: OnboardingState = {
		repo: body.repo ?? previous?.repo ?? null,
		plan: body.plan ?? previous?.plan ?? null,
		team: body.team ?? previous?.team ?? "pair",
		squadSize: Math.min(7, Math.max(4, body.squadSize ?? previous?.squadSize ?? 4)),
		dailyUsd: Math.min(100, Math.max(2, body.dailyUsd ?? previous?.dailyUsd ?? 5)),
		updatedAt: new Date().toISOString(),
	};
	await putJSON(key(session.user.sub), next);
	// A planned repository becomes one of the account's projects (a folder in the sidebar).
	if (next.repo && next.plan) await addProject(session.user.sub, next.repo);
	return Response.json(next);
}
