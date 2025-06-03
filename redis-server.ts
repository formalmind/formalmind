import express, { Request, Response } from 'express'
import bodyParser from 'body-parser'
import { createClient } from 'redis'

const app = express()
app.use(bodyParser.json())

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
console.log('Connecting to Redis at:', REDIS_URL)

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
	await redis.lPush(key, JSON.stringify(event))
	res.status(200).send('ok')
})

app.listen(3003, () => {
	console.log('Listening on port 3003...')
})
