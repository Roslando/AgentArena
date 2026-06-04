# CLAUDE.md

> The engineering standards I hold my AI pair-programmer to on this project — and myself.
> They encode how I expect production code to be written and reviewed: deliberate, minimal,
> and verified before it ships.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Leave No Dead Code

**Every change leaves the tree clean. No orphans, ever.**

Dead code is the most common smell I see from AI edits: a function gets replaced but the
old one stays, an import is no longer used, a branch becomes unreachable. After *any*
add/edit/delete, sweep the blast radius before declaring the task done:

- Remove what your change orphaned: unused imports, variables, functions, types, files,
  dependencies, CSS classes, dead feature flags.
- Deleting a function? Find its call sites and remove the now-unreachable branches too.
- Replacing an approach? Delete the old one in the *same* change. Never leave both "to clean
  up later" — later never comes.
- No commented-out code as a safety blanket. Git is the history; the file is the present.

Verify, don't assume: grep the symbol you removed, run the typechecker/linter (it flags
unused), and read your own diff top to bottom. If a line no longer earns its place, it goes.

(Pre-existing dead code you did not touch: mention it, do not silently delete it — see §3.)

## 5. Research-Backed Recommendations

**When asked for a professional opinion, do not guess — investigate, then recommend.**

For any "what's the best way to…", "is this the right approach", or design/architecture/
tooling question, a senior answer is researched, not improvised:

- Check current best practice (official docs, the library's own guidance, reputable sources)
  instead of answering from memory.
- Prefer the convention the ecosystem actually uses *today* over folklore or stale habits.
- Come back with options, not a single decree — each with its tradeoffs, then a clear
  recommendation and why.
- Cite what you relied on, so the decision is auditable.
- If the research contradicts my assumption, say so plainly, with evidence.

Default to the boring, idiomatic, well-supported solution. Novelty has to earn its keep.

## 6. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 7. Project Memory (Save Point)

**Maintain `PROJET_MEMORY.md` as a concise, high-value project journal/save point.**

- Update [PROJET_MEMORY.md](file:///c:/Users/HP/Downloads/DevFolio/PROJET_MEMORY.md) at the end of each session or major task.
- Keep it clean, structured, and free of fluff. It must serve as a video game "save point" for a new AI session to quickly resume work.
- It should include:
  - **Current State:** A brief overview of the project's status.
  - **Recent Changes:** Bullet points of the latest work completed.
  - **Next Steps:** What needs to be done next.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
