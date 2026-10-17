import express, { Request, Response } from 'express'
import bodyParser from 'body-parser'
import { createClient } from 'redis'

const app = express()
app.use(bodyParser.json({
	verify(req, _res, buffer) {
		(req as Request & { rawdata?: string }).rawdata = buffer.toString('utf8')
	},
}))

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
console.log('Connecting to Redis')

const redis = createClient({ url: REDIS_URL })

redis.on('error', (err) => console.error('Redis error:', err))

await redis.connect()

interface GitHubWebhookEvent {
	installation?: {
		id: number
	}
	[key: string]: any
}

app.post('/webhook', async (req: Request, res: Response) => {
	const event = req.body as GitHubWebhookEvent
	const installId = event.installation?.id ?? 'unknown'
	const key = `github_events:install:${installId}`
	const payload = {
		headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? ''])),
		body: event,
		rawdata: (req as Request & { rawdata?: string }).rawdata ?? JSON.stringify(event),
		timestamp: Date.now(),
	}
	await redis.multi()
		.lPush(key, JSON.stringify(event))
		.publish('webhooks', JSON.stringify({ channel: 'default', payload }))
		.exec()
	res.status(200).send('ok')
})

app.listen(3003, process.env.WEBHOOK_HOST || '127.0.0.1', () => {
	console.log('Listening on port 3003...')
})
