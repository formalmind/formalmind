import { tooltipCache } from '@/lib/tooltip-cache'

export async function GET(req: Request) {
	const term = new URL(req.url).searchParams.get('term')?.toLowerCase()

	if (!term) return Response.json({ tooltip: "No term provided." }, { status: 400 })

	if (tooltipCache[term]) {
		return Response.json({ tooltip: tooltipCache[term] })
	}

	// Optional: Fetch from OpenAI or similar
	const aiTooltip = `Sorry, I don't know what "${term}" means… yet.`
	return Response.json({ tooltip: aiTooltip })
}
