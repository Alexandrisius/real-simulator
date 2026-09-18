# AGENTS.md — real-simulator

Local social AI-agent simulator (Next.js App Router). Characters with personas,
tools, and per-scene goals act in scenes; each character can run on its own
model (LM Studio, OpenRouter, any OpenAI-compatible endpoint, or built-in Mock).
**Communication is tools-only**: a model's free text is its inner thoughts
(visible only to the user — «Архитектор»); characters speak through the
virtual `say`/`text_message` tools. Read `README.md` (Russian, comprehensive)
before touching the engine, prompt assembly, or scoring.

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
- `src/lib/fallback.ts` — fallback model: refusal/truncation detector
  (`detectRefusal`: meta-refusal regexes RU/EN + structural signals —
  `content_filter`, empty response, token-limit cut) and `chatWithFallback`,
  which reroutes a refused iteration to the character's fallback provider
  (`characters.fallback_provider_id` + `fallback_model`) with a system nudge;
  the engine calls it instead of `chatCompletion` in `takeTurn`
- `src/lib/tools.ts` — tool execution: arg validation (incl. enum membership),
  audience + target resolution, boundaries, state effects, money cost
  (deducts `state.money`, refuses when short); consent-gated tools branch
  here into offer creation
- `src/lib/offers.ts` — offers/consent: a `requiresConsent` tool call creates
  an offer (table `offers`, TTL `OFFER_TTL_TURNS=6` turns) instead of
  executing; `respond_to_offer` accept executes the tool from the proposer
  via `executeTool` with `skipConsent` (boundaries/money re-checked), decline
  applies `tool.declineEffects`; anti-pressure (no duplicate pending, no
  repeat after decline)
- `src/lib/stops.ts` — stop tools: `leave_scene` (sets
  `scene_characters.left_scene`; the engine then burns the leaver's pending
  offers and finishes the scene when no unblocked conversation is left) and
  `block_character` (pair silenced both ways, table `scene_blocks`)
- `src/lib/finish.ts` — machine-readable scene finish: `scene.config.finish`
  conditions (toolCall/outcome/state, AND) checked after each played turn;
  engine plays `delayTurns` more turns, then auto-finishes
- `src/lib/combos.ts` — combos: exact ordered sequence of successful (not
  offered) calls within `windowTurns` fires effects once per scene
  (`checkCombos`, called from engine after each executed tool call — including
  executions via accepted offers). Steps may pin `actorName`/`targetName`
  (participant names): with role filters the chain may involve different
  actors but each step checks its role; with no filters anywhere the whole
  chain must belong to one actor (legacy semantics). Effects apply with the
  final call's actor/target. `knowers` see the recipe in prompt section
  «# Твои секреты»; empty `knowers` = secret achievement (recipe shown to
  nobody); `announce: true` broadcasts a world event (`director`, «✨ Комбо…»)
  to all participants when it fires
- `src/lib/chat.ts` — communication tools: `say` (spoken line, audience `all`
  or one addressee) and `text_message` (only the recipient sees it). Virtual
  specs appended by the engine, executed like every other virtual tool
- `src/lib/wardrobe.ts` — garments: wear-effect math (`applyWearEffects`,
  garment effects ±1, slot `bareEffects` active while the slot is empty),
  editor dress/undress (`dressCharacter`/`undressCharacterSlot`), agent
  wardrobe tools `wardrobe_browse`/`wear_garment` (`wardrobeTextFor`,
  `wearOwnedGarment` — swap with the closet, reverses worn effects)
- `src/lib/places.ts` — places registry + `go_to`/`invite` virtual tools
  (`go_to` changes `scene.config.place`)
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
  effects (`processPendingEffects` is ticked by flow seating); garments are
  sold here too (ownership + auto-wear, exempt from gift saturation)
- `src/lib/prompt.ts` — per-agent context assembly and history reconstruction
  (others' speech = thoughts, NOT reconstructed; see the thoughts invariant)
- `src/lib/engine/` — scene turn loop (`engine.ts`) + SSE hub (`hub.ts`)
- `src/lib/flow/runner.ts` — flow runs over the canvas graph (singleton
  `__simFlowRunner` on `globalThis`); drives scenes only through the engine's
  public API, never touches the turn loop directly
- `src/lib/api.ts` — zod schemas for REST input validation
- `src/lib/scoring.ts` — validation-scheme scoring over events; also feeds
  flow transition conditions (`characterSuccessfulCalls`); offered calls are
  excluded from scoring
- `src/app/api/` — REST + SSE routes (`/api/stream` is the SSE endpoint);
  flows: `/api/flows`, `/api/flows/[id]/runs`, `/api/flow-runs/[id]`,
  tool requests: `/api/tool-requests`, scene reset: `/api/scenes/[id]/reset`,
  wardrobe: `/api/garments`, `/api/garments/[id]`, `/api/combos`,
  `/api/combos/[id]`, `/api/characters/[id]/wardrobe` (GET/POST),
  places registry: `/api/places` (+ `/api/places/[name]` PATCH = rename with
  cascade, collision → 409),
  corporate TLS mode: `/api/network-settings` (setting `network.insecureTls`,
  applied per outbound call in `llm.ts` via `NODE_TLS_REJECT_UNAUTHORIZED`)
- `src/app/` pages — dashboard, flows (canvas editor + run view), characters,
  tools, shop, wardrobe (garment catalog + issuing to characters), attributes
  (incl. clothing slots), skills, providers, scenes, schemas, prompt
  (editable prompt sections)
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
  `pauseForHumans` the scene auto-pauses each full round so the user can
  speak and act for them (`/api/scenes/[id]/say|act` — note `say` writes a
  `speech` event, i.e. a thought; to be heard, act with the `say`/
  `text_message` pseudo-tools via `/act`).
- Each turn: engine builds the system prompt (`buildSystemPrompt`: persona,
  setting, participants, current state, rules, and the character's **secret
  per-scene goal** — visible only to that character) and reconstructs message
  history from that character's **visible** events (`buildMessages`), then
  calls the character's own provider with tools in OpenAI function-calling
  format. Tool specs get `enum` lists of real entities injected each turn
  (see the enum-injection rule below).
- The model replies with thoughts (free text) and/or tool calls; communication
  happens ONLY through tools (`say`/`text_message` + world tools). `tools.ts`
  validates args, resolves the target by name, applies state effects, and
  appends events with an audience (`all` / `target` / `self` / `none`).
  Clients follow the feed over SSE (`/api/stream`), each rendering only what
  its selected character may see (the scene page also has an
  «Архитектор (всё)» mode showing everything, thoughts included, marked 💭).
  The Architect (user) can inject narration to any audience; such `director`
  events reach prompts WITHOUT an observer figure — broadcast as
  «[Событие мира]», personal as «[Тебе в голову пришла мысль]» (injections
  read as the character's own thought; the Architect is not a character to
  talk to).
- Offers in the loop: a pending incoming offer gives the target the virtual
  `respond_to_offer` spec plus prompt sections «Тебе предлагают» /
  «Ты предложил» (rules section `rules_offers`); stop tools
  `leave_scene`/`block_character` are appended when
  `scene.config.allowAgentStops` (default true) and participants > 1, with
  rules section `rules_stops`.
- After each played turn the loop checks `scene.config.finish` conditions
  (`finishConditionsSatisfied`); when all hold — system event, the scene
  plays `delayTurns` more turns, then auto-finishes (status `finished`,
  flow transitions react as usual).
- Scoring (`scoring.ts`) is post-hoc: it validates the recorded tool-call
  chains against the validation schema attached to each (scene, character)
  pair — strict order, early/forbidden calls are violations; calls marked
  `offered` (proposals) are excluded.

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
- **Thoughts epistemics (мысли вместо речи)**: a model's free text is its
  INNER MONOLOGUE — nobody hears it but the user («Архитектор»).
  `buildMessages` renders the agent's own `speech` events as assistant
  content (it remembers what it "thought") but does NOT reconstruct other
  characters' speech at all; agents exchange content only through tool
  observations (`say`/`text_message`/world tools arrive as action events).
  The engine still drops a speech event that duplicates a tool argument
  (≥20 chars, `takeTurn` dup check) so a phrase echoed from `say.phrase`/
  `text_message.text` appears exactly once. The human quick-text input
  (`POST /api/scenes/:id/say`) also creates a `speech` event — i.e. a
  thought: to be heard as a character, use `act` with the `say`/
  `text_message` pseudo-tools.
- **Engine loop epochs**: start/resume/step increments `run.epoch`; an async
  loop exits as soon as `run.epoch` differs from the value it was spawned
  with, so stale loops die. Don't add fire-and-forget awaits that bypass the
  epoch check.
- **Refusals are intercepted before any event exists**: `takeTurn` calls
  `chatWithFallback` (`src/lib/fallback.ts`). When the primary model refuses
  (meta-refusal text in content/tool args), returns an empty response with no
  tool calls (silent filter cut), sets `finish_reason=content_filter`, is cut
  by the token limit before acting, or the API throws a content-policy error —
  the same request goes to the character's fallback provider
  (`fallback_provider_id`/`fallback_model`) with a system nudge, and the
  fallback's completion is played as the character's turn. The refusal never
  becomes an event and is never reconstructed into prompts; the Architect
  sees a `system` event only (system events don't enter prompts). Both
  attempts are logged in `api_logs` and counted in scene spend (2 calls per
  rescued turn). Rerouting is stateless: the next turn uses the primary model
  again. Soft refusal phrasings («я не могу продолжать») count ONLY in
  responses without tool calls — an in-character «не могу» said via `say` is
  dialogue, not censorship; keep that distinction when touching
  `detectRefusal`. If no fallback is configured, behaviour is unchanged.
- **Finish conditions are machine-readable, checked after each played turn**:
  all `scene.config.finish.conditions` (toolCall / outcome / state, AND) must
  hold against executed (not offered) calls; then the scene plays
  `delayTurns` more turns and finishes itself with a system event. Flow
  transitions treat it like any finished scene.
- **Chat, `request_tool`, shop, stops, places, wardrobe and offers tools are
  virtual**: they have no DB rows. The engine appends `say`/`text_message`
  when the scene has more than one participant (communication is
  tools-only), `request_tool` when
  `scene.config.allowToolRequests` is on, `shop_browse`/`shop_buy` when the
  shop is non-empty (products or garments with price > 0), `reveal_attribute`
  when the attribute registry has `hidden` entries, `undress`/`wear` when the
  clothing-slot registry is non-empty, `wardrobe_browse`/`wear_garment` when
  the character owns at least one garment, `go_to`/`invite` when the places
  registry is non-empty, `respond_to_offer` when the character has pending
  incoming offers, and `leave_scene`/`block_character` when
  `scene.config.allowAgentStops` is on. Calls route through
  `Engine.runVirtualTool`/`runSceneControlTool` — one shared path for
  `takeTurn` and `act`. The mock provider is untouched by these — it just
  answers whatever specs it is given.
- **Tools are data, not code**: agents can only propose declarative tool
  drafts (schema/audience/effects/cost); `executeTool` stays the only
  interpreter. Keep it that way. Products are plain cards, never tools.
  Same for combos: `combos` table rows are data interpreted by `checkCombos` —
  steps reference existing tools (optionally pinning actor/target names),
  `knowers` reference existing characters (validated on save); knowers see
  the step order in prompt section «# Твои секреты», everyone else only sees
  the consequences (or the announcement, if `announce` is on).
- **Offers/consent keeps one execution path**: a `requiresConsent` targeted
  call never executes inline — it creates an offer row and the ActionCall is
  marked `offered: true`. Scoring, flow conditions, combos and finish
  conditions count only executed calls (`offered` excluded). On
  `respond_to_offer accept` the engine executes the tool FROM THE PROPOSER
  through the same `executeTool` with `skipConsent` — boundaries and money
  are re-checked at consent time. Decline applies `tool.declineEffects` with
  boundary-effect semantics (declining character's state and its relation to
  the proposer). Boundary/money gates run BEFORE offer creation — a failed
  gate means the proposal itself is impossible.
- **Enum injection**: each turn the engine deep-clones tool schemas and
  fills `enum` lists with real entities (`withEntityEnums`): `targetParam` →
  scene participant names; properties annotated `x-entity`
  (`"character"|"place"|"product"|"slot"|"attribute"`, set via the tools UI
  «Связи параметров с сущностями») → registry values; virtual tools get
  fresh lists too (`reveal_attribute.attribute` = hidden keys,
  `undress`/`wear.slot`, `say`/`text_message.to` = participant names,
  `wear_garment.garment` = the actor's owned garments,
  `go_to`/`invite.place`, `shop_buy.item`/`.for`,
  `respond_to_offer.offer`, `block_character.target`). The `x-entity` key is
  stripped before the spec reaches the model. Runtime validation
  (`validateArgs`) enforces enum membership and executors return errors
  listing allowed values. Preserve both halves: injection + validation.
- **left_scene flags and scene_blocks survive restart** (DB rows, not memory):
  a character with `left_scene=1` is excluded from rotation until the cast is
  rebuilt or the scene is reset; a blocked pair sees none of each other's
  events (`blockedIdsFor` filters the visible feed). Start/resume of a scene
  with no living conversation throws a Russian error. `resetScene` clears
  blocks, left flags and offers.
- **Garments extend clothing slots, not replace them**: worn state is still
  the flat `worn_<slot>`/`carried_<slot>` state keys; `garments` +
  `character_garments` add a catalog and per-character ownership whose
  effects are applied/reversed by `wardrobe.ts:applyWearEffects` on
  undress/wear/purchase/editor-dress. Slot `bareEffects` are active while the
  slot is empty. Reversal is approximate because of registry clamping — a
  documented tradeoff, don't "fix" it by bypassing clamps. Agents manage
  their own closet via the virtual `wardrobe_browse`/`wear_garment` tools
  (swap with the closet through `dressCharacter`, observation
  «переодевается: …»); the UI entry points are the /wardrobe catalog page
  (issuing garments to characters) and the personal closet card in the
  character editor.
- **Epistemics invariant**: the truth about a `hidden` attribute never enters
  a prompt without a `verified` knowledge record for that specific observer.
  Truth lives in the owner's state; claims live in the `knowledge` table
  (`claimed` | `verified`); physics verifies against truth (`undress` in
  `src/lib/clothing.ts`, `attr` conditions in boundaries, `verifyForObserver`
  in `src/lib/knowledge.ts`). Others' hidden attributes render in prompts
  ONLY from knowledge rows (`prompt.ts:participantAttrLine`).
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
- **Boundaries fail closed**: consent rules are checked inside `executeTool`
  before money and effects; refusal = action not executed, money intact,
  `ok:false` (scoring filters it out), social-penalty effects only (the rule
  owner's relation/state, never the initiator). The refusal event is
  **actor-only** (`audience:"none"`) — the reason text names true values, so
  the target and bystanders must never see it. Reasons for `relation` and
  hidden attributes are given without exact numbers (epistemics: no leaking
  the partner's feelings or hidden state through refusal texts). Boundaries
  are never shown in prompts — agents learn by hitting them. Rules have a
  `scope`: `"incoming"` (default — someone targets the owner), `"outgoing"`
  (the owner targets someone: «я не делаю этого с теми, у кого…») or `"both"`;
  condition roles are always call-relative (`actor` = who calls,
  `target` = who receives).
  A rule is `{toolName ('*' = any targeted tool), scope?, conditions[],
  refusalText, effects}`; conditions (`types.ts:BoundaryCondition`) are AND-ed:
  `relation{op,value}` (rule owner's matrix relation to the other party),
  `attr{owner: actor|target, key, op, value}` (TRUE state),
  `place{place}`, `worn{slot, bare}`. An empty condition list never fires.
  Legacy flat fields (`minRelation/minMood/minAttr/requirePlace/requireAttr`)
  are read-only compat: normalized into `conditions` on read
  (`queries.ts:mapBoundary`) and on write (`api.ts:boundarySchema` transform
  when `conditions` is not passed explicitly). Relation remains a system
  entity (the matrix) — inside boundaries it is just a condition kind.
- **No context duplication**: when a model echoes the same text as both a
  speech and a tool argument (common LLM pattern), the engine drops the
  duplicate speech event (`takeTurn` dup check); `executeTool` tool results
  do NOT echo observations built from the actor's own long (≥40 chars) args —
  the text already lives in `tool_calls.arguments`. Keep both behaviours:
  reconstruction (`buildMessages`) and the live loop rely on the text
  appearing exactly once.
- API routes validate input with zod schemas from `src/lib/api.ts`; client code
  goes through `api()` in `src/components/api.ts`. `PATCH /api/characters/:id`
  with `state` MERGES by key (a full replace would wipe engine changes made
  since the editor page was opened); `null` value deletes the key, and edits
  are mirrored two ways so they survive scene «Заново»: new/deleted keys go
  into `scene_characters.initial_state` snapshots (existing snapshot values
  untouched — replay must still revert scene progress), while ALL edited
  keys/values land in `scene_characters.editor_overlay`
  (`overlayEditorState`), which `resetSceneFull` re-applies on top of the
  restored snapshot — explicit Architect edits (money, static traits) are
  never reverted by «Заново», only scene progress is. The editor wardrobe
  endpoint (`POST /api/characters/:id/wardrobe`) records its state delta
  through `recordWardrobeEdit` (mirror + overlay) — clothing configured in
  the editor survives «Заново» too, while agents undressing each other
  inside a scene reverts with the snapshot. The editor page itself
  sends ONLY the diff vs its load-time baseline (stale keys would silently
  revert server-side changes: money spent by a scene, wardrobe-card dressing);
  the wardrobe card re-syncs the form state after wear/remove, re-applying
  the user's unsaved edits on top.
- Budget/spam guards live in the engine: per-scene API-call and token limits,
  anti-repeat (3 identical tool calls → pause), 5 consecutive failed turns →
  pause, 3-minute per-turn timeout. Keep them intact. Flow runs go through
  the same guards (the runner only calls `control(start/pause)`).
- A scene may appear in only one node of a flow graph (validated); `resetScene`
  wipes events/cursor/spend, clears offers, scene blocks and left-scene
  flags, but keeps participants, goals, and schema bindings.

## Conventions

- Import alias: `@/*` → `./src/*` (see `tsconfig.json`).
- Code comments and UI strings are **in Russian** — match that.
- UI is dark-only (`color-scheme: dark` is set globally). Never use native
  `<select>`/`<datalist>` — their popups are OS-drawn, light, and positioned
  unpredictably; use `Select` / `Dropdown` / `Combobox` from `src/components`
  (dropdown menus render in-app, direction up or down).
- Entity references in forms are pickers over registries, not free text:
  places multi-select for slot `undressPlaces`, place dropdowns in scenes,
  boundary condition rows (kind/entity/op pickers in the block constructor
  «Когда срабатывает / Условия / Отказ»), outcome place select,
  `targetParam` select from schema properties, shop category combobox.
  «Изменить» on a card opens the edit form and scrolls it into view.
- DB path: `data/app.db` by default, overridable via `SIM_DB_PATH`. WAL mode
  and `foreign_keys=ON` are set on connect; schema and seed run automatically.

## Gotchas

- **СБОРКА И СЕРВЕРЫ НЕСОВМЕСТИМЫ (Windows, критично)**: `npm run build`
  зависает намертво (0 % CPU, вечное ожидание файлового лока `.next`), если
  запущен ЛЮБОЙ сервер этого репозитория (`npm run dev`, `start.bat`) или
  осела зомби-сборка от отменённой команды. Перед каждой сборкой:
  1) `cmd //c "start.bat stop"`, затем проверить
     `netstat -ano | findstr :3999` — LISTENING быть НЕ должно;
  2) найти и убить осевшие node-процессы:
     `powershell "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Select ProcessId,CommandLine"`
     — убивать всё, где встречается `next build`, `next dev`,
     `.next\standalone` или `next start`;
  3) только потом `npm run build` (на этой машине ~20 с; если идёт дольше
     2 минут — снова лок, возвращайся к п. 1–2, НЕ жди);
  4) запуск: `cmd //c "start.bat start"` (сервер стартует из корня проекта
     и сам подхватывает `.next` и `data/app.db`).
  НИКОГДА не поднимай прод как `node .next/standalone/server.js`: standalone
  меняет рабочий каталог (относительный `SIM_DB_PATH` молча уводит запись в
  копию `data/` внутри сборки — данные «теряются» после пересборки), а
  `.next/static`/`public` в standalone-папке отсутствуют, пока их не
  скопировать руками (без этого приложение «без CSS»). Прод = только start.bat.
  Отменённые фоновые сборки оставляют зомби-процессы `next build` — они и
  есть причина «вечных» команд; убивай их, а не жди таймаутов.
- Windows + TLS-intercepting antivirus/proxy: OpenRouter fails with
  `self-signed certificate in certificate chain` — run with `NODE_USE_SYSTEM_CA=1`.
- Thinking models (Qwen3 etc.): reasoning tokens eat the response budget; set
  max tokens ≥ 1500–2048 or tool calls come back empty. 20–60s per turn is normal.
- Extension points documented in README: memory/summarization should hook into
  `src/lib/prompt.ts:buildMessages`; scoring builds on `events` + `api_logs`.
