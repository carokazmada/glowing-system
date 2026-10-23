# AGENTS.md

## What this is

`carokaz-messenger-voicebot` (repo `carokazmada/glowing-system`) is a small Node/Express service behind the Carokaz Mada Facebook Messenger voice bot. It receives Messenger voice notes and text, transcribes audio with OpenAI Whisper, answers with `gpt-4o-mini`, and replies with OpenAI TTS audio (falling back to text).

## Layout

- `server.js` — the entire application: Express app, webhook routes, OpenAI calls, Messenger Send API.
- `package.json` — ESM project (`"type": "module"`); dependencies are `express`, `dotenv`, `openai`.
- `.env.example` — the environment variables to copy into `.env`.
- `README.md` — French deployment walkthrough for Render.com (build `npm install`, start `npm start`).

There is no `src/`, no test suite, no linter or formatter config, and no CI workflow.

## Commands

```bash
npm install     # install dependencies
npm start       # node server.js — starts the webhook server
```

`start` is the only script defined in `package.json`. There is no `test`, `lint`, `build` or `format` script — do not invent or run one.

## Environment

Copy `.env.example` to `.env` and fill it in:

- `OPENAI_API_KEY` — required. The OpenAI client is constructed at module load, so the process exits immediately if it is missing or empty.
- `PAGE_ACCESS_TOKEN` — Messenger Page access token, used by the Send API.
- `VERIFY_TOKEN` — shared secret for the Meta webhook verification handshake.
- `SYSTEM_PROMPT` — optional; overrides the built-in French assistant prompt.
- `PORT` — optional, defaults to `3000`.

Never commit `.env` or real token values.

## Runtime

- `engines.node` is `>=18`, but `transcribeAudio` uses the global `File`, which exists only from Node 20 on. Run on Node 20 or newer.
- `README.md` is in French; keep user-facing messages and code comments in French to match.

## How a request flows

1. `GET /webhook` — Meta verification. Echoes `hub.challenge` when `hub.mode === 'subscribe'` and `hub.verify_token` equals `VERIFY_TOKEN`, otherwise 403.
2. `POST /webhook` — replies `200 EVENT_RECEIVED` immediately, then handles each `entry.messaging` event in the background. Audio attachments are transcribed (`whisper-1`, forced to French), plain text is used as-is, and the reply comes from a per-sender in-RAM history (`gpt-4o-mini`, last 10 turns) sent as `tts-1` audio with a text fallback.
3. `GET /` — status string used as a health check.

## Gotchas

- Conversation history is a `Map` in RAM and is lost on restart.
- `POST /webhook` does not verify the `X-Hub-Signature-256` header, so any caller can trigger OpenAI spend and Messenger sends. Treat this as a known gap.
- `main` has no `.gitignore`, so `node_modules/` and `package-lock.json` show up as untracked after `npm install`.

## Conventions

- ES modules (`import`), 2-space indentation, single quotes, semicolons.
- `camelCase` functions, `SCREAMING_SNAKE_CASE` module-level constants.
- Keep changes small and focused; the application is a single file.
