"use client";

import React from 'react';
import { usePathname } from 'next/navigation'
import { useMemo } from 'react'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export default function BreadCrumbs() {
	const pathname = usePathname()

	const breadcrumbs = useMemo(() => {
		const segments = pathname
			.split('/')
			.filter(Boolean)

		return segments.map((segment, index) => {
			const href = '/' + segments.slice(0, index + 1).join('/')
			return {
				label: segment
					.replace(/-/g, ' ')
					.replace(/\b\w/g, (c) => c.toUpperCase()), // Capitalize words
				href,
			}
		})
	}, [pathname])

	return (

		<>
			<Breadcrumb>
				<BreadcrumbList className="flex items-center gap-1">
					<>
						<Breadcrumb>
							<BreadcrumbList className="flex items-center gap-1">
								{breadcrumbs.map((crumb, i) => (
									<React.Fragment key={crumb.href}>
										<BreadcrumbItem className="inline-flex items-center">
											{i === breadcrumbs.length - 1 ? (
												<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
											) : (
												<BreadcrumbLink href={crumb.href}>{crumb.label}</BreadcrumbLink>
											)}
										</BreadcrumbItem>

										{/* Separator must be outside of <BreadcrumbItem> */}
										{i < breadcrumbs.length - 1 && (
											<BreadcrumbSeparator className="hidden md:block" />
										)}
									</React.Fragment>
								))}
							</BreadcrumbList>
						</Breadcrumb>
					</>
				</BreadcrumbList>
			</Breadcrumb >
		</>
	);
}
