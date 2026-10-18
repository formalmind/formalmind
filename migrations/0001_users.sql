-- Everyone who has signed in. `sub` is "github|<GitHub user id>", the id Auth0 used, so earlier data still matches.
CREATE TABLE IF NOT EXISTS users (
	sub TEXT PRIMARY KEY,
	github_id INTEGER NOT NULL UNIQUE,
	login TEXT NOT NULL,
	name TEXT,
	email TEXT,
	avatar_url TEXT,
	created_at TEXT NOT NULL,
	last_login_at TEXT NOT NULL
);
