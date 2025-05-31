import { NextResponse } from 'next/server'
import redis from '@/lib/redis'

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ installId: string }> }
) {
	const { installId } = await params
	const key = `github_events:install:${installId}`
	const events = await redis.lRange(key, 0, 50)
	return NextResponse.json(events.map(e => JSON.parse(e)))
}
