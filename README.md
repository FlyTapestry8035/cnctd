# cnctd

Private session-based chat with a shared Markdown file. **Static site** — runs on GitHub Pages with no backend. Sessions are persisted as **GitHub gists**.

## How it works

- Each session is one secret gist owned by whoever creates it.
- The gist holds three kinds of files:
  - `cnctd.md` — the shared Markdown document
  - `cnctd-msg-<userId>.json` — one chat-log file per participant
  - `cnctd-presence-<userId>.json` — heartbeat for "who's here right now"
- Each browser polls the gist every 3 seconds for new messages and Markdown changes.
- Each browser writes only to **its own** message + presence files, so concurrent participants don't overwrite each other.
- The shared `cnctd.md` is debounced (1.5s) and saved last-writer-wins.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. Repo **Settings → Pages**.
3. Source: **Deploy from a branch**. Branch: `main` (or whichever branch holds these files), folder: `/ (root)`.
4. Wait ~1 minute, then open `https://<your-user>.github.io/<repo>/`.

That's it — no build step, no server.

## First-time setup (each user)

Each participant needs their own GitHub Personal Access Token with `gist` scope:

1. Go to <https://github.com/settings/tokens/new?scopes=gist&description=cnctd>
2. Generate a **classic** token (fine-grained tokens don't currently support gists).
3. Paste it into cnctd on first launch. The token is stored in your browser's localStorage and is sent only to `api.github.com`.

## Using it

1. **Create a session** — generates a new secret gist. Share the link (`...#/<gistId>`).
2. **Join a session** — paste the gist ID or full gist URL.
3. Pick a name. Chat. Edit the shared Markdown together (live preview tab).

## Limits / tradeoffs

This is a static-site design, so realtime is implemented as polling against the GitHub API — that brings real constraints:

- **Latency**: chat messages and Markdown changes appear within ~3 seconds.
- **Capacity**: realistic for small groups (~5–20 people). 2,000-person sessions are not feasible — GitHub's gist API rate limits (5,000 requests/hour per user) and per-gist contention would not sustain that. If you need true large-room scale, host the WebSocket version of this app on a server.
- **Edit conflicts**: simultaneous Markdown edits use last-writer-wins; one author's edit may be overwritten by another's during the same 1.5s window.
- **Gist size**: GitHub limits each file in a gist to ~1 MB.

## Files

- `index.html`, `styles.css`, `app.js` — the entire app
- No build, no dependencies installed (Markdown preview loads `marked` from a CDN)

## Privacy notes

- Sessions are **secret gists** — not searchable, but anyone with the URL who has the token to read it could view the contents. Don't share gist IDs with people you don't trust.
- Tokens live in your browser's localStorage. Don't run cnctd in a tab you don't trust.
