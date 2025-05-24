# Getting Started

First, clone this repo and run

```bash
bun install
```

## Setup

> [!TIP]
>
> ### Follow link below to setup Auth0 authentication
>
> Dependencies `npm i @auth0/nextjs-auth0`
>
> - [ ] [User authentication](https://auth0.com/ai/docs/user-authentication)

1. Copy .env file to `.env.local` and add environment variables

   ```bash
   cp example.env.local .env.local
   ```

2. Update auth0 secrets

   ```txt
   AUTH0_SECRET='use [openssl rand -hex 32] to generate a 32 bytes value'
   APP_BASE_URL='http://localhost:3000'
   AUTH0_DOMAIN=''
   AUTH0_CLIENT_ID=''
   AUTH0_CLIENT_SECRET=''
   AUTH0_M2M_CLIENT_ID=''
   AUTH0_M2M_CLIENT_SECRET=''
   NEXT_PUBLIC_PROFILE_ROUTE=/api/me
   NEXT_PUBLIC_ACCESS_TOKEN_ROUTE=/api/auth/token

   ```

3. Run the development server:

   ```bash
   bun dev
   ```
