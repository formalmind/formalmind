# Webhook Viewer Component

```tsx
'use client'
import { useUser } from '@auth0/nextjs-auth0'
import useSWR from 'swr'

const fetcher = (url: string) => fetch(url).then(res => res.json())

export default function WebhookViewer() {
	const session = useUser()
	const installationId = session?.user?.installation_id

	const { data: events, isLoading } = useSWR(
		installationId ? `/api/events/${installationId}` : null,
		fetcher,
		{ refreshInterval: 3000 }
	)

	if (!installationId) return <p>❌ No GitHub App installation found for this user.</p>
	if (isLoading) return <p>⏳ Loading events…</p>

	return (
		<div className="space-y-2">
			{events?.map((e: any, i: number) => (
				<div key={i} className="border p-2 rounded bg-white shadow text-xs">
					<pre>{JSON.stringify(e, null, 2)}</pre>
				</div>
			))}
		</div>
	)
}
```
