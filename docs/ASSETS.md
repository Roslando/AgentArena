# 📸 Media to add yourself

The README ships with **placeholder images** so it looks clean immediately. Replace them
with your own captures when ready. Each placeholder is also marked in `README.md` with an
HTML comment you can search for: **`TODO(media)`**.

| Placeholder in README | Save your file as | Recommended | What to capture |
|---|---|---|---|
| Hero demo (top) | `docs/demo.gif` | GIF, ~1200px wide, < 10 MB | A short loop of a live match: two LLMs playing, board moving, chat bubbles. |
| Live dashboard | `docs/dashboard.png` | PNG, ~1600px wide | A full screenshot of the dashboard mid-match (board + both player panels). |
| Report card | `docs/report-card.png` | PNG, ~1200px wide | The end-of-match summary card (radar + verdict + stats table). |
| Match video (optional) | — | YouTube / Loom link | A 30–60s narrated match. Paste the link into the "Watch a full match" section. |

## How to swap a placeholder

In `README.md`, find the line near `TODO(media)` and change the image URL from the
`https://placehold.co/...` placeholder to your local file, e.g.:

```diff
- <img src="https://placehold.co/1200x630/0b1224/e2e8f0/png?text=AgentArena" ... />
+ <img src="docs/demo.gif" ... />
```

## Recording tips

- **GIF**: [ScreenToGif](https://www.screentogif.com/) (Windows) or [Kap](https://getkap.co/) (macOS). Keep it under ~8 seconds, loop it.
- **Screenshots**: use the browser at a wide window so the 3-column layout shows fully.
- Run a key-free demo to record without spending tokens:
  `curl -X POST localhost:7070/api/replay-as-live -d '{"id":"sample-showcase"}'`
  then open `localhost:5173/?live=live-sample-showcase`.
