# Vibe Coding Agent

Local React/Vite app generator built around a TypeScript session-level agent runtime.

## Architecture

- `packages/agent-runtime`: QueryEngine, tool registry, sandbox workspace, context manager, expert routing, model adapter.
- `packages/contracts`: shared v3 project/run/candidate/tool/task contracts.
- `apps/orchestrator-api`: Fastify API, run orchestration, candidate approval, preview runner, store.
- `apps/playground`: React operator UI for chat, structured input, tool traces, candidate diff, preview, approval.
- `services/agent-service`: legacy Python runtime retained for reference; it is no longer on the default path.

The main flow is:

```text
intake -> context -> clarify_or_plan -> tool_loop -> sandbox_verify -> repair_loop -> approval -> promote -> preview -> report
```

The agent writes and executes only inside a per-run sandbox. The canonical project workspace is updated only after candidate approval.

## Quick Start

1. Copy `.env.example` to `.env.local`.
2. Configure `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME`, or use one provider-specific block such as `QWEN_*`, `DEEPSEEK_*`, or `OPENAI_*`.
3. Install dependencies:

```bash
npm install
```

4. Start the API and playground:

```bash
npm run dev:all
```

Open the playground at the printed Vite URL.

## API

- `POST /projects`
- `GET /projects/:id`
- `POST /projects/:id/runs`
- `POST /runs/:id/input`
- `POST /runs/:id/approve`
- `POST /runs/:id/cancel`
- `GET /runs/:id`
- `GET /runs/:id/diff`
- `GET /projects/:id/stream`

Compatibility aliases still exist for the playground and smoke scripts:

- `POST /projects/:id/messages`
- `POST /projects/:id/confirm`

## Notes

- The TypeScript runtime uses an OpenAI-compatible chat completions endpoint when configured.
- If no model is configured, it falls back to a deterministic local generator so the sandbox/runtime path remains testable.
- `npm install` and `npm run build` happen in the run sandbox before approval.
- After approval, the sandbox snapshot is promoted to the project workspace and a published preview is started.
