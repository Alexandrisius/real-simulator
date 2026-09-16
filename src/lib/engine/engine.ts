// Движок симуляции: управляет ходами сцены. Каждый ход — один персонаж:
// сборка его личного контекста -> вызов его модели с инструментами ->
// исполнение tool-вызовов -> продолжение итераций (модель может сказать
// реплику после действия), затем ход следующего.

import type {
  ActionCall,
  Audience,
  Character,
  ControlAction,
  SceneStatus,
  SimEvent,
  ToolSpec,
} from "@/lib/types";
import {
  appendApiLog,
  appendEvent,
  getCharacter,
  getProvider,
  getScene,
  getSceneGoals,
  getSceneParticipants,
  getToolsByIds,
  getVisibleEvents,
  incrementSceneSpend,
  knowledgeOf,
  listAttributes,
  listClothingSlots,
  listPlaces,
  listRelationsOf,
  listSkills,
  setSceneCursor,
  setSceneStatus,
} from "@/db/queries";
import { getDb } from "@/db";
import { chatCompletion } from "@/lib/llm";
import { buildMessages } from "@/lib/prompt";
import { executeTool, outcomeHintText, parseToolArguments } from "@/lib/tools";
import { handleToolRequestCall, REQUEST_TOOL_SPEC } from "@/lib/toolRequests";
import { buildCatalogText, executeShopBuy, SHOP_BROWSE_SPEC, SHOP_BUY_SPEC } from "@/lib/shop";
import {
  executeReveal,
  hasHiddenAttributes,
  REVEAL_TOOL_SPEC,
} from "@/lib/knowledge";
import {
  executeUndress,
  executeWear,
  UNDRESS_SPEC,
  WEAR_SPEC,
} from "@/lib/clothing";
import { executeGoTo, executeInvite, GO_SPEC, INVITE_SPEC } from "@/lib/places";
import { listProducts } from "@/db/queries";
import {
  GO_TOOL_NAME,
  INVITE_TOOL_NAME,
  REVEAL_TOOL_NAME,
  REQUEST_TOOL_NAME,
  SHOP_BROWSE_TOOL,
  SHOP_BUY_TOOL,
  UNDRESS_TOOL_NAME,
  WEAR_TOOL_NAME,
} from "@/lib/types";
import { getHub, type StatusPayload } from "./hub";

interface RunState {  sceneId: number;
  status: "running" | "paused";
  charIds: number[];
  index: number;
  turn: number;
  /** Метка поколения цикла: инкремент при start/resume, чтобы старые циклы умирали */
  epoch: number;
  abort: AbortController | null;
  wake: (() => void) | null;
  /** Счётчик подряд идущих неудачных ходов (для авто-паузы) */
  errors: number;
}

/** Таймаут одного вызова модели: локальные модели бывают медленными. */
const MODEL_TIMEOUT_MS = 180_000;
/** Сколько ошибок подряд допустимо до авто-паузы сцены. */
const MAX_CONSECUTIVE_ERRORS = 5;
/** Пауза между итерациями внутри одного хода, мс (анти-спам). */
const ITER_DELAY_MS = 600;
/** Сколько одинаковых действий подряд считается спамом. */
const REPEAT_SPAM_THRESHOLD = 3;

export class Engine {
  private runs = new Map<number, RunState>();

  constructor() {
    // Если сервер перезапустили во время симуляции — сцены замирают в paused.
    try {
      const db = getDb();
      db.prepare("UPDATE scenes SET status = 'paused' WHERE status = 'running'").run();
    } catch {
      // БД может быть ещё не создана при первом обращении — не критично.
    }
  }

  getRuntime(sceneId: number): {
    status: SceneStatus;
    turn: number;
    nextCharacterId: number | null;
    spentApiCalls: number;
    spentTokens: number;
  } {
    const scene = getScene(sceneId);
    const run = this.runs.get(sceneId);
    const charIds = run?.charIds ?? aiParticipantIds(sceneId);
    const turn = run?.turn ?? scene?.cursor ?? 0;
    let nextCharacterId: number | null = null;
    if (charIds.length > 0 && scene) {
      const idx = (run ? run.index : scene.cursor) % charIds.length;
      nextCharacterId = charIds[idx] ?? null;
    }
    return {
      status: run?.status ?? scene?.status ?? "idle",
      turn,
      nextCharacterId,
      spentApiCalls: scene?.spentApiCalls ?? 0,
      spentTokens: scene?.spentTokens ?? 0,
    };
  }

  async control(sceneId: number, action: ControlAction): Promise<StatusPayload> {
    switch (action) {
      case "start":
        return this.start(sceneId);
      case "resume":
        return this.resume(sceneId);
      case "pause":
        return this.pause(sceneId);
      case "stop":
        return this.stop(sceneId);
      case "step":
        return this.step(sceneId);
    }
  }

  private ensureRun(sceneId: number): RunState {
    let run = this.runs.get(sceneId);
    if (!run) {
      const scene = getScene(sceneId)!;
      const charIds = aiParticipantIds(sceneId);
      run = {
        sceneId,
        status: "paused",
        charIds,
        index: scene.cursor % Math.max(charIds.length, 1),
        turn: scene.cursor,
        epoch: 0,
        abort: null,
        wake: null,
        errors: 0,
      };
      this.runs.set(sceneId, run);
    }
    return run;
  }

  private validate(sceneId: number): { charIds: number[] } {
    const scene = getScene(sceneId);
    if (!scene) throw new Error("Сцена не найдена");
    const participants = getSceneParticipants(sceneId)
      .map((id) => getCharacter(id))
      .filter((c): c is Character => c !== null);
    if (participants.length === 0) throw new Error("В сцене нет персонажей");
    const aiChars = participants.filter((c) => !c.isHuman);
    if (aiChars.length === 0)
      throw new Error("В сцене нет ИИ-персонажей — людям движок не нужен, общайтесь вручную");
    for (const c of aiChars) {
      const p = c.providerId != null ? getProvider(c.providerId) : null;
      if (!p) throw new Error(`У персонажа "${c.name}" не задан провайдер`);
      if (p.kind !== "mock" && !c.model.trim())
        throw new Error(`У персонажа "${c.name}" не указана модель`);
    }
    return { charIds: aiChars.map((c) => c.id) };
  }

  private start(sceneId: number): StatusPayload {
    const existing = this.runs.get(sceneId);
    if (existing?.status === "running") return this.emitStatus(sceneId);
    const { charIds } = this.validate(sceneId);
    const run = this.ensureRun(sceneId);
    run.charIds = charIds;
    run.status = "running";
    run.errors = 0;
    run.epoch += 1;
    setSceneStatus(sceneId, "running");
    const payload = this.emitStatus(sceneId);
    void this.loop(sceneId, run.epoch);
    return payload;
  }

  private resume(sceneId: number): StatusPayload {
    const scene = getScene(sceneId);
    if (!scene) throw new Error("Сцена не найдена");
    const existing = this.runs.get(sceneId);
    if (existing?.status === "running") return this.emitStatus(sceneId);
    if (!existing && scene.status !== "paused") throw new Error("Сцена не на паузе");
    const { charIds } = this.validate(sceneId);
    const run = this.ensureRun(sceneId);
    run.charIds = charIds; // состав могли поменять, пока сцена стояла на паузе
    run.status = "running";
    run.errors = 0;
    run.epoch += 1;
    setSceneStatus(sceneId, "running");
    const payload = this.emitStatus(sceneId);
    void this.loop(sceneId, run.epoch);
    return payload;
  }

  private pause(sceneId: number): StatusPayload {
    const run = this.runs.get(sceneId);
    if (run) {
      run.status = "paused";
      run.abort?.abort();
      run.wake?.();
    } else {
      const scene = getScene(sceneId);
      if (!scene || scene.status !== "running") throw new Error("Сцена не запущена");
    }
    setSceneStatus(sceneId, "paused");
    return this.emitStatus(sceneId);
  }

  private stop(sceneId: number): StatusPayload {
    const run = this.runs.get(sceneId);
    if (run) {
      run.status = "paused"; // чтобы цикл завершился
      run.abort?.abort();
      run.wake?.();
      this.runs.delete(sceneId);
    }
    setSceneStatus(sceneId, "finished");
    return this.emitStatus(sceneId);
  }

  private async step(sceneId: number): Promise<StatusPayload> {
    const rt = this.getRuntime(sceneId);
    if (rt.status === "running") throw new Error("Сцена уже запущена — сначала пауза");
    if (rt.status === "finished") throw new Error("Сцена завершена — нажмите «Старт», чтобы продолжить");
    this.validate(sceneId);
    const run = this.ensureRun(sceneId);
    setSceneStatus(sceneId, "paused");
    // stepMode: ход должен отыграться полностью (действие + реплика),
    // как и в running-режиме, несмотря на статус paused у run.
    const result = await this.takeTurn(sceneId, run, true);
    if (result === "aborted") return this.emitStatus(sceneId);
    this.advance(sceneId, run);
    return this.emitStatus(sceneId);
  }

  /** Мягко забыть in-memory run сцены (без смены статуса в БД). */
  forget(sceneId: number): void {
    const run = this.runs.get(sceneId);
    if (run) {
      run.status = "paused";
      run.abort?.abort();
      run.wake?.();
      this.runs.delete(sceneId);
    }
  }

  /** Один шаг вперёд: следующий персонаж, счётчик ходов, курсор в БД. */
  private advance(sceneId: number, run: RunState): void {
    if (run.charIds.length === 0) {
      this.runs.delete(sceneId);
      setSceneStatus(sceneId, "finished");
      return;
    }
    run.index = (run.index + 1) % run.charIds.length;
    run.turn += 1;
    setSceneCursor(sceneId, run.turn);
    const scene = getScene(sceneId);
    if (scene && scene.config.maxTurns > 0 && run.turn >= scene.config.maxTurns) {
      this.runs.delete(sceneId);
      setSceneStatus(sceneId, "finished");
    }
  }

  private emitStatus(sceneId: number): StatusPayload {
    const rt = this.getRuntime(sceneId);
    const payload = { sceneId, ...rt };
    getHub().emitStatus(payload);
    return payload;
  }

  private async loop(sceneId: number, epoch: number): Promise<void> {
    for (;;) {
      const run = this.runs.get(sceneId);
      if (!run || run.epoch !== epoch || run.status !== "running") return;
      const scene = getScene(sceneId);
      if (!scene) {
        this.runs.delete(sceneId);
        return;
      }
      const result = await this.takeTurn(sceneId, run);
      const after = this.runs.get(sceneId);
      if (!after || after.epoch !== epoch || after.status !== "running") return;

      if (result === "error") {
        run.errors += 1;
        if (run.errors >= MAX_CONSECUTIVE_ERRORS) {
          run.status = "paused";
          run.abort?.abort();
          this.runs.delete(sceneId);
          setSceneStatus(sceneId, "paused");
          getHub().emitEvent(
            appendEvent(getDb(), sceneId, run.turn + 1, "system", null, "all", {
              message: `Сцена автоматически поставлена на паузу: ${MAX_CONSECUTIVE_ERRORS} неудачных ходов подряд.`,
            })
          );
          this.emitStatus(sceneId);
          return;
        }
      } else {
        run.errors = 0;
      }

      this.advance(sceneId, run);
      this.emitStatus(sceneId);

      // Опция «пауза для человека»: после полного круга ИИ ждём хода
      // режиссёра/игрока (реплика, действие или указание).
      const sceneNow = getScene(sceneId);
      if (sceneNow?.config.pauseForHumans && run.charIds.length > 0 && run.turn % run.charIds.length === 0) {
        run.status = "paused";
        run.abort?.abort();
        setSceneStatus(sceneId, "paused");
          getHub().emitEvent(
            appendEvent(getDb(), sceneId, run.turn, "system", null, "all", {
              message:
                "Круг завершён — пауза. Напишите за персонажа-человека: сцена продолжится сама. Или нажмите «Продолжить», если ИИ должен ходить без вас.",
            })
          );
        this.emitStatus(sceneId);
        return;
      }

      const delay = getScene(sceneId)?.config.turnDelayMs ?? 1500;
      await this.sleep(delay, run);
    }
  }

  private sleep(ms: number, run: RunState): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        run.wake = null;
        resolve();
      }, ms);
      run.wake = () => {
        clearTimeout(t);
        run.wake = null;
        resolve();
      };
    });
  }

  /**
   * Ход одного персонажа: может состоять из нескольких итераций (действие + реплика).
   * stepMode — ход выполняется полностью, даже если run стоит на паузе (ручной «Шаг»).
   * Возвращает "ok" | "error" | "aborted".
   */
  private async takeTurn(
    sceneId: number,
    run: RunState,
    stepMode = false
  ): Promise<"ok" | "error" | "aborted"> {
    const db = getDb();
    const turnNo = run.turn + 1;
    const runEpoch = run.epoch;
    const alive = () => {
      const r = this.runs.get(sceneId);
      if (r !== run || r.epoch !== runEpoch) return false;
      return stepMode || r.status === "running";
    };

    const charId = run.charIds[run.index];
    const character = getCharacter(charId);
    if (!character) {
      appendEvent(db, sceneId, turnNo, "system", null, "all", {
        message: `Персонаж #${charId} не найден, ход пропущен`,
      });
      return "error";
    }
    const provider = character.providerId != null ? getProvider(character.providerId) : null;
    if (!provider) {
      appendEvent(db, sceneId, turnNo, "system", character.id, "all", {
        message: `У персонажа "${character.name}" нет провайдера — ход пропущен`,
      });
      return "error";
    }

    const scene = getScene(sceneId)!;
    const participantIds = getSceneParticipants(sceneId);
    const participants = participantIds
      .map((id) => getCharacter(id))
      .filter((c): c is Character => c !== null);
    const tools = getToolsByIds(character.toolIds);
    // Подсказка об исходах: незасекреченные требования дописываются в описание,
    // скрытые исходы модель узнаёт по факту (эпистемика сохраняется).
    const skillDefs = listSkills();
    const attrDefs = listAttributes();
    const toolSpecs: ToolSpec[] = tools.map((t) => ({
      name: t.name,
      description:
        (t.cost > 0
          ? `${t.description || t.title || t.name} (цена: $${t.cost})`
          : t.description || t.title || t.name) + outcomeHintText(t, skillDefs, attrDefs),
      parameters: t.parametersSchema?.type
        ? t.parametersSchema
        : { type: "object", properties: {} },
    }));
    // Виртуальный инструмент заявок: добавляется к тула персонажа, не хранится в БД.
    if (scene.config.allowToolRequests) {
      toolSpecs.push({ ...REQUEST_TOOL_SPEC, parameters: { ...REQUEST_TOOL_SPEC.parameters } });
    }
    // Заявление о скрытой характеристике: доступно, когда в мире есть скрытое.
    const hiddenPresent = hasHiddenAttributes();
    if (hiddenPresent) {
      toolSpecs.push({ ...REVEAL_TOOL_SPEC, parameters: { ...REVEAL_TOOL_SPEC.parameters } });
    }
    // Одежда: доступна, когда в реестре есть слоты.
    const clothingPresent = listClothingSlots().length > 0;
    if (clothingPresent) {
      toolSpecs.push(
        { ...UNDRESS_SPEC, parameters: { ...UNDRESS_SPEC.parameters } },
        { ...WEAR_SPEC, parameters: { ...WEAR_SPEC.parameters } }
      );
    }
    // Места: go_to/invite доступны, когда в реестре есть хоть одно место.
    if (listPlaces().length > 0) {
      toolSpecs.push(
        { ...GO_SPEC, parameters: { ...GO_SPEC.parameters } },
        { ...INVITE_SPEC, parameters: { ...INVITE_SPEC.parameters } }
      );
    }
    // Виртуальные тулы магазина: появляются, когда в магазине есть товары.
    const products = listProducts();
    const shopAvailable = products.length > 0;
    if (shopAvailable) {
      toolSpecs.push(
        { ...SHOP_BROWSE_SPEC, parameters: { ...SHOP_BROWSE_SPEC.parameters } },
        { ...SHOP_BUY_SPEC, parameters: { ...SHOP_BUY_SPEC.parameters } }
      );
    }

    const visible = getVisibleEvents(sceneId, character.id, scene.config.contextEvents);
    const goals = getSceneGoals(sceneId);
    const nameOf = (id: number) => participants.find((p) => p.id === id)?.name ?? `#${id}`;
    const messages = buildMessages({
      character,
      scene,
      participants,
      events: visible,
      turn: turnNo,
      goal: goals[character.id] ?? null,
      hasPricedTools:
        tools.some((t) => t.cost > 0) || typeof character.state.money === "number",
      hasShop: shopAvailable,
      attributeDefs: listAttributes(),
      relations: listRelationsOf(character.id).map((r) => ({ ...r, name: nameOf(r.toId) })),
      knowledge: knowledgeOf(character.id),
      hasHiddenAttributes: hiddenPresent,
      hasClothing: clothingPresent,
    });

    run.abort = new AbortController();
    const maxIter = Math.max(1, scene.config.maxIterPerTurn);
    let iteration = 0;
    let callSeq = 0;
    const genCallId = () => `call_${Date.now().toString(36)}_${turnNo}_${callSeq++}`;

    while (iteration < maxIter) {
      if (iteration > 0 && !alive()) break;

      // Бюджет сцены: не даём агентам жечь токены без присмотра.
      const budgetScene = getScene(sceneId);
      if (budgetScene) {
        const { maxApiCallsPerScene, maxTokensPerScene } = budgetScene.config;
        if (
          (maxApiCallsPerScene > 0 && budgetScene.spentApiCalls >= maxApiCallsPerScene) ||
          (maxTokensPerScene > 0 && budgetScene.spentTokens >= maxTokensPerScene)
        ) {
          const what =
            maxApiCallsPerScene > 0 && budgetScene.spentApiCalls >= maxApiCallsPerScene
              ? `вызовов API (${budgetScene.spentApiCalls}/${maxApiCallsPerScene})`
              : `токенов (${budgetScene.spentTokens}/${maxTokensPerScene})`;
          run.status = "paused";
          run.abort?.abort();
          this.runs.delete(sceneId);
          setSceneStatus(sceneId, "paused");
          getHub().emitEvent(
            appendEvent(db, sceneId, turnNo, "system", null, "all", {
              message: `Бюджет сцены исчерпан: ${what}. Сцена на паузе — поднимите лимиты в настройках, чтобы продолжить.`,
            })
          );
          this.emitStatus(sceneId);
          return "aborted";
        }
      }

      let completion;
      const started = Date.now();
      try {
        completion = await chatCompletion({
          provider,
          model: character.model || "mock-actor",
          messages,
          tools: toolSpecs.length > 0 ? toolSpecs : undefined,
          temperature: character.temperature,
          maxTokens: character.maxTokens,
          signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
          mockContext: {
            actor: character.name,
            others: participants.filter((p) => p.id !== character.id).map((p) => p.name),
            tools: toolSpecs.map((t) => t.name),
            shopItems: products.map((p) => p.name),
          },
        });
        appendApiLog(db, {
          sceneId,
          characterId: character.id,
          turn: turnNo,
          iteration,
          model: `${provider.name}:${character.model}`,
          requestJson: JSON.stringify({ model: character.model, messages, tools: toolSpecs }),
          responseJson: JSON.stringify(completion.raw),
          error: null,
          latencyMs: Date.now() - started,
        });
        // Учёт расхода: +1 вызов, +токены из usage (если провайдер их отдаёт).
        const usage = completion.usage;
        incrementSceneSpend(
          sceneId,
          1,
          (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)
        );
      } catch (e) {
        // Пользовательский abort (пауза/стоп) — это не ошибка; таймаут — ошибка.
        const aborted = run.abort.signal.aborted;
        appendApiLog(db, {
          sceneId,
          characterId: character.id,
          turn: turnNo,
          iteration,
          model: `${provider.name}:${character.model}`,
          requestJson: JSON.stringify({ model: character.model, messages, tools: toolSpecs }),
          responseJson: null,
          error: e instanceof Error ? e.message : String(e),
          latencyMs: Date.now() - started,
        });
        if (!aborted) {
          getHub().emitEvent(
            appendEvent(db, sceneId, turnNo, "system", character.id, "all", {
              message: `Ошибка вызова модели (${character.name}): ${
                e instanceof Error ? e.message : String(e)
              }`.slice(0, 2000),
            })
          );
        }
        return aborted ? "aborted" : "error";
      }

      const msg = completion.message;
      const content = typeof msg.content === "string" ? msg.content.trim() : "";

      // Битые tool_calls (без function/name) отбрасываем — протокол важнее.
      const rawCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls.filter(
            (tc) => tc && typeof tc.function?.name === "string" && tc.function.name
          )
        : [];
      if (Array.isArray(msg.tool_calls) && rawCalls.length < msg.tool_calls.length) {
        getHub().emitEvent(
          appendEvent(db, sceneId, turnNo, "system", character.id, "all", {
            message: `Отброшено некорректных tool_calls: ${msg.tool_calls.length - rawCalls.length}`,
          })
        );
      }

      // Аргументы парсим заранее: модели часто дублируют — одна и та же фраза
      // и репликой (content), и аргументом тула (напр. text у send_message).
      // Реплику-дубль не записываем: текст уже доставлен наблюдением тула,
      // иначе он попадал бы в контекст дважды (и актёру, и наблюдателям).
      const parsedCalls = rawCalls.map((tc) => ({
        tc,
        parsed: parseToolArguments(tc.function.arguments ?? ""),
      }));
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      const dupInCall =
        content.length >= 20 &&
        parsedCalls.some(({ parsed }) =>
          Object.values(parsed.args).some(
            (v) => typeof v === "string" && v.length >= 20 && norm(v) === norm(content)
          )
        );

      if (content && !dupInCall) {
        getHub().emitEvent(
          appendEvent(db, sceneId, turnNo, "speech", character.id, "all", { text: content })
        );
      }

      if (rawCalls.length > 0) {
        const executed: ActionCall[] = [];
        const stateChanges: { characterId: number; key: string; value: unknown }[] = [];
        const relationChanges: { fromId: number; toId: number; value: number }[] = [];

        for (const { tc, parsed } of parsedCalls) {
          const callId = (tc.id && String(tc.id).trim()) || genCallId();
          const toolName = tc.function.name;
          const tool = tools.find((t) => t.name === toolName);
          const { args, error } = parsed;
          let callResult: ActionCall;
          if (toolName === REQUEST_TOOL_NAME) {
            // Заявка на новый инструмент: скрытое действие, очередь на одобрение.
            const handled = handleToolRequestCall({
              sceneId,
              characterId: character.id,
              callId,
              args,
            });
            callResult = handled.call;
            if (handled.created) getHub().emitToolRequests(sceneId);
          } else if (
            toolName === SHOP_BROWSE_TOOL ||
            toolName === SHOP_BUY_TOOL ||
            toolName === REVEAL_TOOL_NAME ||
            toolName === UNDRESS_TOOL_NAME ||
            toolName === WEAR_TOOL_NAME ||
            toolName === GO_TOOL_NAME ||
            toolName === INVITE_TOOL_NAME
          ) {
            // Виртуальные тулы (магазин/заявления/одежда): не хранятся в БД.
            const fresh = getCharacter(character.id) ?? character;
            const vir = this.runVirtualTool(sceneId, turnNo, fresh, participants, toolName, args);
            callResult = vir.call;
            stateChanges.push(...vir.stateChanges);
            relationChanges.push(...vir.relationChanges);
          } else if (!tool) {
            const available = tools.map((t) => t.name).join(", ") || "(нет)";
            callResult = {
              callId,
              toolName,
              args,
              ok: false,
              result: `Неизвестный инструмент "${toolName}". Доступны: ${available}`,
              observation: "",
              audience: "none",
            };
          } else if (error) {
            callResult = {
              callId,
              toolName,
              args,
              ok: false,
              result: `Ошибка в аргументах: ${error}`,
              observation: "",
              audience: "none",
            };
          } else {
            const freshChar = getCharacter(character.id) ?? character;
            const ex = executeTool({ tool, actor: freshChar, participants, args, scene });
            relationChanges.push(...ex.relationChanges);
            // Анти-спам: то же действие те же параметры несколько раз подряд.
            const repeatKey = `${toolName}|${JSON.stringify(args)}`;
            const repeats = recentRepeatCount(db, sceneId, character.id, repeatKey);
            let result = ex.result;
            if (repeats >= 1) {
              result += " (Внимание: ты уже делал ровно это только что — не повторяй одно и то же действие, разнообразь ход.)";
            }
            callResult = {
              callId,
              toolName,
              args,
              ok: ex.ok,
              result,
              observation: ex.observation,
              audience: ex.audience,
              outcome: ex.outcome?.outcomeId,
            };
            stateChanges.push(...ex.stateChanges);
            // Сработавший исход: заметка доставляется цели лично, от лица мира.
            if (ex.outcome) {
              getHub().emitEvent(
                appendEvent(db, sceneId, turnNo, "director", null, [ex.outcome.targetId], {
                  text: ex.outcome.noticeTarget,
                })
              );
            }
            // Рост навыка — событие лично актёру: уровень скрыт от партнёров.
            for (const up of ex.skillUps ?? []) {
              getHub().emitEvent(
                appendEvent(db, sceneId, turnNo, "system", character.id, [character.id], {
                  message: `Практика: навык «${up.label}» вырос до уровня ${up.toLevel}/${up.maxLevel} — ты чувствуешь, что начинает получаться лучше.`,
                })
              );
            }
            if (repeats + 1 >= REPEAT_SPAM_THRESHOLD) {
              // Спам: записываем действие, но глушим сцену.
              const audience0 = ex.audience;
              getHub().emitEvent(
                appendEvent(db, sceneId, turnNo, "action", character.id, audience0, {
                  iteration,
                  calls: [callResult],
                  stateChanges: stateChanges.length > 0 ? stateChanges : undefined,
                  relationChanges: relationChanges.length > 0 ? relationChanges : undefined,
                })
              );
              getHub().emitEvent(
                appendEvent(db, sceneId, turnNo, "system", null, "all", {
                  message: `Спам-защита: ${character.name} повторил одно и то же действие ${repeats + 1} раз подряд — сцена поставлена на паузу.`,
                })
              );
              run.status = "paused";
              run.abort?.abort();
              this.runs.delete(sceneId);
              setSceneStatus(sceneId, "paused");
              this.emitStatus(sceneId);
              return "aborted";
            }
          }
          executed.push(callResult);
        }

        const audience = mergeAudiences(executed.map((c) => c.audience));
        getHub().emitEvent(
          appendEvent(db, sceneId, turnNo, "action", character.id, audience, {
            iteration,
            calls: executed,
            stateChanges: stateChanges.length > 0 ? stateChanges : undefined,
            relationChanges: relationChanges.length > 0 ? relationChanges : undefined,
          })
        );
        if (stateChanges.length > 0) getHub().emitParticipants(sceneId);

        // Протокол OpenAI: один assistant (content + tool_calls), затем tool-ответы
        // с теми же id. Реплика выше уже записана событием, здесь — один раз.
        // Дубль-реплику (== аргументу тула) в живой протокол не кладём.
        messages.push({
          role: "assistant",
          content: content && !dupInCall ? msg.content : null,
          tool_calls: executed.map((c, i) => ({
            id: c.callId,
            type: "function" as const,
            function: {
              name: rawCalls[i].function.name,
              arguments: rawCalls[i].function.arguments ?? "{}",
            },
          })),
        });
        for (const c of executed) {
          messages.push({
            role: "tool",
            tool_call_id: c.callId,
            name: c.toolName,
            content: c.result,
          });
        }
        iteration += 1;
        // Небольшая пауза между итерациями — чтобы модель не молотила запросы.
        await this.sleep(ITER_DELAY_MS, run);
        continue; // даём модели возможность добавить реплику после действия
      }

      if (!content) {
        getHub().emitEvent(
          appendEvent(db, sceneId, turnNo, "system", character.id, "all", {
            message: `Модель ${character.name} вернула пустой ответ без действий.`,
          })
        );
      }
      break;
    }
    return "ok";
  }

  /** Вставка события от режиссёра (пользователя). */
  inject(sceneId: number, text: string, audience: Audience): SimEvent {
    const rt = this.getRuntime(sceneId);
    const turn = rt.turn + (rt.status === "running" ? 1 : 0);
    const ev = appendEvent(getDb(), sceneId, turn, "director", null, audience, {
      text,
    });
    getHub().emitEvent(ev);
    return ev;
  }

  /**
   * Реплика от лица персонажа, управляемого человеком
   * (или ручное управление ИИ-персонажем). Видна всем участникам.
   * Если сцена на паузе (пауза круга или ручная) — сама продолжается:
   * отправил сообщение — жди ответа, «Продолжить» давить не нужно.
   */
  say(sceneId: number, characterId: number, text: string): SimEvent {
    const character = requireSceneCharacter(sceneId, characterId);
    const rt = this.getRuntime(sceneId);
    const turn = rt.turn + (rt.status === "running" ? 1 : 0);
    const ev = appendEvent(
      getDb(),
      sceneId,
      turn,
      "speech",
      character.id,
      "all",
      { text }
    );
    getHub().emitEvent(ev);
    this.autoResume(sceneId);
    return ev;
  }

  /**
   * Автопродолжение после хода человека: пауза → resume, idle (ещё не
   * запускалась) → start, чтобы первое сообщение сразу получило ответ.
   * «finished» не трогаем — продолжение сверх лимита ходов остаётся
   * решением режиссёра. Ошибки (нет провайдера) гасим молча.
   */
  private autoResume(sceneId: number): void {
    const scene = getScene(sceneId);
    if (!scene) return;
    try {
      if (scene.status === "paused") this.resume(sceneId);
      else if (scene.status === "idle") this.start(sceneId);
    } catch {
      // нет провайдера/ИИ-участников — молча остаёмся на месте
    }
  }

  /**
   * Виртуальные тулы (магазин/заявления/одежда): не хранятся в БД и доступны
   * всем участникам без привязки в toolIds. Единый путь для модельного
   * вызова и ручного act — правила денег/одежды/заявлений не обходятся.
   */
  private runVirtualTool(
    sceneId: number,
    turn: number,
    character: Character,
    participants: Character[],
    toolName: string,
    args: Record<string, unknown>
  ): {
    call: ActionCall;
    stateChanges: { characterId: number; key: string; value: unknown }[];
    relationChanges: { fromId: number; toId: number; value: number }[];
  } {
    const callId = `vt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    const none = { call: null as unknown as ActionCall, stateChanges: [], relationChanges: [] };

    if (toolName === SHOP_BROWSE_TOOL || toolName === SHOP_BUY_TOOL) {
      // Магазин существует, только пока в нём есть товары: без них вызов
      // (модель могла угадать имя) — отказ, а не пустая витрина.
      if (listProducts().length === 0) {
        return {
          call: {
            callId,
            toolName,
            args,
            ok: false,
            result: "Магазина в этом мире нет — покупать нечего.",
            observation: "",
            audience: "none",
          },
          stateChanges: [],
          relationChanges: [],
        };
      }
    }
    if (toolName === SHOP_BROWSE_TOOL) {
      // Витрина магазина: только самому агенту.
      return {
        call: {
          callId,
          toolName,
          args,
          ok: true,
          result: buildCatalogText(character),
          observation: "",
          audience: [character.id],
        },
        stateChanges: [],
        relationChanges: [],
      };
    }
    if (toolName === SHOP_BUY_TOOL) {
      const ex = executeShopBuy({ actor: character, participants, args, sceneId });
      return {
        call: {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
        },
        stateChanges: ex.stateChanges,
        relationChanges: ex.relationChanges,
      };
    }
    if (toolName === REVEAL_TOOL_NAME) {
      const ex = executeReveal({ actor: character, participants, args });
      return {
        call: {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
        },
        stateChanges: [],
        relationChanges: [],
      };
    }
    if (toolName === UNDRESS_TOOL_NAME) {
      const ex = executeUndress({ sceneId, turn, actor: character, participants, args });
      return {
        call: {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
        },
        stateChanges: ex.stateChanges,
        relationChanges: [],
      };
    }
    if (toolName === GO_TOOL_NAME) {
      const ex = executeGoTo({ sceneId, actor: character, args });
      return {
        call: {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
        },
        stateChanges: [],
        relationChanges: [],
      };
    }
    if (toolName === INVITE_TOOL_NAME) {
      const ex = executeInvite({ sceneId, actor: character, participants, args });
      return {
        call: {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
        },
        stateChanges: [],
        relationChanges: [],
      };
    }
    if (toolName === WEAR_TOOL_NAME) {
      const ex = executeWear({ actor: character, args });
      return {
        call: {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
        },
        stateChanges: ex.stateChanges,
        relationChanges: [],
      };
    }
    return none;
  }

  /**
   * Ручной вызов инструмента от лица персонажа: те же валидация,
   * границы, эффекты на state и событие с аудиторией, что и у ИИ.
   * iteration = -1, чтобы реконструкция контекста не склеивала
   * ручные действия с модельными вызовами того же хода.
   */
  act(
    sceneId: number,
    characterId: number,
    toolName: string,
    args: Record<string, unknown>
  ): { event: SimEvent; ok: boolean; result: string } {
    const scene = getScene(sceneId);
    if (!scene) throw new Error("Сцена не найдена");
    const character = requireSceneCharacter(sceneId, characterId);
    const participants = getSceneParticipants(sceneId)
      .map((id) => getCharacter(id))
      .filter((c): c is Character => c !== null);
    const rt = this.getRuntime(sceneId);
    const turn = rt.turn + (rt.status === "running" ? 1 : 0);

    // Виртуальные тулы доступны всем и без привязки в toolIds.
    if (
      toolName === SHOP_BROWSE_TOOL ||
      toolName === SHOP_BUY_TOOL ||
      toolName === REVEAL_TOOL_NAME ||
      toolName === UNDRESS_TOOL_NAME ||
      toolName === WEAR_TOOL_NAME ||
      toolName === GO_TOOL_NAME ||
      toolName === INVITE_TOOL_NAME
    ) {
      const vir = this.runVirtualTool(sceneId, turn, character, participants, toolName, args);
      const ev = appendEvent(getDb(), sceneId, turn, "action", character.id, vir.call.audience, {
        iteration: -1,
        calls: [vir.call],
        stateChanges: vir.stateChanges.length > 0 ? vir.stateChanges : undefined,
        relationChanges: vir.relationChanges.length > 0 ? vir.relationChanges : undefined,
      });
      getHub().emitEvent(ev);
      if (vir.stateChanges.length > 0 || vir.relationChanges.length > 0)
        getHub().emitParticipants(sceneId);
      this.autoResume(sceneId);
      return { event: ev, ok: vir.call.ok, result: vir.call.result };
    }

    const tools = getToolsByIds(character.toolIds);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      const available = tools.map((t) => t.name).join(", ") || "(нет инструментов у персонажа)";
      throw new Error(`Инструмент "${toolName}" недоступен персонажу. Доступны: ${available}`);
    }

    const ex = executeTool({ tool, actor: character, participants, args, scene });
    const callId = `manual_${Date.now().toString(36)}`;
    const ev = appendEvent(getDb(), sceneId, turn, "action", character.id, ex.audience, {
      iteration: -1,
      calls: [
        {
          callId,
          toolName,
          args,
          ok: ex.ok,
          result: ex.result,
          observation: ex.observation,
          audience: ex.audience,
          outcome: ex.outcome?.outcomeId,
        },
      ],
      stateChanges: ex.stateChanges.length > 0 ? ex.stateChanges : undefined,
      relationChanges: ex.relationChanges.length > 0 ? ex.relationChanges : undefined,
    });
    getHub().emitEvent(ev);
    // Исход и рост навыка при ручном действии — те же личные уведомления, что и у ИИ.
    if (ex.outcome) {
      getHub().emitEvent(
        appendEvent(getDb(), sceneId, turn, "director", null, [ex.outcome.targetId], {
          text: ex.outcome.noticeTarget,
        })
      );
    }
    // Рост навыка при ручном действии — то же личное уведомление, что и у ИИ.
    for (const up of ex.skillUps ?? []) {
      getHub().emitEvent(
        appendEvent(getDb(), sceneId, turn, "system", character.id, [character.id], {
          message: `Практика: навык «${up.label}» вырос до уровня ${up.toLevel}/${up.maxLevel} — ты чувствуешь, что начинает получаться лучше.`,
        })
      );
    }
    if (ex.stateChanges.length > 0 || ex.relationChanges.length > 0)
      getHub().emitParticipants(sceneId);
    this.autoResume(sceneId);
    return { event: ev, ok: ex.ok, result: ex.result };
  }
}

function requireSceneCharacter(sceneId: number, characterId: number): Character {
  const scene = getScene(sceneId);
  if (!scene) throw new Error("Сцена не найдена");
  if (!getSceneParticipants(sceneId).includes(characterId))
    throw new Error("Персонаж не участвует в этой сцене");
  const character = getCharacter(characterId);
  if (!character) throw new Error("Персонаж не найден");
  return character;
}

/** id ИИ-персонажей сцены (люди в ротацию ходов не попадают). */
function aiParticipantIds(sceneId: number): number[] {
  return getSceneParticipants(sceneId).filter((id) => {
    const c = getCharacter(id);
    return c != null && !c.isHuman;
  });
}

function mergeAudiences(list: Audience[]): Audience {
  const ids = new Set<number>();
  let sawAll = false;
  for (const a of list) {
    if (a === "all") sawAll = true;
    else if (Array.isArray(a)) a.forEach((id) => ids.add(id));
  }
  if (sawAll) return "all";
  if (ids.size === 0) return "none";
  return [...ids];
}

/**
 * Сколько последних подряд идущих действий персонажа совпадают с ключом
 * `tool|args` — для анти-спам защиты.
 */
function recentRepeatCount(
  db: ReturnType<typeof getDb>,
  sceneId: number,
  actorId: number,
  key: string
): number {
  const rows = db
    .prepare(
      "SELECT payload FROM events WHERE scene_id = ? AND actor_id = ? AND type = 'action' ORDER BY id DESC LIMIT 8"
    )
    .all(sceneId, actorId) as unknown as { payload: string }[];
  let count = 0;
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload) as { calls?: { toolName: string; args: unknown }[] };
      const matches = (payload.calls ?? []).some(
        (c) => `${c.toolName}|${JSON.stringify(c.args)}` === key
      );
      if (matches) count += 1;
      else break;
    } catch {
      break;
    }
  }
  return count;
}

const g = globalThis as unknown as { __simEngine?: Engine };

export function getEngine(): Engine {
  if (!g.__simEngine) g.__simEngine = new Engine();
  return g.__simEngine;
}
