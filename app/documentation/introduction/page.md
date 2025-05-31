# Getting Started

First, clone this repo and run

```sh
bun install
```

Project stack:

- Github app - wehooks /api/github/webhook
- Auth0 - Gen AI auth
- Redis - real time event
- LLMs

## Setup

1. Copy .env file to `.env.local` and add environment variables

   ```sh
   cp example.env.local .env.local
   ```

2. Update auth0 secrets

   ```txt
   # auth0
   AUTH0_SECRET='use [openssl rand -hex 32] to generate a 32 bytes value'
   APP_BASE_URL=http://localhost:3000
   AUTH0_DOMAIN=
   AUTH0_CLIENT_ID=
   AUTH0_CLIENT_SECRET=
   AUTH0_M2M_CLIENT_ID=
   AUTH0_M2M_CLIENT_SECRET=

   # llms api
   OPENAI_API_KEY=
   LAMBDA_BASE_URL=https://api.lambda.ai/v1
   LAMBDA_API_KEY=
   GROQ_BASE_URL=https://api.groq.com/openai/v1
   GROQ_API_KEY=
   HF_TOKEN=


   # github app
   GITHUB_APP_ID=
   GITHUB_WEBHOOK_SECRET=
   GITHUB_APP_PRIVATE_KEY=

   # redis
   REDIS_URL=redis://localhost:6379
   REDIS_PASSWORD=
   WEBHOOK_URL=http://localhost:3000/api/github/webhook
   ```

> [!TIP]
>
> ### Auth0 setup authentication
>
> Dependencies `npm i @auth0/nextjs-auth0`
>
> - [ ] [User authentication](https://auth0.com/ai/docs/user-authentication)

3. Run the development server:

   ```sh
   bun dev
   ```

## Using redis server for github events

Run locally on docker:

```sh
docker compose up -d
```



## 1. Webhook Flow (GitHub → Smee.io → Your App)

```ts
// backend/api/github/webhook.ts
import { createNodeMiddleware } from "@octokit/webhooks";
import { App } from "octokit";
import http from "http";

const app = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET! }
});

const middleware = createNodeMiddleware(app.webhooks);

http.createServer(middleware).listen(3003);
```

And if you're using Smee:

```bash
npx smee -u https://smee.io/your-channel-id -p 3003
```

Now every GitHub event is available to your backend.

## 2. Relay GitHub Events to the Frontend (SSE or WebSockets)

Use **Server-Sent Events** (SSE) for simplicity, especially if you're mostly broadcasting modeling agent events.

```ts
// backend/api/stream.ts
import { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(() => {
    send({ type: "ping", time: new Date().toISOString() });
  }, 10000);

  // Add this to listen to Redis or a pub-sub broker for real events
  // redisClient.subscribe('modeling-updates')

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
}
```

Then your frontend listens:

```ts
const eventSource = new EventSource("/api/stream");
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("New modeling event:", data);
};
```

## 3. Integrating Grok/Hugging Face/Lambda

**Design a plugin interface**. Here's a pattern:

```ts
type AgentPlugin = {
  name: string;
  handle: (input: string, context: any) => Promise<string>;
};

const HuggingFacePlugin: AgentPlugin = {
  name: "HuggingFace",
  handle: async (input, ctx) => {
    const res = await fetch("https://api-inference.huggingface.co/models/my-model", {
      headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
      method: "POST",
      body: JSON.stringify({ inputs: input }),
    });
    const data = await res.json();
    return data.generated_text;
  }
};
```

You could even pass the plugin into your modeling agent:

```ts
await modelingAgent.run({ plugins: [HuggingFacePlugin, LambdaPlugin] });
```

## 4. Frontend Chat Integration

Use a local message state in your chat UI that updates with each event:

```tsx
const [messages, setMessages] = useState<Message[]>([]);

useEffect(() => {
  const sse = new EventSource("/api/stream");
  sse.onmessage = (event) => {
    const data = JSON.parse(event.data);
    setMessages(prev => [...prev, { text: data.summary, sender: "agent" }]);
  };
  return () => sse.close();
}, []);
```
