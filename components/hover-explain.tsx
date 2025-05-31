'use client'

import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function HoverExplain({ term }: { term: string }) {
	const [text, setText] = useState('Loading...')

	useEffect(() => {
		fetch(`/api/tooltip?term=${encodeURIComponent(term)}`)
			.then(res => res.json())
			.then(data => setText(data.tooltip || 'No info found.'))
	}, [term])

	return (
		<Tooltip>
			<TooltipTrigger className="underline decoration-dotted cursor-help text-blue-600">
				{term}
			</TooltipTrigger>
			<TooltipContent className="max-w-sm text-xs bg-muted text-foreground">
				{text}
			</TooltipContent>
		</Tooltip>
	)
}
