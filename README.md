# Vibe Coding Agent

Three-layer MVP for a vibe coding product:

- `services/agent-service`: Python `FastAPI + LangGraph + LangChain` agent runtime
- `apps/orchestrator-api`: Node `Fastify` API, project orchestration, preview runner
- `apps/playground`: React + Vite operator UI

## Quick start

1. Copy `.env.example` to `.env` or `.env.local`.
2. Configure either the generic OpenAI-compatible variables `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME`, or fill one provider-specific block such as `QWEN_*`, `OPENAI_*`, `GEMINI_*`, or `CLAUDE_*`.
3. Install JS dependencies with `npm install`.
4. Install Python dependencies inside `services/agent-service`.
5. Start everything with one command:

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

If your model provider is slow and `/agent/turn` requests time out during generation, increase `AGENT_SERVICE_TIMEOUT_MS` in your env file. The default is `420000` (7 minutes).

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
- The runtime now uses a single OpenAI-compatible adapter powered by `ChatOpenAI`.
- `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME` are the highest-priority settings and are the recommended way to switch providers.
- If `MODEL_*` is empty, the runtime falls back to the provider-specific block selected by `MODEL_PROVIDER`. When `MODEL_PROVIDER=openai_compatible`, it auto-picks the first complete block that has both an API key and a model name.
- `QWEN_*`, `OPENAI_*`, `GEMINI_*`, and `CLAUDE_*` are env presets only. They work when the target endpoint is OpenAI-compatible. Direct proprietary APIs that are not OpenAI-compatible still need a code adapter.

## Internal Module Boundaries

- `apps/playground`
  Thin operator UI. `App.tsx` drives the chat + preview surface, while `hooks/useProject.ts` owns project loading, message submission, approval flow, and SSE updates.
- `apps/orchestrator-api`
  Public HTTP boundary plus execution orchestration. `RunService` is the single run facade; `services/run/*` owns session creation, turn processing, and approval transitions. `ProposalValidator` is the preflight coordinator, while `services/preflight/*` owns static validation, autofixers, and repair context building.
- `services/agent-service`
  LLM runtime and graph execution. `strategies/base.py` is a thin adapter and graph node host, `services/verify_loop.py` owns verify/repair-or-polish decisions, `services/generation_guard.py` owns placeholder/import/materialization checks, and `app/models/` is the barrel-backed split model package that preserves `from app.models import ...`.
