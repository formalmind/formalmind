import { tooltipCache } from '@/lib/tooltip-cache'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
	const term = req.nextUrl.searchParams.get('term')?.toLowerCase()

	if (!term) return NextResponse.json({ tooltip: "No term provided." }, { status: 400 })

	if (tooltipCache[term]) {
		return NextResponse.json({ tooltip: tooltipCache[term] })
	}

	// Optional: Fetch from OpenAI or similar
	const aiTooltip = `Sorry, I don't know what "${term}" means… yet.`
	return NextResponse.json({ tooltip: aiTooltip })
}
