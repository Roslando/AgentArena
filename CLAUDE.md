# CLAUDE.md

> The engineering bar I hold my AI pair-programmer to on **AgentArena** — and myself.
> Production code here is **deliberate, minimal, and verified before it ships**. This file is the
> contract; the sections below are non-negotiable unless I say otherwise in a task.

---

## ⛔ Critical rules (read first, every task)

1. **No dead code, ever.** Replacing an approach means deleting the old one in the *same* change —
   never "clean up later." After any edit, sweep the blast radius: orphaned imports, types, helpers,
   unreachable branches. Verify with grep + `bun run lint` + `bun run build`. (→ §4)
2. **Surgical diffs only.** Every changed line must trace to my request. Don't refactor, reformat, or
   "improve" code you weren't asked to touch. (→ §3)
3. **Verify before declaring done.** A task is finished when `bun run test`, `bun run lint`, and
   `bun run build` are green — not when the code "looks right." (→ §6)
4. **Respect the MCP boundary.** The engine and arenas talk **only over MCP**. Never make the engine
   import an arena's code, and never let an arena reach into engine internals. (→ Project context)
5. **Ask before assuming.** Multiple interpretations? Surface them. Simpler path? Say so. Unclear?
   Stop and name what's confusing — don't guess silently. (→ §1)
6. **Keep the save point current.** Update [`PROJET_MEMORY.md`](./PROJET_MEMORY.md) at the end of any
   session or major task. (→ §7)

---

## Project context — AgentArena

A task-agnostic **harness** that drops 2–16 LLMs into a task exposed as an **MCP server** and scores
how they *act* (tool use, cost, reliability, concision). The engine never invents a winner; the MCP
owns the rules.

- **Runtime & language:** Bun (runtime + workspaces) · TypeScript (strict).
- **Stack:** `@modelcontextprotocol/sdk` · Zod (runtime validation, single source of truth for types) ·
  React 19 + Vite + Tailwind · Vitest · Biome.
- **Monorepo layout:** `packages/{types,engine,cli,server,web,mcps}` — `mcps/` holds one folder per
  arena (`chess/` is the reference).
- **Architectural invariants (do not break):**
  - Engine ↔ arena communicate **only over MCP (stdio)**. The engine discovers tools/prompt/stats at
    runtime; it never imports arena code.
  - **Live === Replay:** one pure reducer over the immutable JSONL log drives both. Any change to log
    shape or the reducer must keep them bit-for-bit identical.
  - Types live in `packages/types` as **Zod schemas**; derive TS types from them, don't hand-write
    parallel interfaces.
  - API keys come from the **environment** (`.env`), never from committed config.

**Commands** (run from repo root):

```bash
bun run test     # Vitest — full suite
bun run lint     # Biome
bun run build    # typecheck + build every package (incl. dashboard)
bun run start    # boots server + dashboard + match, opens browser
```

---

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly; if uncertain, ask.
- Multiple interpretations → present them, don't pick silently.
- A simpler approach exists → say so, push back when warranted.
- Something unclear → stop, name it, ask.

## 2. Simplicity first

**The minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked, no abstractions for single-use code.
- No "flexibility"/"configurability" I didn't request, no error handling for impossible cases.
- 200 lines that could be 50 → rewrite it. *"Would a senior engineer call this overcomplicated?"*

## 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

- Don't improve adjacent code, comments, or formatting; match existing style even if you'd differ.
- Don't refactor what isn't broken.
- Spot unrelated dead code? Mention it — don't delete it (that's §4's exception).
- Remove imports/vars/functions **your** change orphaned; leave pre-existing dead code alone.

## 4. Leave no dead code

**Every change leaves the tree clean. No orphans, ever.** The most common AI smell: the old function
stays after the new one lands. After any add/edit/delete:

- Remove what you orphaned: imports, vars, functions, types, files, deps, Tailwind classes, dead flags.
- Delete a function → find call sites, remove now-unreachable branches.
- Replace an approach → delete the old one in the *same* change. No "to clean up later."
- No commented-out code as a safety blanket. Git is the history; the file is the present.
- Verify: grep the removed symbol, run `bun run lint` (flags unused) + `bun run build`, read your diff.

## 5. Research-backed recommendations

**Asked for a professional opinion? Investigate, then recommend — don't guess.**

For any "what's the best way…", design, or tooling question:
- Check current best practice (official docs, the library's own guidance) over memory/folklore.
- Return **options with tradeoffs**, then a clear recommendation and why; cite what you relied on.
- If research contradicts my assumption, say so plainly, with evidence.
- Default to the boring, idiomatic, well-supported solution. Novelty must earn its keep.

## 6. Goal-driven execution

**Define success criteria. Loop until verified.**

- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Tests green before and after."

For multi-step work, state a brief plan with a verify step each:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong criteria let you loop independently; weak ones ("make it work") cause churn.

## 7. Project memory (save point)

**Keep [`PROJET_MEMORY.md`](./PROJET_MEMORY.md) as a concise, high-value save point** — so a fresh AI
session resumes instantly. Update it at the end of each session/major task. It holds:

- **Current State** — where the project stands.
- **Recent Changes** — what just shipped.
- **Next Steps** — what's next.

---

**These rules are working if:** diffs are smaller, rewrites from overcomplication are rarer, and
clarifying questions arrive *before* implementation — not after a mistake.
