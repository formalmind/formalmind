"use client";

import { createContext, useContext } from 'react';
import { SessionData } from '@auth0/nextjs-auth0/types';

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
	session
}: {
	children: React.ReactNode
	session: SessionData
}) => {
	return (
		<AuthContext.Provider value={session}>
			{children}
		</AuthContext.Provider>
	);
}


