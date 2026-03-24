# Vibe Coding Agent

Three-layer MVP for a vibe coding product:

- `services/agent-service`: Python `FastAPI + LangGraph + LangChain` agent runtime
- `apps/orchestrator-api`: Node `Fastify` API, project orchestration, preview runner
- `apps/playground`: React + Vite operator UI

## Quick start

1. Copy `.env.example` to `.env` and fill in `QWEN_API_KEY` or `DASHSCOPE_API_KEY`.
2. Install JS dependencies with `npm install`.
3. Install Python dependencies inside `services/agent-service`.
4. Start everything with one command:

```bash
npm run dev:all
```

If you also want the Python agent to auto-reload on file changes, run:

```bash
DEV_ALL_RELOAD=1 npm run dev:all
```

If port `4000` is already used by another local service, set both `ORCHESTRATOR_PORT` and `VITE_API_BASE` in your env file so the playground talks to the correct API. Example:

```bash
ORCHESTRATOR_PORT=4102
VITE_API_BASE=http://127.0.0.1:4102
```

If your model provider is slow and `/agent/turn` requests time out during generation, increase `AGENT_SERVICE_TIMEOUT_MS` in your env file. The default is `300000` (5 minutes).

Or start the agent service, API, and playground separately:

```bash
npm run dev:agent
npm run dev:api
npm run dev:playground
```

## Notes

- The runner prefers Docker when available and falls back to a local process runner when `docker` is not installed.
- PostgreSQL is supported through `DATABASE_URL`; the API falls back to an in-memory store for local development.
- The agent uses `Plan-and-Solve` by default and exposes a `ReAct` strategy switch through the same session API.
- Code generation is Qwen-only. If the Qwen API key is missing or the API request fails, the agent returns a generation failure instead of falling back to a fixed template.
