<div align="center">

<img src="docs/logo.svg" alt="AgentArena" width="92" height="92" />

# AgentArena

### Make LLMs **compete at games** — and measure how well they actually *act*.

Tool use, long-horizon coherence, and following the rules — not trivia.
A game-agnostic orchestrator pits any LLM against a game over the **Model Context Protocol**,
and a live dashboard broadcasts every match.

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat&logo=typescript&logoColor=white" />
  <img alt="Bun" src="https://img.shields.io/badge/Bun-runtime-14151A?style=flat&logo=bun&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-20232A?style=flat&logo=react&logoColor=61DAFB" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-Model_Context_Protocol-6E56CF?style=flat" />
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-22C55E?style=flat" />
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-2563EB?style=flat" />
</p>

<!-- TODO(media): replace the placeholder URL below with your own loop → docs/demo.gif  (see docs/ASSETS.md) -->
<img src="https://placehold.co/1200x630/0b1224/e2e8f0/png?text=Live+match+demo" alt="AgentArena live match demo" width="760" />

</div>

---

## What is this?

**AgentArena** turns a game into a benchmark for *agentic* ability. Instead of asking a model
trivia, it drops the model into a live game it can only play through **tools** — then watches
whether it can read the state, plan, stay coherent over dozens of turns, and obey the rules.

> **Agent = Model + Harness.** AgentArena is the harness: it handles the LLM connection, the
> tool loop, token & cost accounting, timers, an immutable log, and the broadcast — so a model
> is judged on how it *acts*, not what it memorized.

The orchestrator and the games are **fully decoupled**: they only ever talk over MCP. The
engine never imports a game — it discovers a game's tools and prompt at connection time.

## Highlights

- 🎮 **Game-agnostic core** — the engine speaks pure MCP. Adding a game is a new folder, **zero engine changes**.
- 🔌 **Multi-provider** — Anthropic, OpenAI, Google, and local Ollama behind one interface.
- 📊 **Measures skill, not trivia** — tool use, long-horizon coherence, and **illegal-move rate** as a first-class metric.
- 🔁 **Live === Replay** — one pure reducer over an immutable JSONL log drives the live broadcast *and* the scrubbable replay, **bit-for-bit identical**.
- 💸 **Real-time cost & tokens** — `$` per model accrues live from token usage.
- 🧾 **Shareable report card** — a hand-rolled radar + auto verdict (*"X wins by checkmate — but cost 12× more"*).
- ⚡ **One command** — `bun run start` boots the server, the dashboard, and the match, then opens your browser.
- 🛡️ **Fail-fast preflight** — validates keys and MCP tools **before** spending a single token.

## Demo

<!-- TODO(media): replace the placeholder URL with a real screenshot → docs/dashboard.png  (see docs/ASSETS.md) -->
<p align="center">
  <img src="https://placehold.co/1600x900/0b1224/e2e8f0/png?text=Live+dashboard" alt="Live dashboard" width="780" />
</p>

<table>
<tr>
<td width="50%" valign="top">

**End-of-match report card**

<!-- TODO(media): replace the placeholder URL with a real screenshot → docs/report-card.png -->
<img src="https://placehold.co/900x1000/F7F6F2/0b1224/png?text=Report+card" alt="Report card" />

</td>
<td width="50%" valign="top">

**Watch a full match**

<!-- TODO(media): paste your YouTube/Loom link on the line below -->
> ▶️ **[Watch a narrated match (coming soon)](#)**

A 30–60s replay showing two models trading tactics, an illegal move getting penalized, and the final verdict.

</td>
</tr>
</table>

## Architecture

The agent side and the game side are decoupled — they communicate **only over MCP (stdio)**.
The immutable log is the single source of truth for both the live feed and replay.

```mermaid
flowchart LR
    subgraph P["LLM Providers"]
        direction TB
        P1[Anthropic]
        P2[OpenAI]
        P3[Google]
        P4[Ollama]
    end

    subgraph ENG["Orchestrator (game-agnostic)"]
        direction TB
        R[Match Runner]
        M[MCP Client]
        L[(Immutable JSONL log)]
    end

    subgraph G["MCP Game Servers"]
        direction TB
        G1[chess]
        G2[your game ...]
    end

    subgraph UI["Broadcast"]
        direction TB
        WS[WebSocket Server]
        D[React Dashboard]
    end

    P -- "prompt / tool calls" --> R
    R --> M
    M -- "MCP via stdio" --> G
    R --> L
    L -- "live" --> WS --> D
    L -- "replay" --> D

    classDef prov fill:#1e293b,stroke:#3b82f6,color:#e2e8f0;
    classDef eng fill:#0b1224,stroke:#2563eb,color:#e2e8f0;
    classDef game fill:#13241b,stroke:#22c55e,color:#e2e8f0;
    classDef ui fill:#1e1b2e,stroke:#a855f7,color:#e2e8f0;
    class P1,P2,P3,P4 prov;
    class R,M,L eng;
    class G1,G2 game;
    class WS,D ui;
```

<details>
<summary><b>Anatomy of a single turn</b></summary>

```mermaid
sequenceDiagram
    autonumber
    participant L as LLM (current player)
    participant E as Orchestrator
    participant G as MCP Game Server
    E->>G: get_state
    G-->>E: board, faults, time left
    E->>L: system prompt + state + recent notes
    L-->>E: reasoning + make_move
    E->>G: make_move
    alt legal move
        G-->>E: accepted (game over?)
    else illegal move
        G-->>E: rejected, fault, re-prompt
    end
    E->>E: append to log, broadcast (live + replay)
```

</details>

## Quick start

> Requires [Bun](https://bun.sh).

```bash
bun install                                              # 1. install
cp .env.example .env                                     # 2. add the API keys you use
cp agentarena.config.example.json agentarena.config.json # 3. set up your match
bun run build                                            # 4. build (incl. the dashboard)
bun run start                                            # 5. boots everything, opens your browser
```

`bun run start` loads **`agentarena.config.json`** from the project root (or pass a path).
The example config documents every field and marks what's optional.
It serves the dashboard and the API on a single port (`:7070`), runs the match **live**, and
opens `http://localhost:7070/?live=<matchId>`. Press `Ctrl+C` to stop.

API keys are read from the **environment** (Bun auto-loads `.env`) — they never live in a
config you might commit:

```dotenv
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
```

<details>
<summary>Other ways to run</summary>

```bash
# Headless (CI) — run a match, print JSON, no server, no browser
bun run start --headless packages/games/chess/example-match.json

# Develop the dashboard with hot reload (two ports)
bun run --filter=@agentarena/server dev   # API + WebSocket (:7070)
bun run --filter=@agentarena/web dev       # dashboard      (:5173)

# Key-free demo: replay a saved log AS live
curl -X POST localhost:7070/api/replay-as-live -d '{"id":"sample-showcase"}'
# then open localhost:5173/?live=live-sample-showcase
```

</details>

## Supported providers

<p align="center">
  <img src="packages/web/public/logos/anthropic.svg" alt="Anthropic" height="34" />&nbsp;&nbsp;&nbsp;
  <img src="packages/web/public/logos/openai.svg" alt="OpenAI" height="34" />&nbsp;&nbsp;&nbsp;
  <img src="packages/web/public/logos/gemini.svg" alt="Google Gemini" height="34" />&nbsp;&nbsp;&nbsp;
  <img src="packages/web/public/logos/ollama.svg" alt="Ollama" height="34" />
</p>

## Add your own game

A game is a **standalone MCP server** — it can be written in any language that speaks MCP.
The engine, CLI, and types need **no changes**.

1. Create `packages/games/<your-game>/` with an MCP server exposing a **state tool** and one or
   more **action tools**.
2. Point a config at it and run `bun run start your-match.json`.

Full contract and a walkthrough: **[packages/games/README.md](packages/games/README.md)**.

## Project structure

```
packages/
├─ types/    Shared Zod schemas & types (config, log events)
├─ engine/   Orchestrator: match runner, MCP client, LLM providers, logging
├─ cli/      agentarena — one command boots the whole stack
├─ server/   WebSocket broadcast + serves the built dashboard (single port)
├─ web/      React + Vite dashboard (live + replay)
└─ games/    MCP game servers — one folder per game
   └─ chess/ Reference game (chess.js under the hood)
```

## Tech stack

**TypeScript** · **Bun** (runtime + workspaces) · **@modelcontextprotocol/sdk** · **Zod** (runtime validation) · **React 19 + Vite + Tailwind** · **Vitest** · **Biome**

## Roadmap

- [ ] Elo ranking across many matches (a single match is a duel, not a leaderboard)
- [ ] More reference games beyond chess
- [ ] SSE transport for remote MCP game servers
- [ ] Graceful MCP reconnection
- [ ] Match-runner integration tests (mock MCP + providers)

## License

Released under the **MIT License** — see [`LICENSE`](LICENSE).
