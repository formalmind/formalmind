import { NextResponse } from "next/server"
import { auth0 } from "@/lib/auth0"
import { findInstallationForUser } from "@/lib/octokit"

export async function GET() {
	const session = await auth0.getSession()
	if (!session?.user) {
		return NextResponse.json({ installed: false }, { status: 401 })
	}

	if (!session.user.nickname) {
		return NextResponse.json({ installed: false }, { status: 400 })
	}
	const installationId = await findInstallationForUser(session.user.nickname)

	return NextResponse.json({ installed: !!installationId, installationId })
}


