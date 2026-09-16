# AGENTS.md — real-simulator

Local social AI-agent simulator (Next.js App Router). Characters with personas,
tools, and per-scene goals converse in scenes; each character can run on its own
model (LM Studio, OpenRouter, any OpenAI-compatible endpoint, or built-in Mock).
Read `README.md` (Russian, comprehensive) before touching the engine, prompt
assembly, or scoring.

## Commands

- `npm run dev` — dev server (default port 3000; port 3000 is taken by another
  process on this machine, so pass an explicit port: `npm run dev -- -p 3999`)
- Production: run `start.bat` (repo root) — port 3999, `NODE_USE_SYSTEM_CA=1`,
  DB defaults to `data/app.db` (no `SIM_DB_PATH` override) and opens the browser.
  Interactive menu; subcommands: `start | stop | restart | status | log | build`.
- Portable release for any PC: `node scripts/make-release.mjs` — builds
  `release/` (standalone server + `START.bat` + `УСТАНОВКА.txt`); runs with
  Node 22.13+ only, DB is created on first start.
- `npm run e2e` — engine e2e test on the mock provider (no LLM needed); runs
  `tsx scripts/e2e.ts`, sets `SIM_DB_PATH=data/e2e-test.db`, wipes that DB first
- No linter is configured. Typecheck: `npx tsc --noEmit`.
- Node 22.13+ required (uses `node:sqlite`); tested on 24.x.

## Layout

- `src/db/` — SQLite via `node:sqlite` (no native deps): schema in `index.ts`,
  typed queries in `queries.ts`, default tool seeds in `seed.ts`
- `src/lib/llm.ts` — OpenAI-compatible client incl. mock
- `src/lib/tools.ts` — tool execution: arg validation, audience, state effects,
  money cost (deducts `state.money`, refuses when short)
- `src/lib/toolRequests.ts` — agent tool requests: `request_tool` spec, draft
  validation, architect decisions (approve creates the tool + notifies the
  character via a personal director event)
- `src/lib/knowledge.ts` — epistemics: `reveal_attribute` (claims, may lie),
  verification + lie exposure (director event to the observer, relation
  penalty from the attribute's `liePenalty`)
- `src/lib/clothing.ts` — clothing slots: `undress`/`wear` virtual tools,
  layer order + place rules, auto-verification of `coveredBy` attributes
- `src/lib/shop.ts` — shop module: `shop_browse`/`shop_buy` virtual tools,
  catalog text, purchases (money + effects + clothing slot wear), delayed
  effects (`processPendingEffects` is ticked by flow seating)
- `src/lib/prompt.ts` — per-agent context assembly and history reconstruction
- `src/lib/engine/` — scene turn loop (`engine.ts`) + SSE hub (`hub.ts`)
- `src/lib/flow/runner.ts` — flow runs over the canvas graph (singleton
  `__simFlowRunner` on `globalThis`); drives scenes only through the engine's
  public API, never touches the turn loop directly
- `src/lib/api.ts` — zod schemas for REST input validation
- `src/lib/scoring.ts` — validation-scheme scoring over events; also feeds
  flow transition conditions (`characterSuccessfulCalls`)
- `src/app/api/` — REST + SSE routes (`/api/stream` is the SSE endpoint);
  flows: `/api/flows`, `/api/flows/[id]/runs`, `/api/flow-runs/[id]`,
  tool requests: `/api/tool-requests`, scene reset: `/api/scenes/[id]/reset`,
  corporate TLS mode: `/api/network-settings` (setting `network.insecureTls`,
  applied per outbound call in `llm.ts` via `NODE_TLS_REJECT_UNAUTHORIZED`)
- `src/app/` pages — dashboard, flows (canvas editor + run view), characters,
  tools, shop, attributes (incl. clothing slots), skills, providers, scenes,
  schemas
- `src/components/` — client components; `api.ts` is the fetch/error helper
- `data/` — SQLite DBs, gitignored, contains **unencrypted API keys**; never
  publish or commit. `data/app.db` is the user's live database (created on
  first start); e2e and test stands use their own DB files
  (`e2e-test.db`, `clean.db`, legacy `smoke.db` — archives, never delete).
- `.agents/skills/real-simulator-guide/` — operating skill for AI agents:
  how to help the user create characters, scenes, tools, flows, debug runs;
  REST examples in `references/`. Load it when the task is *using* the app
  rather than changing it.

## How a scene runs

- A scene has ordered participants; the engine loops over AI characters only.
  Human-flagged characters are excluded from the rotation; with
  `pauseForHumans` the scene auto-pauses each full round so the user can speak
  and act for them (`/api/scenes/[id]/say|act`).
- Each turn: engine builds the system prompt (`buildSystemPrompt`: persona,
  setting, participants, current state, rules, and the character's **secret
  per-scene goal** — visible only to that character) and reconstructs message
  history from that character's **visible** events (`buildMessages`), then
  calls the character's own provider with tools in OpenAI function-calling
  format.
- The model replies with speech and/or tool calls; `tools.ts` validates args,
  resolves the target by name, applies state effects, and appends events with
  an audience (`all` / `target` / `self` / `none`). Clients follow the feed
  over SSE (`/api/stream`), each rendering only what its selected character
  may see. The director (user) can inject narration to any audience.
- Scoring (`scoring.ts`) is post-hoc: it validates the recorded tool-call
  chains against the validation schema attached to each (scene, character)
  pair — strict order, early/forbidden calls are violations.

## Architecture rules

- **Singletons survive HMR**: the DB (`__simDb`), engine (`__simEngine`) and
  flow runner (`__simFlowRunner`) are cached on `globalThis`. Do not replace
  this pattern — plain module-level singletons break under `next dev` hot
  reload.
- **Visibility is the core invariant**: each agent sees only public events,
  messages addressed to it, and its own actions. `prompt.ts:buildMessages`
  reconstructs per-agent history from `getVisibleEvents`. Any change to events,
  tools, or audiences must preserve this. Tool requests are `action` events
  with `audience: "none"` (actor-only); decisions and flow recaps reach the
  character as `director` events addressed to them — `system` events are NOT
  reconstructed into prompts, never use them for agent-facing notices.
- **Engine loop epochs**: start/resume/step increments `run.epoch`; an async
  loop exits as soon as `run.epoch` differs from the value it was spawned
  with, so stale loops die. Don't add fire-and-forget awaits that bypass the
  epoch check.
- **`request_tool` and shop tools are virtual**: they have no DB rows. The
  engine appends `request_tool` when `scene.config.allowToolRequests` is on,
  `shop_browse`/`shop_buy` when the products table is non-empty,
  `reveal_attribute` when the attribute registry has `hidden` entries, and
  `undress`/`wear` when the clothing-slot registry is non-empty. Calls route
  through `Engine.runVirtualTool` — one shared path for `takeTurn` and `act`.
- **Tools are data, not code**: agents can only propose declarative tool
  drafts (schema/audience/effects/cost); `executeTool` stays the only
  interpreter. Keep it that way. Products are plain cards, never tools.
- **Epistemics invariant**: the truth about a `hidden` attribute never enters
  a prompt without a `verified` knowledge record for that specific observer.
  Truth lives in the owner's state; claims live in the `knowledge` table
  (`claimed` | `verified`); physics verifies against truth (`undress` in
  `src/lib/clothing.ts`, `requireAttr` in boundaries, `verifyForObserver` in
  `src/lib/knowledge.ts`). Others' hidden attributes render in prompts ONLY
  from knowledge rows (`prompt.ts:participantAttrLine`).
- **Single execution path**: model tool calls (`takeTurn`) and the puppeteer's
  manual `act()` go through the same `executeTool`/`runVirtualTool` —
  boundaries, money, clothing layers/places cannot be bypassed via REST.
- **Skills are hidden attributes + a practice counter**: a skill with
  `grows=true` auto-manages a `hidden` attribute `skill_<key>` (0..maxLevel,
  enforced by `syncSkillAttribute`); the practice counter lives in the
  `skill_practice` table (NOT state — it must not leak into prompts).
  `applySkillPractice` inside `executeTool` ticks only on `ok:true` calls of
  tools with `trainsSkill`; the level bump goes into the actor's state but
  never into the event payload `stateChanges` (the partner would see it) —
  the actor gets it via the tool result + a personal `system` event from the
  engine (`skillUps` on `ToolExecResult`). State writes are clamped to the
  attribute registry min/max (`clampStateValues` in `src/lib/tools.ts` —
  used by tools, shop, boundaries, clothing).
- **Outcomes check truth, then fire once**: `matchOutcome` (in
  `executeTool`) evaluates `Tool.outcomes` conditions against TRUE state at
  the moment of the action (before effects); the first matching outcome adds
  its effects on top of the base ones. The notice reaches the target as a
  personal `director` event emitted by the engine (`outcome` on
  `ToolExecResult`); the fired outcome id lands in `ActionCall.outcome`
  (flow condition `type:"outcome"` matches on it). Non-hidden outcomes are
  appended to the tool description for the model via `outcomeHintText`;
  hidden ones (`hideFromPrompt`) stay unknown until they fire.
- **Chemistry multiplies relation deltas**: symmetric hidden matrix
  (−3..+3, `chemistry` table, normalized key order). `applyRelationDelta`
  scales every relation effect (tools, outcomes, gifts) by `1 + chem/2`
  preserving sign; outcome effects with `target:"chemistry"` move the pair
  value (clamped). Agents never see chemistry values — only consequences.
- **Boundaries fail closed**: a consent rule on the target is checked inside
  `executeTool` before money and effects; refusal = action not executed,
  money intact, `ok:false` (scoring filters it out), social-penalty effects
  only (relation/target state, never the actor). Boundaries are never shown
  in prompts — agents learn by hitting them. The initiator's own boundaries
  are not checked: calling the tool is their own decision.
- **No context duplication**: when a model echoes the same text as both a
  speech and a tool argument (common LLM pattern), the engine drops the
  duplicate speech event (`takeTurn` dup check); `executeTool` tool results
  do NOT echo observations built from the actor's own long (≥40 chars) args —
  the text already lives in `tool_calls.arguments`. Keep both behaviours:
  reconstruction (`buildMessages`) and the live loop rely on the text
  appearing exactly once.
- API routes validate input with zod schemas from `src/lib/api.ts`; client code
  goes through `api()` in `src/components/api.ts`.
- Budget/spam guards live in the engine: per-scene API-call and token limits,
  anti-repeat (3 identical tool calls → pause), 5 consecutive failed turns →
  pause, 3-minute per-turn timeout. Keep them intact. Flow runs go through
  the same guards (the runner only calls `control(start/pause)`).
- A scene may appear in only one node of a flow graph (validated); `resetScene`
  wipes events/cursor/spend but keeps participants, goals, and schema bindings.

## Conventions

- Import alias: `@/*` → `./src/*` (see `tsconfig.json`).
- Code comments and UI strings are **in Russian** — match that.
- UI is dark-only (`color-scheme: dark` is set globally). Never use native
  `<select>`/`<datalist>` — their popups are OS-drawn, light, and positioned
  unpredictably; use `Select` / `Dropdown` / `Combobox` from `src/components`
  (dropdown menus render in-app, direction up or down).
- DB path: `data/app.db` by default, overridable via `SIM_DB_PATH`. WAL mode
  and `foreign_keys=ON` are set on connect; schema and seed run automatically.

## Gotchas

- Windows + TLS-intercepting antivirus/proxy: OpenRouter fails with
  `self-signed certificate in certificate chain` — run with `NODE_USE_SYSTEM_CA=1`.
- Thinking models (Qwen3 etc.): reasoning tokens eat the response budget; set
  max tokens ≥ 1500–2048 or tool calls come back empty. 20–60s per turn is normal.
- Extension points documented in README: memory/summarization should hook into
  `src/lib/prompt.ts:buildMessages`; scoring builds on `events` + `api_logs`.
