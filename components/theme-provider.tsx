"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	return (
		<NextThemesProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			storageKey="formal-mind-theme"
			disableTransitionOnChange
		>
			{children}
		</NextThemesProvider>
	);
}
