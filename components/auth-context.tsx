"use client";

import { createContext, useContext } from 'react';
import type { SessionData } from '@/lib/session';

const AuthContext = createContext<SessionData | null>(null);

export const useAuth = () => {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error('useAuth must be used within an AuthProvider');
	}
	return context;
}

export const AuthProvider = ({
	children,
	value
}: {
	children: React.ReactNode
	value: SessionData;
}) => {
	return (
		<AuthContext.Provider value={value}>
			{children}
		</AuthContext.Provider>
	);
}


