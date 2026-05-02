# cnctd

Private session-based chat with a shared Markdown file.

- Create a session, share the key
- Up to 2,000 people per session
- Chat in real time
- Edit a shared `.md` document together (live preview)

## Run

```bash
npm install
npm start
```

Then open http://localhost:3000

Set `PORT` env var to change the port.

## How it works

- Node `http` server serves static files and a tiny REST API.
- A single in-memory `Map` of sessions holds users, messages, and the current Markdown content.
- Real-time traffic flows over WebSocket (`ws` library) at `/ws?session=<id>&name=<name>`.
- Markdown edits are debounced client-side and broadcast as last-writer-wins snapshots.
- Sessions are pruned 24h after the last user leaves.

## Limits

- 2,000 users per session
- 4,000 chars per message (last 500 messages retained, last 100 sent on join)
- 200,000 chars per Markdown document
