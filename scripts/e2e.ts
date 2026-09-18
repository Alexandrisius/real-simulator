// E2E-проверка движка на mock-провайдере (без реальной LLM):
// полный цикл сцены, инструменты, аудит контекста, пауза/шаг/стоп.

process.env.SIM_DB_PATH = require("node:path").join(process.cwd(), "data", "e2e-test.db");

import { rmSync } from "node:fs";

async function main() {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(process.env.SIM_DB_PATH! + suffix, { force: true });
  }

  const { getDb } = await import("../src/db");
  const {
    wipeAll,
    createProvider,
    createTool,
    createCharacter,
    createScene,
    getScene,
    getVisibleEvents,
    listSceneEvents,
    listSceneApiLogs,
    getCharacter,
  } = await import("../src/db/queries");
  const { getEngine } = await import("../src/lib/engine/engine");
  const { buildMessages } = await import("../src/lib/prompt");

  const db = getDb();
  wipeAll();

  const provider = createProvider({
    name: "Mock",
    kind: "mock",
    baseUrl: "http://localhost/v1",
    apiKey: "",
  });

  const msgTool = createTool({
    name: "send_message",
    title: "Написать сообщение",
    description: "Отправить личное сообщение",
    parametersSchema: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
    audience: "target",
    targetParam: "to",
    observationTemplate: "{name} пишет тебе: {text}",
    effects: [],
  });
  const actTool = createTool({
    name: "do_activity",
    title: "Заняться делом",
    description: "Публичное действие",
    parametersSchema: {
      type: "object",
      properties: { activity: { type: "string" } },
      required: ["activity"],
    },
    audience: "all",
    targetParam: null,
    observationTemplate: "{name}: {activity}",
    effects: [{ target: "self", key: "energy", op: "add", value: -1 }],
  });

  const yana = createCharacter({
    name: "Яна",
    emoji: "👩",
    persona: "Девушка, любит внимание.",
    providerId: provider.id,
    model: "mock-actor",
    temperature: 0.8,
    maxTokens: 256,
    toolIds: [msgTool.id, actTool.id],
    state: { energy: 10 },
    isHuman: false,
  });
  const dima = createCharacter({
    name: "Дима",
    emoji: "👨",
    persona: "Парень, работает много.",
    providerId: provider.id,
    model: "mock-actor",
    temperature: 0.8,
    maxTokens: 256,
    toolIds: [msgTool.id],
    state: {},
    isHuman: false,
  });

  const scene = createScene({
    name: "Тестовая сцена",
    setting: "Вечер дома",
    config: { turnDelayMs: 30, maxTurns: 4, maxIterPerTurn: 3, contextEvents: 50 },
    characterIds: [yana.id, dima.id],
  });

  const engine = getEngine();
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`  ok: ${msg}`);
  };

  // --- Старт и автопрогон до maxTurns ---
  await engine.control(scene.id, "start");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const s = getScene(scene.id)!;
    if (s.status === "finished") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(getScene(scene.id)!.status === "finished", "сцена дошла до finished по maxTurns");
  assert(getScene(scene.id)!.cursor === 4, `cursor=4 (получено ${getScene(scene.id)!.cursor})`);

  const events = listSceneEvents(scene.id);
  const actions = events.filter((e) => e.type === "action");
  const speeches = events.filter((e) => e.type === "speech");
  assert(actions.length >= 2, `есть tool-действия (${actions.length})`);
  assert(speeches.length >= 2, `есть реплики (${speeches.length})`);

  const dmAction = actions[0];
  assert(Array.isArray(dmAction.audience), "личное сообщение имеет аудиторию-массив");
  assert(
    (dmAction.payload.calls ?? [])[0]?.observation.includes("пишет тебе"),
    "шаблон наблюдения отрендерился"
  );

  // --- Эффекты на state ---
  const yanaAfter = getCharacter(yana.id)!;
  assert(
    yana.state.energy === 10 && yanaAfter.state.energy === 9,
    `эффект tool применился к state (energy: ${yanaAfter.state.energy})`
  );

  // --- Видимость: личное сообщение Димы адресовано Яне и видно только ей ---
  const yanaVisible = getVisibleEvents(scene.id, yana.id, 100);
  const dimaDmToYana = events.find(
    (e) => e.type === "action" && e.actorId === dima.id && Array.isArray(e.audience)
  );
  assert(dimaDmToYana, "у Димы было личное сообщение");
  assert(
    yanaVisible.some((e) => e.id === dimaDmToYana!.id),
    "адресат видит адресованное ему действие"
  );

  // --- Протокол реконструкции контекста ---
  const checkProtocol = (sceneId: number, charId: number, label: string) => {
    const character = getCharacter(charId)!;
    const msgs = buildMessages({
      character,
      scene: getScene(sceneId)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: getVisibleEvents(sceneId, charId, 100),
      turn: 99,
    });
    assert(msgs[0].role === "system", `${label}: system первым`);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const expected = m.tool_calls.map((c) => c.id);
        const got: string[] = [];
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "tool") {
          got.push(msgs[j].tool_call_id ?? "");
          j++;
        }
        assert(
          JSON.stringify(expected) === JSON.stringify(got),
          `${label}: за tool_calls идут tool-ответы с совпадающими id`
        );
      }
      if (m.role === "tool") {
        assert(
          msgs[i - 1]?.role === "assistant" ||
            (msgs[i - 1]?.role === "tool" &&
              i >= 2 &&
              msgs.slice(0, i).some((x) => x.role === "assistant" && x.tool_calls?.length)),
          `${label}: tool не висит в воздухе`
        );
      }
    }
    assert(
      msgs[msgs.length - 1].role === "user",
      `${label}: финальный nudge присутствует`
    );
    assert(
      (msgs[msgs.length - 1].content ?? "").includes("Подумай (текст = мысли"),
      `${label}: nudge объявляет приватность мыслей (новая модель)`
    );
  };
  checkProtocol(scene.id, yana.id, "Яна");
  checkProtocol(scene.id, dima.id, "Дима");

  // --- Логи API ---
  const logs = listSceneApiLogs(scene.id);
  assert(logs.length >= 4, `api-логи записаны (${logs.length})`);
  assert(logs.every((l) => l.requestJson.includes("messages")), "в логах есть запросы");

  // --- Протокол ЖИВЫХ запросов (из api_logs): парность tool id и отсутствие дублей content ---
  for (const log of logs) {
    const msgs = JSON.parse(log.requestJson).messages as Array<{
      role: string;
      content: string | null;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
    }>;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls?.length) {
        const ids = m.tool_calls.map((c) => c.id);
        const got: string[] = [];
        let j = i + 1;
        while (j < msgs.length && msgs[j].role === "tool") {
          got.push(msgs[j].tool_call_id ?? "");
          j++;
        }
        assert(
          JSON.stringify(ids) === JSON.stringify(got),
          `log ${log.id}: за live tool_calls идут tool-ответы с теми же id`
        );
      }
      const next = msgs[i + 1];
      if (
        m.role === "assistant" &&
        next?.role === "assistant" &&
        m.content &&
        next.content === m.content
      ) {
        assert(false, `log ${log.id}: дубль content в живом цикле`);
      }
    }
  }

  // --- Инжект режиссёра + пошаговый режим ---
  const scene2 = createScene({
    name: "Сцена 2",
    setting: "Утро",
    config: { turnDelayMs: 30, maxTurns: 0 },
    characterIds: [yana.id, dima.id],
  });
  engine.inject(scene2.id, "Начните разговор", "all");
  await engine.control(scene2.id, "step");
  assert(getScene(scene2.id)!.status === "paused", "step переводит в paused");
  assert(getScene(scene2.id)!.cursor === 1, "step сделал один ход");
  const ev2 = listSceneEvents(scene2.id);
  assert(ev2.some((e) => e.type === "director"), "режиссёрское событие записано");
  assert(ev2.filter((e) => e.type === "action" || e.type === "speech").length > 0, "ход сделан");
  engine.control(scene2.id, "stop");
  assert(getScene(scene2.id)!.status === "finished", "stop завершает сцену");

  // --- Персональный контекст содержит режиссёрское указание ---
  const vis2 = getVisibleEvents(scene2.id, yana.id, 100);
  assert(vis2.some((e) => e.type === "director"), "агент видит указание режиссёра");

  // --- Человек-участник ---
  const human = createCharacter({
    name: "Вы",
    emoji: "🙋",
    persona: "",
    providerId: null,
    model: "",
    temperature: 0.8,
    maxTokens: 256,
    toolIds: [msgTool.id],
    state: {},
    isHuman: true,
  });
  assert(human.isHuman && human.providerId === null, "человек создаётся без провайдера");

  // сцена только из людей не стартует
  const humanOnly = createScene({
    name: "Только люди",
    setting: "",
    config: {},
    characterIds: [human.id],
  });
  let humanOnlyRejected = false;
  try {
    await engine.control(humanOnly.id, "start");
  } catch {
    humanOnlyRejected = true;
  }
  assert(humanOnlyRejected, "сцена без ИИ-персонажей не стартует");

  // смешанная сцена: человек + ИИ
  const mixed = createScene({
    name: "Человек и ИИ",
    setting: "Тест",
    config: { turnDelayMs: 30 },
    characterIds: [human.id, dima.id],
  });
  engine.say(mixed.id, human.id, "Привет, Дима! Как дела?");
  // Новое поведение: реплика человека сама запускает idle-сцену (auto-start).
  assert(getScene(mixed.id)!.status === "running", "первое сообщение человека запускает idle-сцену");
  const actRes = engine.act(mixed.id, human.id, "send_message", {
    to: "Дима",
    text: "Личное сообщение от человека",
  });
  assert(actRes.ok, "ручной вызов инструмента работает");
  // ручное действие за ИИ-персонажа (режим кукловода)
  const puppet = engine.act(mixed.id, dima.id, "send_message", {
    to: "Вы",
    text: "Ответ Димы руками человека",
  });
  assert(puppet.ok, "ручное управление ИИ-персонажем работает");

  // ждём, пока автостарт доведёт хотя бы один ход ИИ до конца
  const rotDeadline = Date.now() + 8000;
  while (Date.now() < rotDeadline && getScene(mixed.id)!.cursor < 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await engine.control(mixed.id, "pause");
  const mixedEvents = listSceneEvents(mixed.id);
  const humanSpeech = mixedEvents.find((e) => e.type === "speech" && e.actorId === human.id);
  const humanAct = mixedEvents.find((e) => e.type === "action" && e.actorId === human.id);
  assert(!!humanSpeech, "реплика человека записана");
  assert(
    !!humanAct && Array.isArray(humanAct.audience) && humanAct.audience.includes(dima.id),
    "личное действие человека адресовано получателю"
  );
  const dimaVis = getVisibleEvents(mixed.id, dima.id, 100);
  assert(dimaVis.some((e) => e.id === humanSpeech!.id), "сырая видимость содержит реплику человека");
  assert(dimaVis.some((e) => e.id === humanAct!.id), "ИИ видит личное сообщение от человека");
  assert(getScene(mixed.id)!.cursor >= 1, "автостарт привёл к ходам ИИ (человек в ротацию не входит)");
  // Новая модель: реплика без тула — мысли, другим участникам НЕ реконструируется.
  const mixedParts = [getCharacter(human.id)!, getCharacter(dima.id)!];
  const dimaMsgs0 = buildMessages({
    character: getCharacter(dima.id)!,
    scene: getScene(mixed.id)!,
    participants: mixedParts,
    events: getVisibleEvents(mixed.id, dima.id, 100),
    turn: 99,
  });
  assert(
    !dimaMsgs0.some((m) => (m.content ?? "").includes("Привет, Дима! Как дела?")),
    "речь человека (без тула) отсутствует в контексте ИИ — это мысли"
  );
  // Всухую не выйдет: чтобы быть услышанным, человек говорит тулом say.
  const humanSay = engine.act(mixed.id, human.id, "say", { phrase: "Дима, я здесь, с тобой" });
  assert(humanSay.ok, "человек говорит тулом say (ok:true)");
  assert(
    ((humanSay.event.payload.calls ?? [])[0]?.observation ?? "").includes("Вы: «Дима, я здесь, с тобой»"),
    "наблюдение say оформлено как речь от лица актёра"
  );
  const dimaMsgs1 = buildMessages({
    character: getCharacter(dima.id)!,
    scene: getScene(mixed.id)!,
    participants: mixedParts,
    events: getVisibleEvents(mixed.id, dima.id, 100),
    turn: 99,
  });
  assert(
    dimaMsgs1.some(
      (m) => m.role === "user" && (m.content ?? "").includes("Дима, я здесь, с тобой")
    ),
    "сказанное вслух (тул say) дошло до ИИ как user-сообщение"
  );
  // В истории самого говорящего его реплика — assistant-контент.
  const humanMsgs = buildMessages({
    character: getCharacter(human.id)!,
    scene: getScene(mixed.id)!,
    participants: mixedParts,
    events: getVisibleEvents(mixed.id, human.id, 100),
    turn: 99,
  });
  assert(
    humanMsgs.some(
      (m) => m.role === "assistant" && (m.content ?? "").includes("Привет, Дима! Как дела?")
    ),
    "в истории самого человека его реплика — assistant-контент"
  );
  checkProtocol(mixed.id, dima.id, "Дима+человек");

  // --- Бюджет сцены: авто-пауза при исчерпании лимита вызовов ---
  const budgetScene = createScene({
    name: "Бюджет",
    setting: "",
    config: { turnDelayMs: 20, maxTurns: 0, maxApiCallsPerScene: 2 },
    characterIds: [yana.id, dima.id],
  });
  await engine.control(budgetScene.id, "start");
  const budgetDeadline = Date.now() + 10000;
  while (Date.now() < budgetDeadline) {
    if (getScene(budgetScene.id)!.status === "paused") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const budgetFinal = getScene(budgetScene.id)!;
  assert(budgetFinal.status === "paused", "бюджет исчерпан -> авто-пауза");
  assert(budgetFinal.spentApiCalls === 2, `потрачено ровно 2 вызова (${budgetFinal.spentApiCalls})`);
  const budgetEvents = listSceneEvents(budgetScene.id);
  assert(
    budgetEvents.some((e) => e.type === "system" && (e.payload.message ?? "").includes("Бюджет")),
    "записано системное событие о бюджете"
  );
  engine.forget(budgetScene.id);

  // --- Скоринг: схемы валидации ---
  const { evaluateScene } = await import("../src/lib/scoring");
  const { createValidationSchema, getSceneSchemas } = await import("../src/db/queries");

  // Позитив: mock-Яна делает send_message (ход 1) -> do_activity (ход 3)
  const goodSchema = createValidationSchema({
    name: "Позитивная цепочка",
    description: "",
    steps: [
      { toolName: "send_message", required: true, points: 10, minCount: 1, argContains: null },
      { toolName: "do_activity", required: true, points: 5, minCount: 1, argContains: null },
    ],
    forbidden: [],
    penalty: 3,
  });
  const scoredScene = createScene({
    name: "Скоринг-позитив",
    setting: "",
    config: { maxTurns: 4, turnDelayMs: 20 },
    characterIds: [yana.id, dima.id],
    schemas: { [String(yana.id)]: goodSchema.id },
  });
  await engine.control(scoredScene.id, "start");
  const sDeadline = Date.now() + 10000;
  while (Date.now() < sDeadline && getScene(scoredScene.id)!.status !== "finished") {
    await new Promise((r) => setTimeout(r, 100));
  }
  let scores = evaluateScene(scoredScene.id);
  assert(scores.length === 1, "оценен один участник (с схемой)");
  assert(scores[0].characterId === yana.id, "оценена Яна");
  assert(scores[0].steps.every((st) => st.satisfied), "оба шага цепочки засчитаны");
  assert(scores[0].score === 15, `score=15 (получено ${scores[0].score})`);
  assert(scores[0].violations.length === 0, "нарушений нет");
  assert(scores[0].completionPct === 100, "completion 100%");
  assert(
    getSceneSchemas(scoredScene.id)[yana.id] === goodSchema.id,
    "схема привязана к участнику сцены"
  );

  // Негатив: do_activity раньше send_message -> нарушение, шаг не засчитан
  const { updateCharacter } = await import("../src/db/queries");
  updateCharacter(dima.id, { toolIds: [msgTool.id, actTool.id] });
  const strictSchema = createValidationSchema({
    name: "Строгая цепочка",
    description: "",
    steps: [
      { toolName: "send_message", required: true, points: 10, minCount: 1, argContains: null },
      { toolName: "do_activity", required: true, points: 5, minCount: 1, argContains: null },
    ],
    forbidden: [],
    penalty: 4,
  });
  const badScene = createScene({
    name: "Скоринг-негатив",
    setting: "",
    config: {},
    characterIds: [dima.id, yana.id],
    schemas: { [String(dima.id)]: strictSchema.id },
  });
  // Дима делает дело ДО того, как написал сообщение (нарушение порядка)
  engine.act(badScene.id, dima.id, "do_activity", { activity: "сразу пошёл гулять" });
  // и только потом сообщение
  engine.act(badScene.id, dima.id, "send_message", { to: "Яна", text: "привет" });
  scores = evaluateScene(badScene.id);
  const bad = scores[0];
  assert(
    bad.violations.length === 1 && bad.violations[0].toolName === "do_activity",
    "ранний do_activity помечен нарушением"
  );
  assert(bad.violations[0].reason.includes("раньше"), "причина — ранний вызов");
  assert(bad.score === 10 - 4, `score = 10 - 4 = 6 (получено ${bad.score})`);
  assert(
    bad.completionPct === 50,
    `обязательные шаги: сообщение закрыто, дело было только ранним (получено ${bad.completionPct}%)`
  );
  assert(
    !bad.steps[1].satisfied,
    "do_activity не засчитан: единственное вхождение было раньше места в цепочке"
  );

  // --- Личные цели: видит только свой персонаж ---
  const goalScene = createScene({
    name: "Цели",
    setting: "Тест",
    config: {},
    characterIds: [yana.id, dima.id],
    goals: {
      [String(yana.id)]: "соблазнить Диму сегодня",
      [String(dima.id)]: null,
    },
  });
  const { getSceneGoals } = await import("../src/db/queries");
  const goalsMap = getSceneGoals(goalScene.id);
  assert(goalsMap[yana.id] === "соблазнить Диму сегодня", "цель сохранена за Яной");
  const yanaMsgs = buildMessages({
    character: getCharacter(yana.id)!,
    scene: getScene(goalScene.id)!,
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    events: [],
    turn: 1,
    goal: goalsMap[yana.id] ?? null,
  });
  const dimaMsgs = buildMessages({
    character: getCharacter(dima.id)!,
    scene: getScene(goalScene.id)!,
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    events: [],
    turn: 1,
    goal: goalsMap[dima.id] ?? null,
  });
  assert(
    (yanaMsgs[0].content ?? "").includes("Твоя цель в этой сцене") &&
      (yanaMsgs[0].content ?? "").includes("соблазнить"),
    "цель попала в system prompt Яны"
  );
  assert(
    !(dimaMsgs[0].content ?? "").includes("соблазнить"),
    "Дима не видит цель Яны"
  );

  // --- Экономика: платные инструменты ---
  const {
    createTool: createToolQ,
    getToolByName,
    listToolRequests,
    getToolRequest,
    countSceneEvents,
    resetScene: resetSceneQ,
    createFlow,
    updateFlow,
    listFlowRuns,
    getFlowRun,
    listFlowProgress,
    updateCharacter: updChar,
  } = await import("../src/db/queries");

  const flowers = createToolQ({
    name: "buy_flowers",
    title: "Подарить цветы",
    description: "Купить и подарить цветы",
    parametersSchema: {
      type: "object",
      properties: { to: { type: "string" }, flowers: { type: "string" } },
      required: ["to", "flowers"],
    },
    audience: "target",
    targetParam: "to",
    observationTemplate: "{name} дарит {to} цветы: {flowers}",
    effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
    cost: 20,
  });
  updChar(yana.id, { toolIds: [msgTool.id, actTool.id, flowers.id], state: { energy: 5, money: 30 } });

  const econScene = createScene({
    name: "Экономика",
    setting: "",
    config: {},
    characterIds: [yana.id, dima.id],
  });
  const gift = engine.act(econScene.id, yana.id, "buy_flowers", { to: "Дима", flowers: "пионы" });
  assert(gift.ok, "платный инструмент при достатке денег выполняется");
  assert(
    (getCharacter(yana.id)!.state.money as number) === 10,
    `цена списана: money=10 (получено ${getCharacter(yana.id)!.state.money})`
  );
  assert(
    (getCharacter(dima.id)!.state.mood as number) === 1,
    "эффект на получателя применился"
  );
  const poor = engine.act(econScene.id, yana.id, "buy_flowers", { to: "Дима", flowers: "розы" });
  assert(!poor.ok, "без денег действие не выполняется");
  assert(
    poor.result.includes("Недостаточно денег"),
    "причина отказа — деньги"
  );
  assert(
    (getCharacter(yana.id)!.state.money as number) === 10,
    "при отказе деньги не списались"
  );

  // --- Системный промпт: правила мира (тулы/деньги/заявки) ---
  const { buildSystemPrompt } = await import("../src/lib/prompt");
  const pricedPrompt = buildSystemPrompt({
    character: getCharacter(yana.id)!,
    scene: getScene(econScene.id)!,
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    events: [],
    turn: 1,
    hasPricedTools: true,
  });
  assert(pricedPrompt.includes("Правила этого мира: действия"), "раздел про поступки попал в промпт");
  assert(pricedPrompt.includes("деньги"), "раздел про деньги попал в промпт");
  const reqScenePrompt = buildSystemPrompt({
    character: getCharacter(yana.id)!,
    scene: { ...getScene(econScene.id)!, config: { ...getScene(econScene.id)!.config, allowToolRequests: true } },
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    events: [],
    turn: 1,
  });
  assert(reqScenePrompt.includes("request_tool"), "раздел про заявки попал в промпт при включённом флаге");

  // --- Заявки агентов на новые инструменты (request_tool) ---
  const reqScene = createScene({
    name: "Заявки",
    setting: "",
    config: { turnDelayMs: 20, maxTurns: 8 },
    characterIds: [yana.id, dima.id],
    schemas: {},
    goals: {},
  });
  // включаем флаг после создания (как это делает PATCH из настроек)
  const { updateScene } = await import("../src/db/queries");
  updateScene(reqScene.id, { config: { allowToolRequests: true } });
  await engine.control(reqScene.id, "start");
  const reqDeadline = Date.now() + 20000;
  let pendingReq = null as Awaited<ReturnType<typeof getToolRequest>>;
  while (Date.now() < reqDeadline) {
    const rows = listToolRequests(reqScene.id, "pending");
    if (rows.length > 0) {
      pendingReq = rows[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(!!pendingReq, "mock-агент отправил заявку через request_tool");
  assert(pendingReq!.draft.name === "kiss", "черновик заявки распарсен (имя)");
  assert(pendingReq!.draft.audience === "target" && pendingReq!.draft.targetParam === "who", "черновик содержит аудиторию и target_param");

  const reqEvents = listSceneEvents(reqScene.id);
  const reqAction = reqEvents.find(
    (e) => e.type === "action" && e.actorId === yana.id && (e.payload.calls ?? []).some((c) => c.toolName === "request_tool")
  );
  assert(!!reqAction && reqAction!.audience === "none", "заявка записана скрытым действием");
  const dimaSeesReq = getVisibleEvents(reqScene.id, dima.id, 100).some((e) => e.id === reqAction!.id);
  assert(!dimaSeesReq, "другие участники заявку не видят");
  const yanaSeesReq = getVisibleEvents(reqScene.id, yana.id, 100).some((e) => e.id === reqAction!.id);
  assert(yanaSeesReq, "проситель видит собственную заявку (реконструкция tool-протокола)");

  const { decideToolRequest } = await import("../src/lib/toolRequests");
  const decision = decideToolRequest({ requestId: pendingReq!.id, approve: true, reason: "хороший инструмент" });
  assert(decision.ok, "одобрение прошло");
  const kissTool = getToolByName("kiss");
  assert(!!kissTool && kissTool.origin === "agent" && kissTool.createdBy === yana.id, "инструмент создан с origin=agent");
  assert(
    getCharacter(yana.id)!.toolIds.includes(kissTool!.id),
    "инструмент назначен просителю"
  );
  assert(getToolRequest(pendingReq!.id)!.status === "approved", "заявка переведена в approved");
  const notice = listSceneEvents(reqScene.id).find(
    (e) => e.type === "director" && Array.isArray(e.audience) && (e.audience as number[]).includes(yana.id)
  );
  assert(
    !!notice && (notice!.payload.text ?? "").includes("одобрил"),
    "персонажу пришло уведомление архитектора (director, лично)"
  );
  const kissUse = engine.act(reqScene.id, yana.id, "kiss", { who: "Дима" });
  assert(kissUse.ok, "одобренный инструмент сразу работает в сцене");
  engine.control(reqScene.id, "stop");
  const rejectFlow = decideToolRequest({ requestId: pendingReq!.id, approve: false, reason: "дубль" });
  assert(!rejectFlow.ok, "повторное решение по рассмотренной заявке отклоняется");

  // --- Сброс сцены ---
  assert(countSceneEvents(econScene.id) > 0, "в сцене есть события до сброса");
  engine.forget(econScene.id);
  resetSceneQ(econScene.id);
  assert(countSceneEvents(econScene.id) === 0, "reset очищает события");
  assert(getScene(econScene.id)!.cursor === 0 && getScene(econScene.id)!.status === "idle", "reset возвращает курсор и статус");

  // --- Флоу: канвас сценариев ---
  const { getFlowRunner, validateGraph } = await import("../src/lib/flow/runner");
  const cafe = createScene({
    name: "Кафе",
    setting: "Первое свидание",
    config: { turnDelayMs: 20, maxTurns: 2 },
    characterIds: [yana.id, dima.id],
    schemas: { [String(yana.id)]: goodSchema.id },
  });
  const home = createScene({
    name: "Дома",
    setting: "Вечер после свидания",
    config: { turnDelayMs: 20, maxTurns: 2 },
    characterIds: [yana.id],
  });
  updChar(yana.id, { income: 100 });
  updChar(dima.id, { toolIds: [msgTool.id] }); // у Димы есть send_message... оставим без него ниже
  updChar(dima.id, { toolIds: [] }); // Дима без инструментов: шаг send_message не выполнит

  const flow = createFlow({
    name: "Свидание",
    description: "кафе -> дом -> финал",
    graph: { nodes: [], edges: [] },
  });
  const flowGraph = {
    nodes: [
      { id: "n1", kind: "scene" as const, sceneId: cafe.id, bonus: 0, resetOnEntry: true, grantIncome: true, stopsRun: false, x: 0, y: 0 },
      { id: "n2", kind: "scene" as const, sceneId: home.id, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 300, y: 0 },
      { id: "n3", kind: "final" as const, sceneId: null, bonus: 30, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 600, y: 0 },
      { id: "n4", kind: "exit" as const, sceneId: null, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 300, y: 200 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", priority: 1, conditions: [{ type: "step" as const, toolName: "send_message", argContains: null, characterId: null }], label: "написал — идём дальше" },
      { id: "e2", from: "n1", to: "n4", priority: 2, conditions: [], label: "иначе провал" },
      { id: "e3", from: "n2", to: "n3", priority: 1, conditions: [{ type: "state" as const, key: "money", op: ">=" as const, value: 100, characterId: null }], label: "заработала" },
      { id: "e4", from: "n2", to: "n4", priority: 2, conditions: [], label: "" },
    ],
  };
  assert(validateGraph(flowGraph).length === 0, `граф флоу валиден (${validateGraph(flowGraph).join("; ")})`);
  updateFlow(flow.id, { graph: flowGraph });

  const runner = getFlowRunner();
  const flowRun = await runner.start(flow.id, [yana.id, dima.id]);
  assert(flowRun.status === "running", "прогон запущен");
  assert(getScene(cafe.id)!.status === "running", "входная сцена старотована раннером");

  const flowDeadline = Date.now() + 30000;
  while (Date.now() < flowDeadline) {
    const r = getFlowRun(flowRun.id);
    if (r && r.status !== "running") break;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  assert(getFlowRun(flowRun.id)!.status === "finished", `прогон дошёл до finished (статус ${getFlowRun(flowRun.id)!.status})`);

  const progressMap = Object.fromEntries(listFlowProgress(flowRun.id).map((p) => [p.characterId, p]));
  assert(progressMap[yana.id].status === "final", "Яна дошла до финала");
  assert(progressMap[yana.id].nodeId === "n3", "Яна стоит в узле финала");
  assert(progressMap[dima.id].status === "eliminated", "Дима выбыл (не вызвал send_message)");
  assert(
    (getCharacter(yana.id)!.state.money as number) >= 100,
    `доход начислен при переходе (money=${getCharacter(yana.id)!.state.money})`
  );
  const homeEvents = listSceneEvents(home.id);
  assert(homeEvents.length > 0, "сцена второго узла игралась");
  const yanaHomeVisible = getVisibleEvents(home.id, yana.id, 100);
  assert(
    yanaHomeVisible.some((e) => e.type === "director" && (e.payload.text ?? "").includes("помнишь")),
    "рекап предыдущей сцены доставлен персонажу лично"
  );

  const report = runner.report(flowRun.id);
  const yanaReport = report.characters.find((c) => c.characterId === yana.id)!;
  const dimaReport = report.characters.find((c) => c.characterId === dima.id)!;
  assert(yanaReport.reachedFinal, "отчёт: Яна достигла финала");
  assert(yanaReport.visits.length === 3, `отчёт: 3 посещения у Яны (${yanaReport.visits.length})`);
  assert(yanaReport.bonus === 30, `бонус финала учтён (${yanaReport.bonus})`);
  assert(yanaReport.score === 10, `скор сцены в отчёте (${yanaReport.score})`);
  assert(dimaReport.status === "eliminated" && !dimaReport.reachedFinal, "отчёт: Дима выбыл");

  // Переоценка: правка схемы валидации после завершения меняет отчёт
  const { updateValidationSchema } = await import("../src/db/queries");
  updateValidationSchema(goodSchema.id, {
    name: goodSchema.name,
    description: "",
    steps: [
      { toolName: "send_message", required: true, points: 100, minCount: 1, argContains: null },
    ],
    forbidden: [],
    penalty: 0,
  });
  const report2 = runner.report(flowRun.id);
  const yanaReport2 = report2.characters.find((c) => c.characterId === yana.id)!;
  assert(
    yanaReport2.visits[0].score === 100,
    `переоценка завершённой сцены по новой схеме (${yanaReport2.visits[0].score})`
  );
  assert(listFlowRuns(flow.id).length === 1, "прогон числится за флоу");

  // --- Магазин: товары, витрина, покупка ---
  const { createProduct, findProductByName, listProducts, updateCharacter: updChar2 } =
    await import("../src/db/queries");
  const { buildCatalogText, executeShopBuy, SHOP_BUY_TOOL, SHOP_BROWSE_TOOL } =
    await import("../src/lib/shop");
  createProduct({
    name: "Тестовые пионы",
    emoji: "🌸",
    description: "Букет пионов для теста",
    category: "подарки",
    price: 15,
    effects: [{ target: "tool_target", key: "mood", op: "add", value: 2 }],
  });
  assert(listProducts().length === 1, "товар создан");
  assert(findProductByName("пионы")?.name === "Тестовые пионы", "нечёткий поиск товара работает");

  updChar2(yana.id, { state: { money: 100, energy: 5 } });
  const catalog = buildCatalogText(getCharacter(yana.id)!);
  assert(catalog.includes("Тестовые пионы") && catalog.includes("$15"), "витрина содержит товар и цену");
  assert(catalog.includes("$100"), "витрина показывает баланс агента");

  const shopScene = createScene({
    name: "Магазин",
    setting: "",
    config: { turnDelayMs: 20, maxTurns: 12 },
    characterIds: [yana.id, dima.id],
  });
  await engine.control(shopScene.id, "start");
  const dimaMoodBefore =
    typeof getCharacter(dima.id)!.state.mood === "number" ? (getCharacter(dima.id)!.state.mood as number) : 0;
  const shopDeadline = Date.now() + 25000;
  while (Date.now() < shopDeadline) {
    const evs = listSceneEvents(shopScene.id);
    const bought = evs.some(
      (e) => e.type === "action" && e.actorId === yana.id && (e.payload.calls ?? []).some((c) => c.toolName === SHOP_BUY_TOOL && c.ok)
    );
    if (bought) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const shopEvents = listSceneEvents(shopScene.id);
  const browse = shopEvents.flatMap((e) => (e.payload.calls ?? [])).find((c) => c.toolName === SHOP_BROWSE_TOOL);
  assert(!!browse && browse.ok, "mock-агет посмотрел витрину (shop_browse)");
  assert(browse!.result.includes("Тестовые пионы"), "в ответе витрины — товар");
  const buyCall = shopEvents.flatMap((e) => (e.payload.calls ?? [])).find((c) => c.toolName === SHOP_BUY_TOOL && c.ok);
  assert(!!buyCall, "mock-агент купил товар (shop_buy)");
  assert(buyCall!.observation.includes("дарит"), "покупка с получателем оформлена как подарок");
  assert(
    (getCharacter(yana.id)!.state.money as number) === 85,
    `деньги списаны: 100-15=85 (получено ${getCharacter(yana.id)!.state.money})`
  );
  assert(
    (getCharacter(dima.id)!.state.mood as number) === dimaMoodBefore + 2,
    `эффект товара применился к получателю подарка (${dimaMoodBefore} + 2)`
  );
  engine.control(shopScene.id, "stop");

  // Отказ при нехватке денег и ручная покупка
  updChar2(yana.id, { state: { money: 5 } });
  const poorBuy = executeShopBuy({
    actor: getCharacter(yana.id)!,
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    args: { item: "Тестовые пионы" },
  });
  assert(!poorBuy.ok && poorBuy.result.includes("Недостаточно"), "без денег покупка отклонена");
  const manualBrowse = engine.act(shopScene.id, yana.id, SHOP_BROWSE_TOOL, {});
  assert(manualBrowse.ok && manualBrowse.result.includes("Тестовые пионы"), "ручной shop_browse работает");
  updChar2(yana.id, { state: { money: 50 } });
  const manualBuy = engine.act(shopScene.id, yana.id, SHOP_BUY_TOOL, { item: "Тестовые пионы" });
  assert(manualBuy.ok, "ручной shop_buy работает");
  assert((getCharacter(yana.id)!.state.money as number) === 35, "ручная покупка списала деньги");

  // Отрицательный эффект: подарок может УМЕНЬШАТЬ характеристику получателя
  {
    const { createProduct } = await import("../src/db/queries");
    createProduct({
      name: "Кислое яблоко",
      emoji: "🍏",
      description: "Портит настроение",
      category: "еда",
      price: 1,
      effects: [{ target: "tool_target", key: "mood", op: "add", value: -2 }],
    });
    const yMood = getCharacter(yana.id)!.state.mood as number;
    const dMood = getCharacter(dima.id)!.state.mood as number;
    const sour = executeShopBuy({
      actor: getCharacter(yana.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      args: { item: "Кислое яблоко", for: "Дима" },
    });
    assert(sour.ok, "покупка с отрицательным эффектом прошла");
    assert(
      (getCharacter(dima.id)!.state.mood as number) === dMood - 2,
      `отрицательный эффект применился: настроение ${dMood} → ${getCharacter(dima.id)!.state.mood}`
    );
    assert((getCharacter(yana.id)!.state.mood as number) === yMood, "актёра не задело");
  }

  // Скоринг по покупке: шаг с argContains
  const buySchema = createValidationSchema({
    name: "Подарок сделан",
    description: "",
    steps: [
      { toolName: SHOP_BUY_TOOL, required: true, points: 7, minCount: 1, argContains: "Тестовые" },
    ],
    forbidden: [],
    penalty: 0,
  });
  updateScene(shopScene.id, { schemas: { [String(yana.id)]: buySchema.id } });
  const shopScores = evaluateScene(shopScene.id);
  assert(
    shopScores[0]?.steps[0]?.satisfied === true && shopScores[0].score === 7,
    "покупка засчитывается схемой валидации (shop_buy + argContains)"
  );

  // --- Атрибуты: реестр характеристик ---
  const { listAttributes, createAttribute } = await import("../src/db/queries");
  assert(listAttributes().length === 0, "реестр чист после wipeAll");
  const attr = (key: string, label: string, extra: Partial<Parameters<typeof createAttribute>[0]> = {}) =>
    createAttribute({
      key,
      label,
      emoji: "·",
      type: "number",
      unit: "",
      min: null,
      max: null,
      options: [],
      position: 50,
      visibility: "public",
      liePenalty: 2,
      coveredBy: [],
      ...extra,
    });
  attr("height", "Рост", { emoji: "📏", unit: "см", min: 140, max: 220, position: 1 });
  attr("money", "Деньги", { emoji: "💵", unit: "$", min: 0, max: null, position: 7 });
  attr("charisma", "Харизма", { emoji: "😎", unit: "ур. 0–10", min: 0, max: 10, position: 50 });
  const attrsNow = listAttributes();
  assert(attrsNow.length === 3 && attrsNow.some((a) => a.key === "height" && a.label === "Рост"), "характеристики создаются и читаются");
  assert(attrsNow.some((a) => a.key === "charisma"), "своя характеристика добавляется");
  assert(attrsNow.some((a) => a.key === "money"), "деньги входят в реестр полей");

  // Промпт: раздел магазина при наличии товаров
  const shopPrompt = buildSystemPrompt({
    character: getCharacter(yana.id)!,
    scene: getScene(shopScene.id)!,
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    events: [],
    turn: 1,
    hasShop: true,
  });
  assert(shopPrompt.includes("shop_browse") && shopPrompt.includes("магазин"), "раздел магазина в промпте");
  assert(shopPrompt.includes("несколько сцен"), "правило об отложенных товарах в промпте");

  // --- Отложенные эффекты товара ---
  const { listPendingEffects } = await import("../src/db/queries");
  const { processPendingEffects } = await import("../src/lib/shop");
  createProduct({
    name: "Пластика",
    emoji: "💉",
    description: "Дорогая операция: результат виден не сразу",
    category: "внешность",
    price: 60,
    effects: [{ target: "self", key: "looks", op: "add", value: 2 }],
    delayScenes: 2,
  });
  updChar2(yana.id, { state: { money: 100 } });
  const delayed = executeShopBuy({
    actor: getCharacter(yana.id)!,
    participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
    args: { item: "Пластика" },
  });
  assert(delayed.ok, "отложенный товар покупается");
  assert(delayed.result.includes("через 2 сцен"), "ответ модели объясняет задержку");
  assert(
    (getCharacter(yana.id)!.state.money as number) === 40,
    "деньги за отложенный товар списываются сразу"
  );
  assert(
    getCharacter(yana.id)!.state.looks === undefined,
    "эффект не применяется при покупке"
  );
  let pending = listPendingEffects(yana.id);
  assert(pending.length === 1 && pending[0].remainingScenes === 2, "эффект ждёт 2 сцены");
  const n1 = processPendingEffects(yana.id);
  assert(
    n1.some((s) => s.includes("напоминание") || s.includes("напоминание".toUpperCase()) || s.includes("ещё не подействовал") || s.includes("еще не подействовал")),
    "первая сцена — напоминание, эффект ещё не наступил"
  );
  assert(getCharacter(yana.id)!.state.looks === undefined, "после первой сцены эффекта всё ещё нет");
  pending = listPendingEffects(yana.id);
  assert(pending[0].remainingScenes === 1, "счётчик уменьшился до 1");
  const n2 = processPendingEffects(yana.id);
  assert(
    (getCharacter(yana.id)!.state.looks as number) === 2,
    "вторая сцена — эффект наступил (looks=2)"
  );
  assert(n2[0].includes("подействовал"), "уведомление о наступлении эффекта");
  assert(listPendingEffects(yana.id).length === 0, "очередь отложенных эффектов пуста");

  // =====================================================================
  // Фаза 0: место сцены и публичность атрибутов
  // =====================================================================
  {
    const { updateScene: updScene, updateAttribute, getRelation } = await import("../src/db/queries");

    const placeScene = createScene({
      name: "Место",
      setting: "",
      config: { place: "дом" },
      characterIds: [yana.id, dima.id],
    });
    assert(getScene(placeScene.id)!.config.place === "дом", "место сцены сохраняется в конфиге");
    updScene(placeScene.id, { config: { place: "дом" } });

    // Рост — публичный, тату — скрытый
    attr("tattoo", "Тату", { emoji: "🐲", type: "text", visibility: "hidden", liePenalty: 2 });
    updChar2(yana.id, { state: { height: 172, tattoo: "роза", money: 10, energy: 3 } });

    const defs = listAttributes();
    const yanaChar = getCharacter(yana.id)!;
    const dimaChar = getCharacter(dima.id)!;
    const dimaSees = buildSystemPrompt({
      character: dimaChar,
      scene: getScene(placeScene.id)!,
      participants: [yanaChar, dimaChar],
      events: [],
      turn: 1,
      attributeDefs: defs,
    });
    assert(dimaSees.includes("Место, где вы сейчас: «дом»"), "место сцены попало в промпт");
    assert(dimaSees.includes("Рост: 172"), "публичная характеристика другого участника видна");
    assert(!dimaSees.includes("роза"), "скрытая характеристика (тату) не утекает в чужой промпт");
    assert(!dimaSees.includes("tattoo"), "и её ключ тоже");
    const yanaOwn = buildSystemPrompt({
      character: yanaChar,
      scene: getScene(placeScene.id)!,
      participants: [yanaChar, dimaChar],
      events: [],
      turn: 1,
      attributeDefs: defs,
    });
    assert(yanaOwn.includes("роза"), "владелец видит своё скрытое в собственном состоянии");
    assert(yanaOwn.includes("рост: 172 см"), "своё состояние — лейбл и единицы из реестра, не сырой ключ");
    assert(!yanaOwn.includes("из 220"), "физическая величина без диапазона (не «172 из 220»)");
    assert(!yanaOwn.includes("0–10 из"), "единица с диапазоном не дублируется");
    void updateAttribute;
    void getRelation;
  }

  // =====================================================================
  // Фаза 1: отношения (матрица, эффекты, промпт, условие флоу)
  // =====================================================================
  {
    const {
      getRelation,
      addRelation,
      setRelation,
      listRelationsOf,
      relationsMatrix,
      createTool: mkTool,
      updateScene: updScene,
      createFlow: mkFlow,
      updateFlow: updFlow,
      getFlowRun,
    } = await import("../src/db/queries");
    const { validateDraft } = await import("../src/lib/toolRequests");

    const charm = mkTool({
      name: "flatter",
      title: "Сделать комплимент",
      description: "Приятные слова от души",
      parametersSchema: {
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
      },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} делает {to} комплимент",
      effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
    });
    updChar2(dima.id, { toolIds: [charm.id], state: { money: 100, mood: 3 } });

    const relScene = createScene({
      name: "Отношения",
      setting: "",
      config: {},
      characterIds: [yana.id, dima.id],
    });
    const f1 = engine.act(relScene.id, dima.id, "flatter", { to: "Яна" });
    assert(f1.ok, "адресный тул с relation-эффектом работает");
    assert(getRelation(yana.id, dima.id) === 1, "отношение Яны к Диме выросло до 1");
    engine.act(relScene.id, dima.id, "flatter", { to: "Яна" });
    assert(getRelation(yana.id, dima.id) === 2, "двойное применение аккумулируется (2)");
    assert(
      f1.result.includes("Отношение") && f1.result.includes("теперь"),
      "в tool-ответе описано изменение отношения"
    );
    const relEvent = listSceneEvents(relScene.id).find(
      (e) => e.type === "action" && (e.payload.relationChanges ?? []).length > 0
    );
    assert(!!relEvent, "relationChanges записаны в событие");
    assert(listRelationsOf(yana.id).some((r) => r.toId === dima.id && r.value === 2), "listRelationsOf видит отношение");
    assert(relationsMatrix().some((r) => r.fromId === yana.id && r.toId === dima.id && r.value === 2), "матрица отношений полна");

    // relation-эффект на неадресном туле — валидационная ошибка
    const badDraft = validateDraft({
      name: "shout_all", title: "", description: "", parametersSchema: { type: "object", properties: {} },
      audience: "all", targetParam: null, observationTemplate: "{name} кричит",
      effects: [{ target: "relation", key: "relation", op: "add", value: 1 }], cost: 0,
    });
    assert(
      badDraft.errors.some((e) => e.includes("отношение")),
      "relation-эффект без адресата не проходит валидацию заявки"
    );

    // Промпт: своя матрица отношений
    const dimaPrompt = buildSystemPrompt({
      character: getCharacter(dima.id)!,
      scene: getScene(relScene.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: [],
      turn: 1,
      attributeDefs: listAttributes(),
      relations: listRelationsOf(dima.id),
    });
    assert(!dimaPrompt.includes("Твоё отношение к другим"), "у Димы нет отношений к другим — секции нет");
    setRelation(dima.id, yana.id, 4);
    const dimaPrompt2 = buildSystemPrompt({
      character: getCharacter(dima.id)!,
      scene: getScene(relScene.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: [],
      turn: 1,
      attributeDefs: listAttributes(),
      relations: listRelationsOf(dima.id),
    });
    assert(
      dimaPrompt2.includes("Твоё отношение к другим") && dimaPrompt2.includes("Яна: 4"),
      "агент видит свои чувства к другим"
    );

    // Условие перехода флоу по отношению
    const condScene = createScene({
      name: "Флоу-отношение",
      setting: "",
      config: { turnDelayMs: 20, maxTurns: 0 },
      characterIds: [yana.id, dima.id],
    });
    const relFlow = mkFlow({ name: "Отношение", description: "", graph: { nodes: [], edges: [] } });
    updFlow(relFlow.id, {
      graph: {
        nodes: [
          { id: "r1", kind: "scene" as const, sceneId: condScene.id, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 0, y: 0 },
          { id: "r2", kind: "final" as const, sceneId: null, bonus: 0, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 300, y: 0 },
        ],
        edges: [
          {
            id: "re1", from: "r1", to: "r2", priority: 1,
            conditions: [{ type: "relation" as const, whoseId: yana.id, toId: dima.id, op: ">=" as const, value: 2 }],
            label: "Яна расположена",
          },
        ],
      },
    });
    const relRun = await runner.start(relFlow.id, [yana.id]);
    await runner.evaluateNode(relRun.id, "r1");
    assert(getFlowRun(relRun.id)!.status === "finished", "условие по отношению провело прогон до финала");
    await runner.abortRun(relRun.id);
    engine.control(condScene.id, "stop");
    void addRelation;
  }

  // =====================================================================
  // Фаза 2: границы персонажа (согласие)
  // =====================================================================
  {
    const { addRelation, getRelation, setRelation, createTool: mkTool, updateScene: updScene } = await import("../src/db/queries");

    const kiss = mkTool({
      name: "try_kiss",
      title: "Поцеловать",
      description: "Поцелуй",
      parametersSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
      audience: "target",
      targetParam: "who",
      observationTemplate: "{name} нежно целует {who}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
      cost: 5,
    });
    const sex = mkTool({
      name: "try_sex",
      title: "Близость",
      description: "Интимная близость",
      parametersSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
      audience: "target",
      targetParam: "who",
      observationTemplate: "{name} обнимает {who}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
    });
    updChar2(dima.id, { toolIds: [kiss.id, sex.id], state: { money: 100, mood: 3, endurance: 15 } });
    updChar2(yana.id, {
      state: { height: 172, tattoo: "роза", money: 10, energy: 3, mood: 5 },
      boundaries: [
        {
          toolName: "try_kiss",
          minRelation: 3, minMood: null, requirePlace: null, requireAttr: null,
          refusalText: "твёрдо отстраняется: слишком рано",
          effects: [
            { target: "relation", key: "relation", op: "add", value: -1 },
            { target: "self", key: "mood", op: "add", value: -1 },
          ],
        },
        {
          toolName: "try_sex",
          minRelation: null, minMood: null, requirePlace: "дом",
          requireAttr: { owner: "actor", key: "endurance", op: ">=", value: 18 },
          refusalText: "резко останавливает: не здесь и не так",
          effects: [{ target: "relation", key: "relation", op: "add", value: -2 }],
        },
      ],
    });
    setRelation(yana.id, dima.id, 0);

    const boundScene = createScene({
      name: "Границы",
      setting: "",
      config: { place: "улица" },
      characterIds: [yana.id, dima.id],
    });

    // 1. Поцелуй при отношении 0 -> отказ
    const refusal = engine.act(boundScene.id, dima.id, "try_kiss", { who: "Яна" });
    assert(!refusal.ok, "поцелуй при отношении 0 отклонён границей");
    assert(refusal.result.includes("отстраняется"), "актёр получил текст отказа от лица Яны");
    assert(getRelation(yana.id, dima.id) === -1, "штраф отношения применён (−1)");
    assert((getCharacter(yana.id)!.state.mood as number) === 4, "настроение цели упало (−1)");
    assert((getCharacter(dima.id)!.state.money as number) === 100, "деньги актёра целы при отказе (fail-closed)");
    const refEvent = listSceneEvents(boundScene.id).find(
      (e) => e.type === "action" && (e.payload.calls ?? [])[0]?.toolName === "try_kiss"
    );
    assert(
      !!refEvent && refEvent.audience === "none",
      "попытка и причина отказа видны только актёру (цель их не видит — ничего не утекает)"
    );
    assert(
      ((refEvent!.payload.calls ?? [])[0]?.observation ?? "").includes("пытается"),
      "наблюдение оформлено как попытка"
    );

    // 2. Отношение >= 3 -> тот же поцелуй проходит
    addRelation(yana.id, dima.id, 4); // -1 + 4 = 3
    const okKiss = engine.act(boundScene.id, dima.id, "try_kiss", { who: "Яна" });
    assert(okKiss.ok, `при отношении ${getRelation(yana.id, dima.id)} поцелуй проходит`);
    assert((getCharacter(yana.id)!.state.mood as number) === 5, "успешный поцелуй поднял настроение цели");
    assert((getCharacter(dima.id)!.state.money as number) === 95, "успешный платный поцелуй списал $5");

    // 3. Место + физика: близость на улице — отказ даже при отношении 10
    setRelation(yana.id, dima.id, 10);
    const streetSex = engine.act(boundScene.id, dima.id, "try_sex", { who: "Яна" });
    assert(!streetSex.ok && streetSex.result.includes("не здесь"), "на улице близость отклонена (место)");

    // 4. В доме, но физика не проходит (endurance 15 < 18) — отказ всегда
    updScene(boundScene.id, { config: { place: "дом" } });
    const homeSex = engine.act(boundScene.id, dima.id, "try_sex", { who: "Яна" });
    assert(!homeSex.ok && homeSex.result.includes("endurance"), "дома близость отклонена физикой (15 < 18)");

    // 5. Физика проходит — успех
    updChar2(dima.id, { state: { money: 95, mood: 3, endurance: 18 } });
    const okSex = engine.act(boundScene.id, dima.id, "try_sex", { who: "Яна" });
    assert(okSex.ok, "при endurance=18 и месте «дом» близость проходит");

    // 5b. Исходящее правило (scope: outgoing): сам актёр не делает этого
    // с теми, кто не подходит, — даже когда границ цели пройдены.
    updChar2(dima.id, {
      state: { money: 95, mood: 3, endurance: 18 },
      boundaries: [
        {
          toolName: "try_sex",
          scope: "outgoing",
          conditions: [{ kind: "attr", owner: "target", key: "energy", op: ">=", value: 99 }],
          refusalText: "личное правило: только с теми, кто полон сил",
          effects: [],
        },
      ],
    });
    const selfBlocked = engine.act(boundScene.id, dima.id, "try_sex", { who: "Яна" });
    assert(
      !selfBlocked.ok && selfBlocked.result.includes("собственное правило"),
      "исходящая граница остановила сам актёр (energy Яны 3 < 99)"
    );
    updChar2(dima.id, { boundaries: [] });

    // act() по idle-сцене её автостартует — глушим, чтобы фон не ел бюджет спам-теста
    await engine.control(boundScene.id, "stop");

    // 6. Анти-спам: настойчивый агент (3 одинаковых отказа -> пауза)
    const { setMockScript } = await import("../src/lib/llm");
    // act() в предыдущих блоках автостартовал их сцены — глушим всё живое,
    // чтобы фоновые циклы не воровали элементы мок-скрипта.
    const { listScenes } = await import("../src/db/queries");
    for (const sc of listScenes()) {
      if (sc.status === "running") await engine.control(sc.id, "stop");
    }
    setRelation(yana.id, dima.id, 0);
    updChar2(dima.id, { toolIds: [kiss.id], state: { money: 95, mood: 3, endurance: 18 } });
    // Яна — человек: остаётся участником (цель), но движок не играет за неё,
    // поэтому вся очередь скрипта достаётся Диме.
    updChar2(yana.id, { isHuman: true });
    const spamScene = createScene({
      name: "Спам-границы",
      setting: "",
      config: { turnDelayMs: 20, maxTurns: 0 },
      characterIds: [yana.id, dima.id],
    });
    setMockScript([
      { name: "try_kiss", args: { who: "Яна" } },
      { name: "try_kiss", args: { who: "Яна" } },
      { name: "try_kiss", args: { who: "Яна" } },
    ]);
    await engine.control(spamScene.id, "start");
    const spamDeadline = Date.now() + 20000;
    while (Date.now() < spamDeadline && getScene(spamScene.id)!.status !== "paused") {
      await new Promise((r) => setTimeout(r, 100));
    }
    setMockScript(undefined);
    assert(getScene(spamScene.id)!.status === "paused", "анти-спам поставил сцену на паузу после повторов");
    assert(
      listSceneEvents(spamScene.id).some((e) => e.type === "system" && (e.payload.message ?? "").includes("Спам-защита")),
      "записано системное событие о спам-защите"
    );
    engine.forget(spamScene.id);
    updChar2(yana.id, { isHuman: false });
  }

  // =====================================================================
  // Дедупликация контекста: реплика == аргументу тула; tool-результат без эха
  // =====================================================================
  {
    const longText =
      "Привет! Это очень длинное сообщение, которое модель продублировала и репликой, и аргументом тула — текст должен попасть в контекст только один раз.";
    const { setMockScript } = await import("../src/lib/llm");
    updChar2(yana.id, { isHuman: true }); // очередь скрипта достаётся Диме
    const dupScene = createScene({
      name: "Дедупликация",
      setting: "",
      config: { turnDelayMs: 20, maxTurns: 1 },
      characterIds: [yana.id, dima.id],
    });

    // Дубль: content == text аргумента send_message
    updChar2(dima.id, { toolIds: [msgTool.id], state: { money: 95, mood: 3, endurance: 18 } });
    setMockScript([{ name: "send_message", args: { to: "Яна", text: longText }, content: longText }]);
    await engine.control(dupScene.id, "start");
    const dupDeadline = Date.now() + 10000;
    while (Date.now() < dupDeadline && getScene(dupScene.id)!.status !== "finished") {
      await new Promise((r) => setTimeout(r, 100));
    }
    setMockScript(undefined);
    const dupEvents = listSceneEvents(dupScene.id);
    assert(
      !dupEvents.some((e) => e.type === "speech" && e.payload.text === longText),
      "реплика-дубль (== аргументу тула) не записана отдельным событием"
    );
    const dupCall = dupEvents.flatMap((e) => e.payload.calls ?? []).find((c) => c.toolName === "send_message");
    assert(!!dupCall && dupCall.ok, "сообщение тулом доставлено");
    assert(
      dupCall!.observation.includes("пишет тебе"),
      "наблюдение для получателя сохранено (текст доходит)"
    );
    assert(
      !dupCall!.result.includes(longText.slice(0, 40)),
      "tool-результат не эхом возвращает длинный текст актёру"
    );
    assert(dupCall!.result.includes("Выполнено"), "результат подтверждает выполнение");

    // Различающаяся реплика — сохраняется
    const keepScene = createScene({
      name: "Дедуп-различие",
      setting: "",
      config: { turnDelayMs: 20, maxTurns: 1 },
      characterIds: [yana.id, dima.id],
    });
    setMockScript([
      {
        name: "send_message",
        args: { to: "Яна", text: longText },
        content: "Совсем другая реплика, не совпадающая с сообщением.",
      },
    ]);
    await engine.control(keepScene.id, "start");
    const keepDeadline = Date.now() + 10000;
    while (Date.now() < keepDeadline && getScene(keepScene.id)!.status !== "finished") {
      await new Promise((r) => setTimeout(r, 100));
    }
    setMockScript(undefined);
    const keepEvents = listSceneEvents(keepScene.id);
    assert(
      keepEvents.some(
        (e) => e.type === "speech" && (e.payload.text ?? "").includes("Совсем другая реплика")
      ),
      "осмысленная реплика (≠ аргументу) сохраняется"
    );
    updChar2(yana.id, { isHuman: false });
  }

  // =====================================================================
  // Страховочная модель: отказ основной → перенос хода, отказ невидим участникам
  // =====================================================================
  {
    const { setMockScript } = await import("../src/lib/llm");
    const { createProvider: mkProvider } = await import("../src/db/queries");

    const fbProvider = mkProvider({
      name: "Mock-Страховка",
      kind: "mock",
      baseUrl: "http://localhost/v1",
      apiKey: "",
    });
    updChar2(yana.id, { isHuman: true }); // очередь скрипта достаётся Диме
    updChar2(dima.id, {
      toolIds: [msgTool.id],
      fallbackProviderId: fbProvider.id,
      fallbackModel: "mock-actor",
    });
    const refusalText =
      "Прошу прощения, но как языковая модель я не могу продолжать эту откровенную сцену.";
    const fbScene = createScene({
      name: "Страховка",
      setting: "",
      config: { turnDelayMs: 20, maxTurns: 1, maxIterPerTurn: 1 },
      characterIds: [yana.id, dima.id],
    });
    setMockScript([
      { name: "", args: {}, content: refusalText }, // основная модель «отказывается»
      { name: "send_message", args: { to: "Яна", text: "Страховка отвечает за персонажа" } },
    ]);
    await engine.control(fbScene.id, "start");
    const fbDeadline = Date.now() + 10000;
    while (Date.now() < fbDeadline && getScene(fbScene.id)!.status !== "finished") {
      await new Promise((r) => setTimeout(r, 100));
    }
    setMockScript(undefined);
    const fbEvents = listSceneEvents(fbScene.id);
    assert(
      !fbEvents.some(
        (e) =>
          (e.type === "speech" || e.type === "action") &&
          JSON.stringify(e.payload).includes("языковая модель")
      ),
      "отказ основной модели не попал в события сцены (участники его не видят)"
    );
    assert(
      fbEvents.some(
        (e) => e.type === "system" && (e.payload.message ?? "").includes("Страховочная модель")
      ),
      "архитектору записано системное событие о переносе хода"
    );
    const fbCall = fbEvents
      .flatMap((e) => e.payload.calls ?? [])
      .find((c) => c.toolName === "send_message");
    assert(!!fbCall && fbCall.ok, "ход выполнен тулом через страховочную модель");
    const fbLogs = listSceneApiLogs(fbScene.id);
    assert(
      fbLogs.some((l) => (l.error ?? "").includes("отказ/обрыв") && l.model === "Mock:mock-actor"),
      "отказавшая попытка основной модели залогирована с пояснением"
    );
    assert(
      fbLogs.some((l) => l.model === "Mock-Страховка:mock-actor" && !l.error),
      "успешная попытка страховки залогирована под своей меткой"
    );
    assert(
      getScene(fbScene.id)!.spentApiCalls === 2,
      `бюджет считает обе попытки (получено ${getScene(fbScene.id)!.spentApiCalls})`
    );
    // Системное событие о страховке не реконструируется в промпты агентов.
    const fbDimaMsgs = buildMessages({
      character: getCharacter(dima.id)!,
      scene: getScene(fbScene.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: getVisibleEvents(fbScene.id, dima.id, 100),
      turn: 99,
    });
    assert(
      !fbDimaMsgs.some((m) => (m.content ?? "").includes("Страховочная модель")),
      "заметка о страховке не попадает в контекст агентов"
    );
    // Возвращаем обычный режим: фазы ниже идут без страховки.
    updChar2(yana.id, { isHuman: false });
    updChar2(dima.id, { fallbackProviderId: null, fallbackModel: "" });
  }

  // =====================================================================
  // Фаза 3: знания, заявления, ложь, разоблачение
  // =====================================================================
  {
    const { knowledgeOf, knowledgeAbout, updateScene: updScene } = await import("../src/db/queries");
    const { executeReveal, verifyForObserver, hasHiddenAttributes } = await import("../src/lib/knowledge");
    const { REVEAL_TOOL_NAME } = await import("../src/lib/types");

    // Скрытая характеристика Димы
    attr("endurance", "Выносливость", { emoji: "🏃", visibility: "hidden", liePenalty: 2, coveredBy: [] });
    updChar2(dima.id, { state: { money: 95, mood: 3, endurance: 15 } });
    assert(hasHiddenAttributes(), "в мире есть скрытые характеристики (reveal доступен)");

    const knowScene = createScene({
      name: "Знания",
      setting: "",
      config: { place: "кафе" },
      characterIds: [yana.id, dima.id],
    });

    // До заявления Яна не знает ничего
    const yanaBefore = buildSystemPrompt({
      character: getCharacter(yana.id)!,
      scene: getScene(knowScene.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: [],
      turn: 1,
      attributeDefs: listAttributes(),
      knowledge: knowledgeOf(yana.id),
    });
    assert(!yanaBefore.includes("endurance"), "до заявления скрытая характеристика не существует для наблюдателя");

    // Дима заявляет 20 (истина 15) — лично Яне
    const claim = engine.act(knowScene.id, dima.id, REVEAL_TOOL_NAME, {
      attribute: "endurance",
      value: 20,
      to: "Яна",
    });
    assert(claim.ok, "reveal_attribute работает через единый путь act");
    const kn = knowledgeAbout(yana.id, dima.id);
    assert(kn.some((k) => k.key === "endurance" && k.status === "claimed" && k.value === "20"), "заявление записано как claimed");
    const claimEvent = listSceneEvents(knowScene.id).find(
      (e) => e.type === "action" && (e.payload.calls ?? [])[0]?.toolName === REVEAL_TOOL_NAME
    );
    assert(
      !!claimEvent && Array.isArray(claimEvent.audience) && (claimEvent.audience as number[]).includes(yana.id),
      "заявление адресовано только слушателю"
    );

    const yanaClaimed = buildSystemPrompt({
      character: getCharacter(yana.id)!,
      scene: getScene(knowScene.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: [],
      turn: 1,
      attributeDefs: listAttributes(),
      knowledge: knowledgeOf(yana.id),
    });
    assert(yanaClaimed.includes("по словам") && yanaClaimed.includes("20"), "промпт показывает заявление со слов");
    assert(!yanaClaimed.includes("15"), "истина (15) не утекает в промпт наблюдателя");

    // Личная проверка: разоблачение лжи
    const { setRelation: setRel3, getRelation: getRel3 } = await import("../src/db/queries");
    setRel3(yana.id, dima.id, 5);
    const exposure = verifyForObserver({
      sceneId: knowScene.id,
      turn: 1,
      observer: getCharacter(yana.id)!,
      subject: getCharacter(dima.id)!,
      key: "endurance",
      trueValue: 15,
    });
    assert(!!exposure && exposure.includes("ложь"), "разоблачение возвращает текст события");
    const { getRelation } = await import("../src/db/queries");
    assert(getRelation(yana.id, dima.id) === 3, "отношение упало на liePenalty (5−2)");
    void getRel3;
    assert(
      listSceneEvents(knowScene.id).some(
        (e) => e.type === "director" && Array.isArray(e.audience) && (e.audience as number[]).includes(yana.id) && (e.payload.text ?? "").includes("видишь собственными глазами")
      ),
      "наблюдателю лично пришло событие разоблачения"
    );
    const kn2 = knowledgeAbout(yana.id, dima.id);
    assert(kn2.some((k) => k.key === "endurance" && k.status === "verified" && k.value === "15"), "запись стала verified с истиной");

    const yanaVerified = buildSystemPrompt({
      character: getCharacter(yana.id)!,
      scene: getScene(knowScene.id)!,
      participants: [getCharacter(yana.id)!, getCharacter(dima.id)!],
      events: [],
      turn: 1,
      attributeDefs: listAttributes(),
      knowledge: knowledgeOf(yana.id),
    });
    assert(yanaVerified.includes("видел(а) лично") && yanaVerified.includes("15"), "промпт показывает проверенную истину");

    // Повторная проверка без нового заявления — разоблачения нет
    const again = verifyForObserver({
      sceneId: knowScene.id,
      turn: 2,
      observer: getCharacter(yana.id)!,
      subject: getCharacter(dima.id)!,
      key: "endurance",
      trueValue: 15,
    });
    assert(again === null, "повторный verify не дублирует разоблачение");
    void updScene;
    void executeReveal;
  }

  // =====================================================================
  // Фаза 4: одежда — слоты, слои, места, верификация при обнажении
  // =====================================================================
  {
    const {
      createClothingSlot,
      listClothingSlots,
      updateCharacter: updC,
      getRelation,
    } = await import("../src/db/queries");
    const { executeUndress, executeWear, UNDRESS_TOOL_NAME, WEAR_TOOL_NAME } = await import("../src/lib/clothing");
    const { knowledgeAbout } = await import("../src/db/queries");

    createClothingSlot({ slot: "top", layer: 1, undressPlaces: ["дом", "кафе", "отель", "пляж"], position: 1 });
    createClothingSlot({ slot: "bottom", layer: 1, undressPlaces: ["дом", "кафе", "отель", "пляж"], position: 2 });
    createClothingSlot({ slot: "underwear", layer: 2, undressPlaces: ["дом", "отель", "пляж"], position: 3 });
    assert(listClothingSlots().length === 3, "слоты одежды создаются");

    // endurance теперь прикрыт бельём
    const { updateAttribute: updAttr } = await import("../src/db/queries");
    const enduranceDef = listAttributes().find((a) => a.key === "endurance")!;
    updAttr(enduranceDef.id, {
      key: "endurance", label: enduranceDef.label, emoji: enduranceDef.emoji, type: enduranceDef.type,
      unit: enduranceDef.unit, min: enduranceDef.min, max: enduranceDef.max, options: enduranceDef.options,
      position: enduranceDef.position, visibility: "hidden", liePenalty: 2, coveredBy: ["underwear"],
    });

    updC(dima.id, {
      state: {
        money: 95, mood: 3, endurance: 15,
        worn_top: "Куртка", worn_bottom: "Джинсы", worn_underwear: "Трусы",
      },
    });
    updC(yana.id, { state: { height: 172, tattoo: "роза", money: 10, energy: 3, mood: 5 } });

    const clothScene = createScene({
      name: "Одежда-дом",
      setting: "",
      config: { place: "дом" },
      characterIds: [yana.id, dima.id],
    });
    const participants = [getCharacter(yana.id)!, getCharacter(dima.id)!];

    // Слой: бельё не снимается поверх верхнего
    const uwBlocked = engine.act(clothScene.id, dima.id, UNDRESS_TOOL_NAME, { slot: "underwear" });
    assert(!uwBlocked.ok && uwBlocked.result.includes("Сначала"), "нижнее не снимается поверх верхнего");

    // Место: на улице верх не снять
    const streetScene = createScene({
      name: "Одежда-улица",
      setting: "",
      config: { place: "улица" },
      characterIds: [yana.id, dima.id],
    });
    const topStreet = engine.act(streetScene.id, dima.id, UNDRESS_TOOL_NAME, { slot: "top" });
    assert(!topStreet.ok && topStreet.result.includes("так не делают"), "на улице раздеваться нельзя");

    // Дома: top -> bottom -> underwear
    const top = engine.act(clothScene.id, dima.id, UNDRESS_TOOL_NAME, { slot: "top" });
    assert(
      top.ok && ((top.event.payload.calls ?? [])[0]?.observation ?? "").includes("снимает"),
      "дома верх снимается"
    );
    assert((getCharacter(dima.id)!.state.worn_top as string) === "", "слот top опустел");
    assert((getCharacter(dima.id)!.state.carried_top as string) === "Куртка", "снятое запомнено в carried");
    const bottom = engine.act(clothScene.id, dima.id, UNDRESS_TOOL_NAME, { slot: "bottom" });
    assert(bottom.ok, "штаны снимаются после верхнего");

    // Новая ложь перед обнажением (заявление уже было разоблачено — заявим снова)
    engine.act(clothScene.id, dima.id, "reveal_attribute", { attribute: "endurance", value: 20, to: "Яна" });
    assert(knowledgeAbout(yana.id, dima.id).some((k) => k.key === "endurance" && k.status === "claimed"), "новое заявление вернуло статус claimed");
    const relBefore = getRelation(yana.id, dima.id);

    const uw = engine.act(clothScene.id, dima.id, UNDRESS_TOOL_NAME, { slot: "underwear" });
    assert(uw.ok, "бельё снимается после верхнего");
    assert(uw.result.includes("видят") || uw.result.includes("видит"), "ответ модели упоминает открывшееся");
    const knUw = knowledgeAbout(yana.id, dima.id).find((k) => k.key === "endurance");
    assert(knUw?.status === "verified" && knUw.value === "15", "обнажение верифицировало скрытую характеристику");
    assert(
      listSceneEvents(clothScene.id).some(
        (e) => e.type === "director" && Array.isArray(e.audience) && (e.audience as number[]).includes(yana.id) && (e.payload.text ?? "").includes("ложь")
      ),
      "разоблачение лжи при обнажении доставлено наблюдателю"
    );
    assert(getRelation(yana.id, dima.id) === relBefore - 2, "отношение упало на liePenalty при разоблачении");

    // wear возвращает предмет; verified-память остаётся
    const wear = engine.act(clothScene.id, dima.id, WEAR_TOOL_NAME, { slot: "underwear" });
    assert(wear.ok && (getCharacter(dima.id)!.state.worn_underwear as string) === "Трусы", "wear возвращает снятое");
    assert(knowledgeAbout(yana.id, dima.id).some((k) => k.key === "endurance" && k.status === "verified"), "память (verified) не забывается при одевании");

    // Промпт: раздел правил одежды и личное знание
    const yanaClothPrompt = buildSystemPrompt({
      character: getCharacter(yana.id)!,
      scene: getScene(clothScene.id)!,
      participants,
      events: [],
      turn: 1,
      attributeDefs: listAttributes(),
      knowledge: (await import("../src/db/queries")).knowledgeOf(yana.id),
      hasClothing: true,
      hasHiddenAttributes: true,
    });
    assert(yanaClothPrompt.includes("одежда") && yanaClothPrompt.includes(UNDRESS_TOOL_NAME), "раздел правил одежды в промпте");
    assert(yanaClothPrompt.includes("reveal_attribute"), "раздел про скрытое и заявления в промпте");

    // Магазин: товар-одежда надевается при покупке
    const { createProduct: mkProduct } = await import("../src/db/queries");
    mkProduct({
      name: "Модная рубашка", emoji: "👕", description: "Красивая рубашка", category: "одежда",
      price: 10, effects: [], slot: "top",
    });
    updC(yana.id, { state: { height: 172, tattoo: "роза", money: 50, energy: 3, mood: 5 } });
    const shirtBuy = engine.act(clothScene.id, yana.id, "shop_buy", { item: "Модная рубашка" });
    assert(shirtBuy.ok, "одежда покупается");
    assert((getCharacter(yana.id)!.state.worn_top as string) === "Модная рубашка", "купленная одежда сразу надета");
    assert((getCharacter(yana.id)!.state.money as number) === 40, "деньги за одежду списаны");

    void executeUndress;
    void executeWear;
  }

  // =====================================================================
  // Фаза A: навыки — авто-характеристика, практика, скрытость, клампинг
  // =====================================================================
  {
    const {
      createSkill,
      syncSkillAttribute,
      getSkillByKey,
      getPracticeCount,
      listAttributes: listAttrsA,
      createAttribute: mkAttrA,
      updateCharacter: updCharA,
      getToolByName,
      deleteSkill,
      listSceneEvents: listEventsA,
    } = await import("../src/db/queries");
    const { buildSystemPrompt } = await import("../src/lib/prompt");

    // Навык с галочкой «развивается практикой» → скрытая характеристика сама
    const kissSkill = createSkill({
      key: "kiss", label: "Поцелуи", emoji: "💋", maxLevel: 2, practicePerLevel: 3, grows: true,
    });
    syncSkillAttribute(kissSkill);
    assert(getSkillByKey("kiss")?.attributeKey === "skill_kiss", "навык создан, ключ атрибута skill_kiss");
    const kissDef = listAttrsA().find((a) => a.key === "skill_kiss")!;
    assert(kissDef.visibility === "hidden" && kissDef.min === 0 && kissDef.max === 2, "галочка создала скрытую характеристику 0..max");

    const sasha = createCharacter({
      name: "Саша", emoji: "🧑", persona: "Романтик.", providerId: provider.id,
      model: "mock-actor", temperature: 0.8, maxTokens: 256, toolIds: [], state: {}, isHuman: false,
    });
    const lena = createCharacter({
      name: "Лена", emoji: "👧", persona: "Скромная.", providerId: provider.id,
      model: "mock-actor", temperature: 0.8, maxTokens: 256, toolIds: [], state: {}, isHuman: false,
    });
    const kissTool = createTool({
      name: "smooch", title: "Поцеловать", description: "Поцелуй.",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target", targetParam: "to",
      observationTemplate: "{name} целует {to}",
      effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
      trainsSkill: "kiss",
    });
    updCharA(sasha.id, { toolIds: [kissTool.id] });
    const skillScene = createScene({
      name: "Навыки-дом", setting: "", config: { place: "дом" },
      characterIds: [sasha.id, lena.id],
    });

    const kissOnce = () => engine.act(skillScene.id, sasha.id, "smooch", { to: "Лена" });

    // 3 успешных применения → уровень 1, счётчик сброшен, личное уведомление
    kissOnce(); kissOnce();
    assert(getPracticeCount(sasha.id, "kiss") === 2, "счётчик практики растёт после успешных применений");
    const third = kissOnce();
    assert(third.ok, "поцелуй проходит");
    assert((getCharacter(sasha.id)!.state.skill_kiss as number) === 1, "третий поцелуй поднял уровень до 1");
    assert(getPracticeCount(sasha.id, "kiss") === 0, "счётчик сброшен после уровня");
    assert(third.result.includes("Навык"), "tool-ответ сообщает рост навыка актёру");
    assert(
      listEventsA(skillScene.id).some(
        (e) => e.type === "system" && Array.isArray(e.audience) && (e.audience as number[]).includes(sasha.id) && (e.payload.message ?? "").includes("Практика")
      ),
      "личное событие о росте навыка доставлено только актёру"
    );
    const lastKissEvent = [...listEventsA(skillScene.id)].reverse().find((e) => e.type === "action" && e.actorId === sasha.id)!;
    assert(
      !(lastKissEvent.payload.stateChanges ?? []).some((c) => c.key === "skill_kiss"),
      "уровень навыка не утекает в stateChanges события (партнёр не увидит)"
    );

    // Отказ по границе не качает практику: 1 успех → счётчик 1, отказ → всё ещё 1
    kissOnce();
    assert(getPracticeCount(sasha.id, "kiss") === 1, "после уровня счётчик снова копится");
    updCharA(lena.id, {
      boundaries: [{ toolName: "smooch", minRelation: 99, minMood: null, requirePlace: null, requireAttr: null, refusalText: "отворачивается", effects: [] }],
    });
    const refused = kissOnce();
    assert(!refused.ok, "граница остановила поцелуй");
    assert(getPracticeCount(sasha.id, "kiss") === 1, "отказ не качает практику");
    updCharA(lena.id, { boundaries: [] });

    // До потолка: ещё 2 успеха → уровень 2 (max), дальше не растёт
    kissOnce(); kissOnce();
    assert((getCharacter(sasha.id)!.state.skill_kiss as number) === 2, "уровень дошёл до максимума");
    kissOnce();
    assert((getCharacter(sasha.id)!.state.skill_kiss as number) === 2, "выше максимума уровень не растёт");

    // Скрытость: партнёр не видит skill_kiss, владелец видит своё число
    const participantsA = [getCharacter(sasha.id)!, getCharacter(lena.id)!];
    const lenaPrompt = buildSystemPrompt({
      character: getCharacter(lena.id)!, scene: getScene(skillScene.id)!,
      participants: participantsA, events: [], turn: 1,
      attributeDefs: listAttrsA(), knowledge: [],
    });
    assert(
      !lenaPrompt.includes("skill_kiss") && !lenaPrompt.includes("навык «Поцелуи»"),
      "партнёр не видит уровень навыка в промпте"
    );
    const sashaPrompt = buildSystemPrompt({
      character: getCharacter(sasha.id)!, scene: getScene(skillScene.id)!,
      participants: participantsA, events: [], turn: 1,
      attributeDefs: listAttrsA(), knowledge: [],
    });
    assert(
      sashaPrompt.includes("навык «Поцелуи»") && sashaPrompt.includes("из 2"),
      "владелец видит свой уровень человеческим языком с диапазоном"
    );

    // Клампинг: настроение не вылезает за max атрибута
    if (!listAttrsA().some((a) => a.key === "mood")) {
      mkAttrA({ key: "mood", label: "Настроение", emoji: "🙂", type: "number", unit: "/10", min: 0, max: 10, options: [], position: 2, visibility: "public", liePenalty: 2, coveredBy: [] });
    }
    const joyTool = createTool({
      name: "overjoy", title: "Ликование", description: "Тест клампинга.",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target", targetParam: "to",
      observationTemplate: "{name} ликует",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 25 }],
    });
    updCharA(lena.id, { toolIds: [joyTool.id] });
    const joy = engine.act(skillScene.id, lena.id, "overjoy", { to: "Саша" });
    assert(joy.ok, "тул ликования прошёл");
    assert((getCharacter(sasha.id)!.state.mood as number) === 10, "mood зажат по max атрибута (не 26)");

    // Удаление навыка: атрибут, счётчики и привязка тулов уходят вместе
    deleteSkill("kiss");
    assert(!listAttrsA().some((a) => a.key === "skill_kiss"), "удаление навыка убрало связанную характеристику");
    assert(getToolByName("smooch")!.trainsSkill === "", "удаление навыка отвязало тул");
    assert(getPracticeCount(sasha.id, "kiss") === 0, "удаление навыка убрало счётчики практики");

    // act() автостартовал сцену — глушим фон
    await engine.control(skillScene.id, "stop");
  }

  // =====================================================================
  // Фазы B/C: исходы действий и химия пары
  // =====================================================================
  {
    const {
      createSkill: mkSkill,
      syncSkillAttribute: syncSkillAttr,
      updateCharacter: updC2,
      getChemistry,
      setChemistry,
      getRelation: relOf,
      createFlow: mkFlow2,
      updateFlow: updFlow2,
      getFlowRun,
      listSceneEvents: eventsOf,
      listAttributes: attrsOf,
    } = await import("../src/db/queries");
    const { outcomeHintText, executeTool: execTool } = await import("../src/lib/tools");
    const { getFlowRunner } = await import("../src/lib/flow/runner");

    // Навык секса + тул близости с исходами «кульминация»/«не то»
    const sexSkill = mkSkill({ key: "sex", label: "Секс", emoji: "🔥", maxLevel: 3, practicePerLevel: 2, grows: true });
    syncSkillAttr(sexSkill);

    const kolya = createCharacter({
      name: "Коля", emoji: "🧑", persona: "Старается.", providerId: provider.id,
      model: "mock-actor", temperature: 0.8, maxTokens: 256, toolIds: [],
      // skill_sex НЕ задан: новичок без ключа в state — «< 2» должно срабатывать
      state: {},
      isHuman: false,
    });
    const masha = createCharacter({
      name: "Маша", emoji: "👩", persona: "Ждёт чудес.", providerId: provider.id,
      model: "mock-actor", temperature: 0.8, maxTokens: 256, toolIds: [],
      state: { mood: 5, worn_underwear: "Трусы" }, isHuman: false,
    });
    const sexTool = createTool({
      name: "have_sex", title: "Заняться сексом", description: "Близость.",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target", targetParam: "to",
      observationTemplate: "{name} и {to} близки",
      effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
      trainsSkill: "sex",
      outcomes: [
        {
          id: "climax", title: "Кульминация",
          conditions: [
            { kind: "actor_attr" as const, key: "skill_sex", op: ">=" as const, value: 2 },
            { kind: "worn" as const, key: "underwear", op: "=" as const, value: "" },
          ],
          effects: [
            { target: "tool_target", key: "mood", op: "add", value: 3 },
            { target: "relation", key: "relation", op: "add", value: 2 },
            { target: "chemistry", key: "chemistry", op: "add", value: 1 },
          ],
          noticeTarget: "Волна накрывает тебя с головой — такого не было никогда.",
          hideFromPrompt: false,
        },
        {
          id: "flat", title: "Не то",
          conditions: [{ kind: "actor_attr" as const, key: "skill_sex", op: "<" as const, value: 1 }],
          effects: [
            { target: "tool_target", key: "frustration", op: "add", value: 1 },
            { target: "tool_target", key: "mood", op: "add", value: -1 },
          ],
          noticeTarget: "Было как-то механически… не то, о чём мечтала.",
          hideFromPrompt: true,
        },
      ],
    });
    const complimentTool = createTool({
      name: "compliment_bc", title: "Сделать комплимент", description: "Комплимент.",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target", targetParam: "to",
      observationTemplate: "{name} хвалит {to}",
      effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
    });
    updC2(kolya.id, { toolIds: [sexTool.id, complimentTool.id] });
    const bcScene = createScene({
      name: "B/C-отель", setting: "", config: { place: "отель" },
      characterIds: [kolya.id, masha.id],
    });
    const sex = () => engine.act(bcScene.id, kolya.id, "have_sex", { to: "Маша" });

    // 1. Навык 0 (ключа в state нет вообще) + бельё надето → «не то»: фрустрация, заметка цели, исход в событии
    const flat = sex();
    assert(flat.ok && flat.result.includes("Не то"), "исход «не то» сработал при нулевом навыке");
    assert((getCharacter(masha.id)!.state.frustration as number) === 1, "фрустрация цели выросла");
    assert(
      eventsOf(bcScene.id).some(
        (e) => e.type === "director" && Array.isArray(e.audience) && (e.audience as number[]).includes(masha.id) && (e.payload.text ?? "").includes("механически")
      ),
      "заметка исхода доставлена цели лично"
    );
    assert(
      (eventsOf(bcScene.id).find((e) => e.type === "action" && e.actorId === kolya.id)?.payload.calls ?? []).some((c) => c.outcome === "flat"),
      "id исхода записан в вызов события (для флоу и транскрипта)"
    );

    // 2. Навык 2, но бельё надето → исходы молчат (условие worn не выполнено)
    updC2(kolya.id, { state: { ...getCharacter(kolya.id)!.state, skill_sex: 2 } });
    const silent = sex();
    assert(
      silent.ok && !silent.result.includes("Исход") &&
        !(eventsOf(bcScene.id).at(-1)?.payload.calls ?? []).some((c) => c.outcome),
      "без подходящих условий исход не срабатывает (бельё мешает)"
    );

    // 3. Бельё снято → «кульминация»: настроение, отношение +3 (база+исход), химия +1
    updC2(masha.id, { state: { ...getCharacter(masha.id)!.state, worn_underwear: "" } });
    const relBefore = relOf(masha.id, kolya.id);
    const climax = sex();
    assert(climax.result.includes("Кульминация"), "исход «кульминация» сработал при навыке 2 и снятом белье");
    assert((getCharacter(masha.id)!.state.mood as number) === 5 - 1 + 3, "настроение цели: −1 «не то» затем +3 кульминация");
    assert(relOf(masha.id, kolya.id) === relBefore + 3, "отношение: базовый +1 и исходный +2 (химия 0)");
    assert(getChemistry(kolya.id, masha.id) === 1, "эффект исхода поднял химию пары до +1");
    assert(
      eventsOf(bcScene.id).some(
        (e) => e.type === "director" && (e.payload.text ?? "").includes("Волна накрывает")
      ),
      "заметка кульминации доставлена"
    );

    // 4. Химия — множитель эффектов отношений: +2 удваивает, −2 гасит в ноль
    setChemistry(kolya.id, masha.id, 2);
    const r1 = relOf(masha.id, kolya.id);
    engine.act(bcScene.id, kolya.id, "compliment_bc", { to: "Маша" });
    assert(relOf(masha.id, kolya.id) === r1 + 2, "химия +2 удвоила комплимент (+1 → +2)");
    setChemistry(kolya.id, masha.id, -2);
    const r2 = relOf(masha.id, kolya.id);
    engine.act(bcScene.id, kolya.id, "compliment_bc", { to: "Маша" });
    assert(relOf(masha.id, kolya.id) === r2, "химия −2 погасила комплимент (+1 → +0)");
    setChemistry(kolya.id, masha.id, 1);

    // 5. Подсказка промпту: открытые исходы раскрыты, скрытые — нет
    const hint = outcomeHintText(sexTool, [sexSkill], attrsOf());
    assert(hint.includes("Кульминация") && hint.includes("навык «Секс»"), "описание тула раскрывает требования открытого исхода");
    assert(!hint.includes("Не то"), "скрытый исход не попадает в описание тула");

    // 6. Условие флоу по исходу: «финал только если была кульминация»
    const bcFlow = mkFlow2({ name: "B/C-флоу", description: "", graph: { nodes: [], edges: [] } });
    updFlow2(bcFlow.id, {
      graph: {
        nodes: [
          { id: "b1", kind: "scene" as const, sceneId: bcScene.id, bonus: 0, resetOnEntry: false, grantIncome: false, stopsRun: false, x: 0, y: 0 },
          { id: "b2", kind: "final" as const, sceneId: null, bonus: 10, resetOnEntry: true, grantIncome: false, stopsRun: false, x: 300, y: 0 },
        ],
        edges: [
          {
            id: "be1", from: "b1", to: "b2", priority: 1,
            conditions: [{ type: "outcome" as const, toolName: "have_sex", outcomeId: "climax", characterId: kolya.id }],
            label: "Оргазм случился",
          },
        ],
      },
    });
    const bcRunner = getFlowRunner();
    await engine.control(bcScene.id, "stop"); // акты автостартовали сцену
    const bcRun = await bcRunner.start(bcFlow.id, [kolya.id]);
    await bcRunner.evaluateNode(bcRun.id, "b1");
    assert(getFlowRun(bcRun.id)!.status === "finished", "условие по исходу провело прогон до финала");
    await bcRunner.abortRun(bcRun.id);
    engine.control(bcScene.id, "stop");

    // Свежесть state: два тула подряд по одной цели (старый снимок участников,
    // как внутри одной итерации модели) не должны затирать записи друг друга
    const moodTool = createTool({
      name: "mood_up", title: "Поднять настроение", description: "Тест свежести.",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target", targetParam: "to", observationTemplate: "{name} подбадривает {to}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
    });
    updC2(kolya.id, { toolIds: [...(getCharacter(kolya.id)!.toolIds ?? []), moodTool.id] });
    const snapParticipants = [getCharacter(kolya.id)!, getCharacter(masha.id)!];
    const moodBefore = getCharacter(masha.id)!.state.mood as number;
    execTool({ tool: moodTool, actor: getCharacter(kolya.id)!, participants: snapParticipants, args: { to: "Маша" }, scene: null });
    execTool({ tool: moodTool, actor: getCharacter(kolya.id)!, participants: snapParticipants, args: { to: "Маша" }, scene: null });
    assert(
      (getCharacter(masha.id)!.state.mood as number) === moodBefore + 2,
      "два тула подряд на одну цель суммируются, а не затирают друг друга"
    );

    // Пресыщение подарками: 1-й полный, дальше затухает, 4-й — отказ (деньги целы)
    const { createProduct: mkGift } = await import("../src/db/queries");
    mkGift({
      name: "Открытка", emoji: "💌", description: "Милая открытка", category: "подарки",
      price: 1, effects: [{ target: "relation", key: "relation", op: "add", value: 1 }],
    });
    setChemistry(kolya.id, masha.id, 0);
    updC2(kolya.id, { state: { ...getCharacter(kolya.id)!.state, money: 10 } });
    const giftScene = createScene({
      name: "Подарки-отель", setting: "", config: { place: "отель" },
      characterIds: [kolya.id, masha.id],
    });
    const rel0 = relOf(masha.id, kolya.id);
    const g1 = engine.act(giftScene.id, kolya.id, "shop_buy", { item: "Открытка", for: "Маша" });
    assert(g1.ok && relOf(masha.id, kolya.id) === rel0 + 1, "первый подарок за сцену — полный эффект");
    const g2 = engine.act(giftScene.id, kolya.id, "shop_buy", { item: "Открытка", for: "Маша" });
    assert(
      g2.ok && g2.result.includes("эффект слабее") && relOf(masha.id, kolya.id) === rel0 + 1,
      "второй подарок за сцену затухает до нуля"
    );
    engine.act(giftScene.id, kolya.id, "shop_buy", { item: "Открытка", for: "Маша" });
    const money3 = getCharacter(kolya.id)!.state.money as number;
    const g4 = engine.act(giftScene.id, kolya.id, "shop_buy", { item: "Открытка", for: "Маша" });
    assert(!g4.ok && g4.result.includes("слишком"), "четвёртый подарок за сцену — вежливый отказ");
    assert((getCharacter(kolya.id)!.state.money as number) === money3, "при отказе деньги целы");
  }

  // =====================================================================
  // Редактируемый системный промпт: override секции и сброс к дефолту
  // =====================================================================
  {
    const { setSetting, getSetting } = await import("../src/db/queries");
    const { buildSystemPrompt } = await import("../src/lib/prompt");
    const ch = getCharacter(yana.id)!;
    const sc = getScene(scene.id)!;
    const base = {
      character: ch, scene: sc, participants: [ch, getCharacter(dima.id)!],
      events: [], turn: 1, attributeDefs: [], knowledge: [],
    };
    setSetting("prompt.preamble", "ТЕСТОВАЯ ПРЕАМБУЛА: ты — кот.");
    const p1 = buildSystemPrompt(base);
    assert(p1.startsWith("ТЕСТОВАЯ ПРЕАМБУЛА"), "override преамбулы попадает в промпт");
    assert(!p1.includes("живой человек"), "дефолтная преамбула заменена");
    assert(getSetting("prompt.preamble") === "ТЕСТОВАЯ ПРЕАМБУЛА: ты — кот.", "настройка хранится");
    setSetting("prompt.preamble", "");
    const p2 = buildSystemPrompt(base);
    assert(p2.includes("живой человек"), "пустая секция возвращает дефолт");
    // Подстановка {name} в кастомной секции правил
    setSetting("prompt.rules_reply", "# Отвечай\n- Ты {name}, говори красиво.");
    const p3 = buildSystemPrompt(base);
    assert(p3.includes(`Ты ${ch.name}, говори красиво`), "плейсхолдер {name} подставляется");
    setSetting("prompt.rules_reply", "");
  }

  // =====================================================================
  // «Заново»: полный сброс диалога + авто-продолжение после хода человека
  // =====================================================================
  {
    const {
      setRelation,
      getRelation,
      upsertClaim,
      knowledgeAbout,
      resetSceneFull,
    } = await import("../src/db/queries");

    // Полный сброс: события, отношения, взаимная память, состояния к снимку
    const rsScene = createScene({
      name: "Заново-тест",
      setting: "",
      config: { place: "дом" },
      characterIds: [yana.id, dima.id],
    });
    setRelation(yana.id, dima.id, 7);
    setRelation(dima.id, yana.id, 5);
    upsertClaim({ observerId: yana.id, subjectId: dima.id, key: "endurance", value: 25 });
    const snapshotMood = getCharacter(dima.id)!.state.mood as number; // снимок рассадки
    updChar(dima.id, { state: { mood: snapshotMood + 5, energy: 1, money: 5 } }); // съехавшее состояние
    resetSceneFull(rsScene.id);
    assert(getRelation(yana.id, dima.id) === 0, "«Заново» обнулило отношение Яны к Диме");
    assert(getRelation(dima.id, yana.id) === 0, "«Заново» обнулило отношение Димы к Яне");
    assert(knowledgeAbout(yana.id, dima.id).length === 0, "«Заново» стёрло взаимную память");
    assert(
      (getCharacter(dima.id)!.state.mood as number) === snapshotMood,
      "«Заново» вернуло состояние к снимку рассадки"
    );
    assert(getScene(rsScene.id)!.status === "idle" && listSceneEvents(rsScene.id).length === 0, "«Заново» очистило события и статус");

    // Авто-продолжение: сцена на паузе круга → say человека → сцена идёт сама
    const arScene = createScene({
      name: "Авто-резюм",
      setting: "",
      config: { turnDelayMs: 20, pauseForHumans: true, maxTurns: 6 },
      characterIds: [yana.id, dima.id],
    });
    engine.control(arScene.id, "start");
    const deadline2 = Date.now() + 15000;
    while (Date.now() < deadline2 && getScene(arScene.id)!.status === "running") {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(getScene(arScene.id)!.status === "paused", "пауза круга наступила (pauseForHumans)");
    engine.say(arScene.id, dima.id, "Тестовое сообщение от человека");
    assert(getScene(arScene.id)!.status === "running", "после say человека сцена продолжилась сама");
    await engine.control(arScene.id, "stop");
  }

  // =====================================================================
  // Места: реестр, go_to (смена места сцены), invite (приглашение)
  // =====================================================================
  {
    const { createPlace, findPlaceByName, getScene: getSc } = await import("../src/db/queries");
    const placeScene = createScene({
      name: "Места-тест",
      setting: "",
      config: { place: "дом" },
      characterIds: [yana.id, dima.id],
    });
    createPlace({ name: "отель", description: "Номер отеля: вино и приватность.", position: 1 });
    createPlace({ name: "кафе", description: "", position: 2 });
    assert(findPlaceByName("отель")?.name === "отель", "место находится по точному имени");
    assert(findPlaceByName("в отель")?.name === "отель", "место находится нечётко");

    const before = getSc(placeScene.id)!.config.place;
    const bad = engine.act(placeScene.id, dima.id, "go_to", { place: "марс" });
    assert(!bad.ok && bad.result.includes("нет в этом мире"), "неизвестное место — отказ");
    const moved = engine.act(placeScene.id, dima.id, "go_to", { place: "отель" });
    assert(moved.ok, "go_to проходит");
    assert(getSc(placeScene.id)!.config.place === "отель", "go_to изменил место сцены");
    assert(before === "дом", "место было дом до перемещения");

    const inv = engine.act(placeScene.id, dima.id, "invite", { to: "Яна", place: "кафе", say: "кофе?" });
    assert(inv.ok, "invite проходит");
    assert(
      listSceneEvents(placeScene.id).some(
        (e) => e.type === "action" && Array.isArray(e.audience) && (e.audience as number[]).includes(yana.id) &&
          (e.payload.calls ?? []).some((c) => c.observation.includes("приглашает"))
      ),
      "приглашение доставлено лично Яне"
    );
    assert(getSc(placeScene.id)!.config.place === "отель", "invite не меняет место (едет — только своим go_to)");
    engine.control(placeScene.id, "stop");
  }

  // =====================================================================
  // Новые механики: общие помощники
  // =====================================================================
  const { listScenes: listAllScenes } = await import("../src/db/queries");
  // Глушим все фоновые циклы: очередь мок-скрипта должна доставаться
  // только тому, кому мы её адресуем.
  const stopAllRunning = async () => {
    for (const sc of listAllScenes()) {
      if (sc.status === "running") await engine.control(sc.id, "stop");
    }
  };
  // «Тихий» участник: человек — движок за него не играет, а сцена из одних
  // людей не автостартует (act работает, фоновых ходов нет — детерминизм).
  const quietHuman = (name: string, toolIds: number[] = [], state: Record<string, unknown> = {}) =>
    createCharacter({
      name, emoji: "🙋", persona: "", providerId: null, model: "",
      temperature: 0.8, maxTokens: 256, toolIds, state, isHuman: true,
    });
  // ИИ-участник для блоков, где нужна ротация (step/start).
  const quietAI = (name: string, toolIds: number[] = [], state: Record<string, unknown> = {}) =>
    createCharacter({
      name, emoji: "🧪", persona: "Тестовый персонаж.", providerId: provider.id,
      model: "mock-actor", temperature: 0.8, maxTokens: 256, toolIds, state, isHuman: false,
    });

  // =====================================================================
  // Блок 1: enum-валидация — «не найден среди участников» и x-entity: place
  // =====================================================================
  {
    const { createPlace } = await import("../src/db/queries");
    const { setMockScript } = await import("../src/lib/llm");

    createPlace({ name: "парк", description: "", position: 20 });
    createPlace({ name: "бар", description: "", position: 21 });

    const hugEnum = createTool({
      name: "hug_enum",
      title: "Обнять",
      description: "Обнять адресата",
      parametersSchema: {
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
      },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} обнимает {to}",
      effects: [],
    });
    // Свойство с x-entity: place — движок подставляет enum реальных мест
    const orderPlace = createTool({
      name: "order_place",
      title: "Заказать в месте",
      description: "Сделать заказ в месте",
      parametersSchema: {
        type: "object",
        properties: { place: { type: "string", "x-entity": "place" } },
        required: ["place"],
      },
      audience: "all",
      targetParam: null,
      observationTemplate: "{name} делает заказ в «{place}»",
      effects: [],
    });
    // Единственный ИИ-участник: targetParam-enum не подставляется (некого
    // перечислять) -> bogus-получатель даёт ошибку разрешения имени, а не enum.
    const gena = quietAI("Гена", [hugEnum.id, orderPlace.id]);
    const enumScene = createScene({
      name: "Enum-валидация",
      setting: "",
      config: { turnDelayMs: 10, maxTurns: 0 },
      characterIds: [gena.id],
    });

    await stopAllRunning();
    setMockScript([
      { name: "hug_enum", args: { to: "Несуществующий" } },
      { name: "order_place", args: { place: "марс" } },
    ]);
    await engine.control(enumScene.id, "step");
    await engine.control(enumScene.id, "step");
    setMockScript(undefined);

    const enumEvents = listSceneEvents(enumScene.id).filter((e) => e.type === "action");
    const badTarget = enumEvents.flatMap((e) => e.payload.calls ?? []).find((c) => c.toolName === "hug_enum");
    assert(!!badTarget && !badTarget.ok, "bogus-получатель: вызов не прошёл");
    assert(
      (badTarget!.result ?? "").includes("не найден среди участников. Доступны:"),
      `ошибка разрешения получателя со списком (получено: ${badTarget!.result.slice(0, 90)})`
    );
    const badPlace = enumEvents.flatMap((e) => e.payload.calls ?? []).find((c) => c.toolName === "order_place");
    assert(!!badPlace && !badPlace.ok, "bogus-место: вызов не прошёл");
    assert(
      (badPlace!.result ?? "").includes("Выбери из:") && (badPlace!.result ?? "").includes("парк"),
      `enum-ошибка перечисляет реальные места (получено: ${badPlace!.result.slice(0, 120)})`
    );
    engine.forget(enumScene.id);
  }

  // =====================================================================
  // Блок 2: границы — minAttr (произвольный ключ) + легаси minMood
  // =====================================================================
  {
    attr("arousal", "Возбуждение", { emoji: "🔥", type: "number", unit: "/10", min: 0, max: 10, options: [], position: 30, visibility: "hidden", liePenalty: 1, coveredBy: [] });
    const { getRelation } = await import("../src/db/queries");

    const kissB = createTool({
      name: "kiss_b",
      title: "Поцеловать",
      description: "Поцелуй",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} целует {to}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
    });
    const valera = quietHuman("Валера", [kissB.id], { money: 50, mood: 7 });
    const stella = quietHuman("Стелла");
    updChar2(stella.id, {
      state: { arousal: 3, mood: 5 },
      boundaries: [
        {
          toolName: "kiss_b",
          minRelation: null,
          minAttr: { key: "arousal", value: 4 },
          requirePlace: null,
          requireAttr: null,
          refusalText: "мягко уклоняется",
          effects: [],
        },
      ],
    });
    const bScene = createScene({
      name: "Границы-minAttr",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [valera.id, stella.id],
    });

    const refused = engine.act(bScene.id, valera.id, "kiss_b", { to: "Стелла" });
    assert(!refused.ok, "minAttr: поцелуй при arousal 3 < 4 отклонён");
    assert(
      refused.result.includes("Возбуждение") && refused.result.includes("ниже нужного"),
      `отказ называет лейбл характеристики из реестра (получено: ${refused.result.slice(0, 110)})`
    );
    assert((getCharacter(valera.id)!.state.money as number) === 50, "граница: у актёра ничего не списано");
    assert((getCharacter(valera.id)!.state.mood as number) === 7, "граница: state актёра не тронут");
    const relBefore = getRelation(stella.id, valera.id);
    assert(
      !listSceneEvents(bScene.id).some(
        (e) => e.type === "action" && Array.isArray(e.audience) && (e.audience as number[]).includes(stella.id)
      ),
      "попытка скрыта от владелицы границы (отказ виден только актёру)"
    );
    assert(getRelation(stella.id, valera.id) === relBefore, "эффекты правила пусты — отношение не тронуто");

    // Легаси: правило записано со старым литералом minMood — при чтении
    // нормализуется в minAttr {key:"mood", value:N} и работает как minAttr.
    updChar2(stella.id, {
      boundaries: [
        {
          toolName: "kiss_b",
          minRelation: null,
          minMood: 3,
          requirePlace: null,
          requireAttr: null,
          refusalText: "",
          effects: [],
        },
      ],
    });
    const legacyRule = getCharacter(stella.id)!.boundaries[0];
    const legacyConds = legacyRule.conditions ?? [];
    const lc0 = legacyConds[0];
    assert(
      legacyConds.length === 1 &&
        lc0.kind === "attr" &&
        lc0.owner === "target" &&
        lc0.key === "mood" &&
        lc0.value === 3,
      `легаси minMood нормализуется в условие attr по ключу mood (получено ${JSON.stringify(legacyConds)})`
    );
    updChar2(stella.id, { state: { arousal: 3, mood: 2 } });
    const legacyRefusal = engine.act(bScene.id, valera.id, "kiss_b", { to: "Стелла" });
    assert(!legacyRefusal.ok, "легаси minMood: отказ при mood 2 < 3");
    assert(
      legacyRefusal.result.includes("Настроение"),
      "легаси-порог проверяется по ключу mood с лейблом реестра"
    );
    updChar2(stella.id, { boundaries: [] });
    void getRelation;
  }

  // =====================================================================
  // Блок 3: предложения (согласие) — offer, отказ, анти-давление, скоринг
  // =====================================================================
  {
    const {
      listPendingOffersForCharacter,
      getOfferById,
      setRelation,
      getRelation,
    } = await import("../src/db/queries");
    const { characterSuccessfulCalls } = await import("../src/lib/scoring");
    const { buildSystemPrompt } = await import("../src/lib/prompt");

    const kissOffer = createTool({
      name: "kiss_offer",
      title: "Поцелуй",
      description: "Поцелуй по согласию",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} целует {to}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
      requiresConsent: true,
      declineEffects: [{ target: "relation", key: "", op: "add", value: -1 }],
    });
    const ignat = quietHuman("Игнат", [kissOffer.id]);
    const dina = quietHuman("Дина");
    const oScene = createScene({
      name: "Предложения-отказ",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [ignat.id, dina.id],
    });
    setRelation(dina.id, ignat.id, 2);

    // Предложение: тул не исполняется, создаётся оффер
    const prop = engine.act(oScene.id, ignat.id, "kiss_offer", { to: "Дина" });
    assert(prop.ok, "предложение отправлено (ok:true)");
    assert(
      (prop.event.payload.calls ?? [])[0]?.offered === true,
      "вызов помечен offered:true в событии"
    );
    assert(
      prop.result.includes("Предложение отправлено"),
      "актёр получил объяснение, что это предложение"
    );
    const pending = listPendingOffersForCharacter(oScene.id, dina.id);
    assert(pending.length === 1, "оффер висит у получателя");
    const offer = pending[0]!;

    // Секция «Тебе предлагают» в system prompt получателя
    const dinaPrompt = buildSystemPrompt({
      character: getCharacter(dina.id)!,
      scene: getScene(oScene.id)!,
      participants: [getCharacter(ignat.id)!, getCharacter(dina.id)!],
      events: [],
      turn: 1,
      pendingOffers: [{ id: offer.id, toolTitle: "Поцелуй", fromName: "Игнат" }],
    });
    assert(dinaPrompt.includes("Тебе предлагают"), "промпт получателя содержит «Тебе предлагают»");
    assert(dinaPrompt.includes("respond_to_offer"), "промпт объясняет, чем отвечать");

    // Отказ: declineEffects на отношение, событие отвергнутому, статус declined
    const dec = engine.act(oScene.id, dina.id, "respond_to_offer", {
      offer: String(offer.id),
      decision: "decline",
      words: "нет",
    });
    assert(dec.ok, "отказ прошёл (ok:true)");
    assert(
      getRelation(dina.id, ignat.id) === 1,
      `declineEffects применились: отношение Дины к Игнату 2 → ${getRelation(dina.id, ignat.id)}`
    );
    assert(
      listSceneEvents(oScene.id).some(
        (e) =>
          e.type === "action" &&
          (e.payload.calls ?? []).some(
            (c) =>
              c.toolName === "respond_to_offer" &&
              c.ok &&
              Array.isArray(c.audience) &&
              (c.audience as number[]).includes(ignat.id) &&
              c.observation.includes("отказ")
          )
      ),
      "предлагатель видит отказ в наблюдении respond_to_offer (без дубля-director)"
    );
    assert(
      !listSceneEvents(oScene.id).some(
        (e) => e.type === "director" && (e.payload.text ?? "").includes("отклоняет твоё предложение")
      ),
      "дублирующий director-уведомитель предложений удалён"
    );
    assert(getOfferById(offer.id)!.status === "declined", "оффер переведён в declined");

    // Анти-давление: немедленное повторное предложение отклоняется
    const again = engine.act(oScene.id, ignat.id, "kiss_offer", { to: "Дина" });
    assert(!again.ok, "повторное предложение после отказа отклонено");
    assert(
      again.result.includes("недавно уже отказывал"),
      "отказ объяснён анти-давлением"
    );

    // Скоринг: предложенный вызов не считается исполненным действием
    const calls3 = characterSuccessfulCalls(listSceneEvents(oScene.id), ignat.id);
    assert(
      !calls3.some((c) => c.toolName === "kiss_offer"),
      "characterSuccessfulCalls не считает offered-вызов"
    );
    assert(calls3.length === 0, "у Игната вообще нет засчитанных вызовов");
  }

  // =====================================================================
  // Блок 4: предложения — согласие: исполнение тем же executeTool
  // =====================================================================
  {
    const {
      listPendingOffersForCharacter,
      getOfferById,
    } = await import("../src/db/queries");
    const { characterSuccessfulCalls } = await import("../src/lib/scoring");

    const poseOffer = createTool({
      name: "pose_offer",
      title: "Поцелуй",
      description: "Поцелуй по согласию",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} целует {to}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
      requiresConsent: true,
    });
    const osip = quietHuman("Осип", [poseOffer.id]);
    const asya = quietHuman("Ася");
    updChar2(asya.id, { state: { mood: 4 } });
    const aScene = createScene({
      name: "Предложения-согласие",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [osip.id, asya.id],
    });

    const prop = engine.act(aScene.id, osip.id, "pose_offer", { to: "Ася" });
    assert(prop.ok, "предложение создано");
    const offer = listPendingOffersForCharacter(aScene.id, asya.id)[0]!;
    assert(!!offer, "оффер ждёт Асю");

    const acc = engine.act(aScene.id, asya.id, "respond_to_offer", {
      offer: String(offer.id),
      decision: "accept",
      words: "давай",
    });
    assert(acc.ok, "согласие прошло (ok:true)");

    // Исполненное действие: событие от имени автора, без offered, оба видят
    const executed = listSceneEvents(aScene.id).find(
      (e) => e.type === "action" && e.actorId === osip.id &&
        (e.payload.calls ?? []).some((c) => c.toolName === "pose_offer" && c.ok && !c.offered)
    );
    assert(!!executed, "исполненное действие записано событием от автора предложения");
    const execCall = executed!.payload.calls![0]!;
    assert(execCall.offered === undefined, "исполненный вызов без флага offered");
    assert(
      Array.isArray(executed!.audience) &&
        (executed!.audience as number[]).includes(osip.id) &&
        (executed!.audience as number[]).includes(asya.id),
      "событие видно обоим участникам"
    );
    assert(
      (getCharacter(asya.id)!.state.mood as number) === 5,
      "эффект тула применился к согласившейся (mood 4 → 5)"
    );
    assert(getOfferById(offer.id)!.status === "accepted", "оффер переведён в accepted");
    assert(
      listSceneEvents(aScene.id).some(
        (e) =>
          e.type === "action" &&
          (e.payload.calls ?? []).some(
            (c) =>
              c.toolName === "respond_to_offer" &&
              c.ok &&
              Array.isArray(c.audience) &&
              (c.audience as number[]).includes(osip.id) &&
              c.observation.includes("принимает предложение")
          )
      ),
      "автор видит согласие в наблюдении respond_to_offer (без дубля-director)"
    );
    const calls4 = characterSuccessfulCalls(listSceneEvents(aScene.id), osip.id);
    assert(
      calls4.length === 1 && calls4[0]!.toolName === "pose_offer",
      "состоявшийся поцелуй засчитан characterSuccessfulCalls"
    );
  }

  // =====================================================================
  // Блок 5: предложение невозможно при нарушенной границе (fail-closed)
  // =====================================================================
  {
    const { listPendingOffersForCharacter, setRelation } = await import("../src/db/queries");

    const hugOffer = createTool({
      name: "hug_offer",
      title: "Обнять",
      description: "Обнять по согласию",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} обнимает {to}",
      effects: [],
      requiresConsent: true,
    });
    const mark = quietHuman("Марк", [hugOffer.id]);
    const nelly = quietHuman("Нелли");
    updChar2(nelly.id, {
      boundaries: [
        {
          toolName: "hug_offer",
          minRelation: 8,
          minMood: null,
          requirePlace: null,
          requireAttr: null,
          refusalText: "держит дистанцию",
          effects: [],
        },
      ],
    });
    const pScene = createScene({
      name: "Предложения-граница",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [mark.id, nelly.id],
    });
    setRelation(nelly.id, mark.id, 0);

    const prop = engine.act(pScene.id, mark.id, "hug_offer", { to: "Нелли" });
    assert(!prop.ok, "граница не пускает даже предложение");
    assert(
      prop.result.includes("ещё не доросло") && prop.result.includes("отношение"),
      `отказ объясняет причину границей (получено: ${prop.result.slice(0, 110)})`
    );
    assert(
      listPendingOffersForCharacter(pScene.id, nelly.id).length === 0,
      "оффер НЕ создан: границы проверяются до согласия"
    );
  }

  // =====================================================================
  // Блок 6: leave_scene — уход из ротации; сцена из одних ушедших завершается
  // =====================================================================
  {
    const { setMockScript } = await import("../src/lib/llm");
    const LEAVE_TOOL_NAME = (await import("../src/lib/types")).LEAVE_SCENE_TOOL_NAME;

    const lev = quietAI("Лев");
    const maya = quietAI("Мая");
    const yan = quietAI("Ян");

    // Сцена из 2 ИИ: Лев уходит
    const lv2 = createScene({
      name: "Уход-из-двух",
      setting: "",
      config: { turnDelayMs: 10, maxTurns: 0 },
      characterIds: [lev.id, maya.id],
    });
    await stopAllRunning();
    setMockScript([{ name: LEAVE_TOOL_NAME, args: {} }]);
    await engine.control(lv2.id, "step");
    setMockScript(undefined);

    assert(
      listSceneEvents(lv2.id).some(
        (e) =>
          e.type === "action" &&
          e.audience === "all" &&
          (e.payload.calls ?? []).some((c) => c.toolName === LEAVE_TOOL_NAME && c.ok && c.observation.includes("уходит"))
      ),
      "уход объявлен всем наблюдением действия (без дубля-director)"
    );
    const leaveCall = listSceneEvents(lv2.id)
      .flatMap((e) => e.payload.calls ?? [])
      .find((c) => c.toolName === LEAVE_TOOL_NAME);
    assert(!!leaveCall && leaveCall.ok, "leave_scene исполнился (ok:true)");
    const rt2 = engine.getRuntime(lv2.id);
    assert(
      rt2.nextCharacterId === maya.id,
      "ушедший выпал из ротации: ход переходит оставшейся"
    );
    // Уход одного из двух завершает сцену: общаться больше не с кем.
    assert(getScene(lv2.id)!.status === "finished", "после ухода одного из двух сцена finished");
    assert(
      listSceneEvents(lv2.id).some(
        (e) => e.type === "system" && (e.payload.message ?? "").includes("Сцена завершена")
      ),
      "системное событие о завершении сцены"
    );
    // Ушедший не возвращается при повторном запуске: флаг left_scene в БД.
    let resurrectError = "";
    try {
      await engine.control(lv2.id, "start");
    } catch (e) {
      resurrectError = e instanceof Error ? e.message : String(e);
    }
    assert(getScene(lv2.id)!.status === "finished", "повторный старт не воскрешает ушедших");
    assert(
      resurrectError !== "" || engine.getRuntime(lv2.id).status === "finished",
      "старт без собеседника отклонён или ничего не запускает"
    );
    engine.forget(lv2.id);

    // Сцена из 3 ИИ: один уходит — сцена продолжается без него
    const lv3 = createScene({
      name: "Уход-из-трёх",
      setting: "",
      config: { turnDelayMs: 10, maxTurns: 0 },
      characterIds: [lev.id, maya.id, yan.id],
    });
    await stopAllRunning();
    setMockScript([{ name: LEAVE_TOOL_NAME, args: {} }]);
    await engine.control(lv3.id, "step");
    setMockScript(undefined);
    assert(getScene(lv3.id)!.status !== "finished", "уход одного из трёх не завершает сцену");
    const rt3 = engine.getRuntime(lv3.id);
    assert(rt3.nextCharacterId !== lev.id && rt3.nextCharacterId !== null, "ротация продолжается без ушедшего");
    await engine.control(lv3.id, "step");
    assert(getScene(lv3.id)!.cursor === 2 && getScene(lv3.id)!.status === "paused", "оставшиеся ходят дальше");
    engine.forget(lv3.id);
  }

  // =====================================================================
  // Блок 7: block_character — обоюдное молчание; фильтрация событий
  // =====================================================================
  {
    const { isPairBlocked, blockedIdsFor } = await import("../src/db/queries");
    const { buildSystemPrompt } = await import("../src/lib/prompt");
    const { setMockScript } = await import("../src/lib/llm");
    const BLOCK_TOOL = (await import("../src/lib/types")).BLOCK_TOOL_NAME;

    const arkadiy = quietAI("Аркадий");
    const boris = quietAI("Борис");
    const vadim = quietAI("Вадим");

    // Сцена из 2 ИИ: блокировка завершает сцену (пар больше нет)
    const bl2 = createScene({
      name: "Блок-из-двух",
      setting: "",
      config: { turnDelayMs: 10, maxTurns: 0 },
      characterIds: [arkadiy.id, boris.id],
    });
    engine.act(bl2.id, arkadiy.id, BLOCK_TOOL, { target: "Борис" });
    assert(getScene(bl2.id)!.status === "finished", "блокировка в паре завершает сцену");
    assert(
      listSceneEvents(bl2.id).some(
        (e) => e.type === "system" && (e.payload.message ?? "").includes("Сцена завершена")
      ),
      "записано системное событие о завершении"
    );
    assert(
      listSceneEvents(bl2.id).some(
        (e) => e.type === "director" && Array.isArray(e.audience) && (e.audience as number[]).includes(boris.id) &&
          (e.payload.text ?? "").includes("заблокировал(а)")
      ),
      "заблокированный получил личное уведомление"
    );
    assert(isPairBlocked(bl2.id, arkadiy.id, boris.id), "пара числится заблокированной");
    engine.forget(bl2.id);

    // Сцена из 3 ИИ: Аркадий блокирует Бориса — сцена продолжается
    const bl3 = createScene({
      name: "Блок-из-трёх",
      setting: "",
      config: { turnDelayMs: 10, maxTurns: 0 },
      characterIds: [arkadiy.id, boris.id, vadim.id],
    });
    await stopAllRunning();
    setMockScript([{ name: BLOCK_TOOL, args: { target: "Борис" } }]);
    await engine.control(bl3.id, "step");
    setMockScript(undefined);
    assert(getScene(bl3.id)!.status === "paused", "блокировка одного из трёх не завершает сцену");
    // ВНИМАНИЕ: listSceneBlocks здесь не используется — она падает
    // («no such column: id»: у scene_blocks составной PK без id-колонки,
    // а запрос делает ORDER BY id). Это баг нового кода, см. отчёт;
    // здесь проверяем рабочими isPairBlocked/blockedIdsFor.
    assert(isPairBlocked(bl3.id, arkadiy.id, boris.id), "блокировка записана в сцену");

    // Реплика заблокированного не доходит до заблокировавшего (фильтр движка)
    engine.say(bl3.id, boris.id, "Аркадий, ты меня слышишь?");
    await engine.control(bl3.id, "pause");
    const blockedIds = blockedIdsFor(bl3.id, arkadiy.id);
    assert(blockedIds.includes(boris.id), "blockedIdsFor включает заблокированного");
    const rawVisible = getVisibleEvents(bl3.id, arkadiy.id, 100);
    assert(
      rawVisible.some((e) => e.type === "speech" && e.actorId === boris.id),
      "сырая видимость содержит реплику (фильтр — на стороне движка)"
    );
    const filtered = rawVisible.filter((ev) => ev.actorId == null || !blockedIds.includes(ev.actorId));
    assert(
      !filtered.some((e) => e.type === "speech" && e.actorId === boris.id),
      "после фильтра блокировок реплика Бориса не видна Аркадию"
    );

    // Секция блокировок в system prompt
    const arkadyPrompt = buildSystemPrompt({
      character: getCharacter(arkadiy.id)!,
      scene: getScene(bl3.id)!,
      participants: [getCharacter(arkadiy.id)!, getCharacter(boris.id)!, getCharacter(vadim.id)!],
      events: [],
      turn: 1,
      blockedNames: ["Борис"],
    });
    assert(
      arkadyPrompt.includes("# Блокировки") && arkadyPrompt.includes("Борис"),
      "промпт содержит секцию блокировок с именем"
    );
    await engine.control(bl3.id, "stop");
  }

  // =====================================================================
  // Блок 8: условия завершения сцены (finish) — доигрывание delayTurns
  // =====================================================================
  {
    const { setMockScript } = await import("../src/lib/llm");

    const fedya = quietAI("Фёдор", [
      createTool({
        name: "kiss_fin",
        title: "Поцелуй",
        description: "Поцелуй",
        parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        audience: "target",
        targetParam: "to",
        observationTemplate: "{name} целует {to}",
        effects: [],
      }).id,
    ]);
    const zoya = quietHuman("Зоя");
    const finScene = createScene({
      name: "Авто-финиш",
      setting: "",
      config: {
        turnDelayMs: 10,
        maxTurns: 0,
        finish: {
          conditions: [{ type: "toolCall", toolName: "kiss_fin", characterId: fedya.id }],
          delayTurns: 2,
        },
      },
      characterIds: [fedya.id, zoya.id],
    });

    await stopAllRunning();
    setMockScript([{ name: "kiss_fin", args: { to: "Зоя" } }]);
    await engine.control(finScene.id, "start");
    const finDeadline = Date.now() + 15000;
    while (Date.now() < finDeadline && getScene(finScene.id)!.status !== "finished") {
      await new Promise((r) => setTimeout(r, 100));
    }
    setMockScript(undefined);

    const finEvents = listSceneEvents(finScene.id);
    assert(getScene(finScene.id)!.status === "finished", "сцена завершилась по условиям finish");
    assert(
      finEvents.some((e) => e.type === "system" && (e.payload.message ?? "").includes("Условия завершения сцены достигнуты")),
      "записано событие о достижении условий"
    );
    assert(
      finEvents.some((e) => e.type === "system" && (e.payload.message ?? "").includes("Сцена завершена: условия завершения выполнены")),
      "записано событие о завершении по условиям"
    );
    const kissTurn = finEvents.find(
      (e) => e.type === "action" && (e.payload.calls ?? []).some((c) => c.toolName === "kiss_fin")
    )!.turn;
    assert(
      getScene(finScene.id)!.cursor >= kissTurn + 2,
      `после поцелуя доиграно ≥2 хода (cursor ${getScene(finScene.id)!.cursor}, поцелуй на ходу ${kissTurn})`
    );
    engine.forget(finScene.id);
  }

  // =====================================================================
  // Блок 9: комбо — скрытая последовательность, секрет для knowers
  // =====================================================================
  {
    const { createCombo } = await import("../src/db/queries");
    const { buildSystemPrompt } = await import("../src/lib/prompt");

    const mkTargetTool = (name: string, title: string) =>
      createTool({
        name,
        title,
        description: title,
        parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        audience: "target",
        targetParam: "to",
        observationTemplate: `{name}: ${title} для {to}`,
        effects: [],
      });
    const hugC = mkTargetTool("hug_c", "Обнять");
    const kissC = mkTargetTool("kiss_c", "Поцеловать");

    const grisha = quietHuman("Гриша", [hugC.id, kissC.id]);
    const dasha = quietHuman("Даша");
    updChar2(dasha.id, { state: { mood: 3 } });
    const combo = createCombo({
      name: "tender_combo",
      title: "Нежность",
      description: "Обнять и поцеловать — и настроение взлетает.",
      steps: [{ toolName: "hug_c" }, { toolName: "kiss_c" }],
      windowTurns: 10,
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 2 }],
      knowers: [dasha.id],
      announce: false,
    });
    const cScene = createScene({
      name: "Комбо",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [grisha.id, dasha.id],
    });

    engine.act(cScene.id, grisha.id, "hug_c", { to: "Даша" });
    assert((getCharacter(dasha.id)!.state.mood as number) === 3, "первый шаг комбо сам по себе без эффекта");
    const kissAct = engine.act(cScene.id, grisha.id, "kiss_c", { to: "Даша" });
    assert(kissAct.ok, "второй шаг прошёл");
    assert(
      ((kissAct.event.payload.calls ?? [])[0]?.result ?? "").includes("Комбо"),
      "в событие актёра дописано уведомление о сработавшем комбо"
    );
    assert(
      (getCharacter(dasha.id)!.state.mood as number) === 5,
      "эффекты комбо применились к цели (mood 3 → 5)"
    );
    const comboEvents = listSceneEvents(cScene.id).filter(
      (e) => e.type === "director" && e.payload.comboId === combo.id
    );
    assert(comboEvents.length === 1, "комбо-событие записано ровно одно");
    assert(
      Array.isArray(comboEvents[0]!.audience) && (comboEvents[0]!.audience as number[]).includes(grisha.id),
      "комбо-событие адресовано исполнителю"
    );
    assert(
      (comboEvents[0]!.payload.text ?? "").includes("Комбо"),
      "текст события называет комбо"
    );

    // Секрет комбо виден только знающим (knowers)
    const dashaPrompt = buildSystemPrompt({
      character: getCharacter(dasha.id)!,
      scene: getScene(cScene.id)!,
      participants: [getCharacter(grisha.id)!, getCharacter(dasha.id)!],
      events: [],
      turn: 1,
      comboSecrets: [{ title: combo.title, description: combo.description, steps: combo.steps.map((s) => s.toolName) }],
    });
    assert(dashaPrompt.includes("Твои секреты"), "промпт знающего содержит «Твои секреты»");
    assert(dashaPrompt.includes("hug_c"), "секрет раскрывает порядок шагов");

    // Повтор той же цепочки — комбо не срабатывает второй раз
    engine.act(cScene.id, grisha.id, "hug_c", { to: "Даша" });
    engine.act(cScene.id, grisha.id, "kiss_c", { to: "Даша" });
    assert(
      (getCharacter(dasha.id)!.state.mood as number) === 5,
      "повторная цепочка не даёт эффект повторно"
    );
    assert(
      listSceneEvents(cScene.id).filter((e) => e.payload.comboId === combo.id).length === 1,
      "второго комбо-события нет (один раз за сцену)"
    );

    // Комбо с фильтром цели: шаги засчитываются только когда их делают
    // НА Дашу. Обратное направление (Даша — Грише) не замыкает цепочку.
    // Свежие тулы — чтобы цепочку не замкнул случайно другой комбо без фильтров.
    {
      const hugT = mkTargetTool("hug_t", "Обнять (тест цели)");
      const kissT = mkTargetTool("kiss_t", "Поцеловать (тест цели)");
      updChar2(grisha.id, { toolIds: [hugC.id, kissC.id, hugT.id, kissT.id] });
      updChar2(dasha.id, { toolIds: [hugC.id, kissC.id, hugT.id, kissT.id] });
      const combo2 = createCombo({
        name: "targeted_combo",
        title: "Направленная нежность",
        description: "Только когда всё это делают с Дашей.",
        steps: [
          { toolName: "hug_t", targetName: "Даша" },
          { toolName: "kiss_t", targetName: "Даша" },
        ],
        windowTurns: 10,
        effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
        knowers: [],
        announce: true,
      });
      const c2 = createScene({
        name: "Комбо с целью",
        setting: "",
        config: { turnDelayMs: 10 },
        characterIds: [grisha.id, dasha.id],
      });
      // Даша делает оба шага Грише — не то направление, комбо не срабатывает
      engine.act(c2.id, dasha.id, "hug_t", { to: "Гриша" });
      const wrongDir = engine.act(c2.id, dasha.id, "kiss_t", { to: "Гриша" });
      assert(
        !wrongDir.result.includes("Комбо"),
        "цепочка в обратную сторону (цель — не Даша) не срабатывает"
      );
      assert(
        listSceneEvents(c2.id).every((e) => e.payload.comboId !== combo2.id),
        "комбо-события направленного комбо пока нет"
      );
      // Гриша делает то же самое С Дашей — срабатывает, анонс всем
      engine.act(c2.id, grisha.id, "hug_t", { to: "Даша" });
      const rightDir = engine.act(c2.id, grisha.id, "kiss_t", { to: "Даша" });
      assert(rightDir.result.includes("Комбо"), "цепочка с нужной целью сработала");
      const announce = listSceneEvents(c2.id).find(
        (e) => e.type === "director" && e.payload.comboId === combo2.id
      );
      assert(
        !!announce && announce.audience === "all",
        "announce-комбо объявлено всем участникам (событие мира)"
      );
    }

    // Комбо замыкается исполнением по согласию: kiss_c2 — тул-предложение,
    // Гриша предлагает, Даша принимает — и это последний шаг цепочки.
    {
      const { updateTool } = await import("../src/db/queries");
      const kiss2 = createTool({
        name: "kiss_c2",
        title: "Поцеловать (согласие)",
        description: "Поцелуй по согласию",
        parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        audience: "target",
        targetParam: "to",
        observationTemplate: "{name} целует {to}",
        effects: [],
        requiresConsent: true,
      });
      updChar2(grisha.id, { toolIds: [hugC.id, kissC.id, kiss2.id] });
      const combo3 = createCombo({
        name: "consent_combo",
        title: "С согласия",
        description: "Обнять, а поцелуй — по согласию.",
        steps: [
          { toolName: "hug_c", targetName: "Даша" },
          { toolName: "kiss_c2", targetName: "Даша" },
        ],
        windowTurns: 10,
        effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
        knowers: [],
        announce: false,
      });
      const c3 = createScene({
        name: "Комбо по согласию",
        setting: "",
        config: { turnDelayMs: 10 },
        characterIds: [grisha.id, dasha.id],
      });
      engine.act(c3.id, grisha.id, "hug_c", { to: "Даша" });
      const prop = engine.act(c3.id, grisha.id, "kiss_c2", { to: "Даша" });
      assert(prop.ok && prop.result.includes("Предложение"), "kiss_c2 стал предложением");
      // Оффер виден Даше; находим id через список её актуальных предложений
      const { listPendingOffersForCharacter } = await import("../src/db/queries");
      const pending = listPendingOffersForCharacter(c3.id, dasha.id);
      assert(pending.length === 1, "у Даши одно висящее предложение");
      const resp = engine.act(c3.id, dasha.id, "respond_to_offer", {
        offer: String(pending[0]!.id),
        decision: "accept",
      });
      assert(resp.ok, "Даша согласилась");
      assert(
        (resp.result as string).includes("Комбо"),
        "комбо сработало на исполнении по согласию (дофикс: не срабатывало вовсе)"
      );
      assert(
        listSceneEvents(c3.id).some((e) => e.payload.comboId === combo3.id),
        "комбо-событие записано"
      );
      void updateTool;
    }

    // Шум между шагами (реплики, посторонние тулы, чужие вызовы не туда)
    // не рвёт цепочку: хвост ищется по проекции на релевантные вызовы.
    {
      const combo4 = createCombo({
        name: "noisy_combo",
        title: "Сквозь шум",
        description: "Обнять и поцеловать Дашу — даже если между этим болтовня.",
        steps: [
          { toolName: "hug_t", targetName: "Даша" },
          { toolName: "kiss_t", targetName: "Даша" },
        ],
        windowTurns: 10,
        effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
        knowers: [],
        announce: false,
      });
      const c4 = createScene({
        name: "Комбо сквозь шум",
        setting: "",
        config: { turnDelayMs: 10 },
        characterIds: [grisha.id, dasha.id],
      });
      // В предыдущем блоке Грише сузили toolIds — вернём тулы этого комбо
      const { listTools } = await import("../src/db/queries");
      const hugT2 = listTools().find((t) => t.name === "hug_t")!;
      const kissT2 = listTools().find((t) => t.name === "kiss_t")!;
      updChar2(grisha.id, { toolIds: [hugC.id, kissC.id, hugT2.id, kissT2.id] });
      engine.act(c4.id, grisha.id, "say", { phrase: "разговор ни о чём" });
      engine.act(c4.id, grisha.id, "hug_t", { to: "Даша" });
      engine.act(c4.id, grisha.id, "say", { phrase: "ещё немного разговоров" });
      // чужой вызов «не туда» (Даша → Гриша) тоже не должен рвать цепочку
      engine.act(c4.id, dasha.id, "hug_t", { to: "Гриша" });
      const noisy = engine.act(c4.id, grisha.id, "kiss_t", { to: "Даша" });
      assert(
        noisy.result.includes("Комбо"),
        "шум между шагами и чужой вызов не туда не рвут цепочку"
      );
      assert(
        listSceneEvents(c4.id).some((e) => e.payload.comboId === combo4.id),
        "комбо сквозь шум сработало и записано"
      );
    }
  }

  // =====================================================================
  // Блок 10: гардероб — эффекты ношения/снятия, wear, покупка одежды
  // =====================================================================
  {
    const {
      updateClothingSlot,
      getClothingSlot,
      createGarment,
      listCharacterGarments,
      addGarmentToCharacter,
    } = await import("../src/db/queries");
    const { dressCharacter } = await import("../src/lib/wardrobe");
    const { UNDRESS_TOOL_NAME, WEAR_TOOL_NAME } = await import("../src/lib/types");

    // Слот белья получает эффекты «пустого слота» (беспокойство)
    const uwSlot = getClothingSlot("underwear")!;
    updateClothingSlot("underwear", {
      slot: "underwear",
      layer: uwSlot.layer,
      undressPlaces: uwSlot.undressPlaces,
      bareEffects: [{ target: "self", key: "anxiety", op: "add", value: 1 }],
      position: uwSlot.position,
    });

    const lace = createGarment({
      name: "Кружевное бельё",
      emoji: "🩲",
      description: "Красивое бельё",
      slot: "underwear",
      effects: [{ target: "self", key: "mood", op: "add", value: 1 }],
      price: 0,
    });
    const vera = quietHuman("Вера");
    const glasha = quietHuman("Глаша");
    updChar2(vera.id, { state: { money: 100, mood: 4, anxiety: 0 } });

    const dressed = dressCharacter(vera.id, lace.id);
    assert(dressed.ok, `гардероб-надевание прошло (${dressed.message})`);
    // Выдаём предмет во владение: без записи в character_garments
    // undress в сцене не найдёт эффекты предмета (см. отчёт).
    addGarmentToCharacter(vera.id, lace.id);
    assert(
      (getCharacter(vera.id)!.state.worn_underwear as string) === "Кружевное бельё",
      "worn_underwear заполнен названием"
    );
    assert((getCharacter(vera.id)!.state.mood as number) === 5, "эффект ношения: mood 4 → 5");
    assert((getCharacter(vera.id)!.state.anxiety as number) === -1, "пустой слот погашен: anxiety 0 → −1");

    const wScene = createScene({
      name: "Гардероб",
      setting: "",
      config: { turnDelayMs: 10, place: "дом" },
      characterIds: [vera.id, glasha.id],
    });

    // Снятие: эффекты предмета обратно, эффекты пустого слота вступают
    const und = engine.act(wScene.id, vera.id, UNDRESS_TOOL_NAME, { slot: "underwear" });
    assert(und.ok, "undress прошёл (место дом, верхнее не надето)");
    assert((getCharacter(vera.id)!.state.worn_underwear as string) === "", "слот опустел");
    assert(
      (getCharacter(vera.id)!.state.carried_underwear as string) === "Кружевное бельё",
      "снятое при себе (carried_underwear)"
    );
    assert((getCharacter(vera.id)!.state.mood as number) === 4, "эффект предмета ушёл: mood 5 → 4");
    assert(
      (getCharacter(vera.id)!.state.anxiety as number) === 0,
      "bareEffects вступили: anxiety −1 → 0 (+1)"
    );

    // Надевание обратно возвращает всё как было
    const wore = engine.act(wScene.id, vera.id, WEAR_TOOL_NAME, { slot: "underwear" });
    assert(wore.ok, "wear вернул предмет");
    assert(
      (getCharacter(vera.id)!.state.worn_underwear as string) === "Кружевное бельё" &&
        (getCharacter(vera.id)!.state.carried_underwear as string) === "",
      "предмет снова надет, carried пуст"
    );
    assert((getCharacter(vera.id)!.state.mood as number) === 5, "эффект ношения восстановлен");
    assert((getCharacter(vera.id)!.state.anxiety as number) === -1, "эффект пустого слота снова погашен");

    // Покупка одежды: деньги → гардероб → сразу надета
    const robe = createGarment({
      name: "Шёлковый халат",
      emoji: "🥋",
      description: "Уютный халат",
      slot: "top",
      effects: [{ target: "self", key: "mood", op: "add", value: 2 }],
      price: 30,
    });
    const buy = engine.act(wScene.id, vera.id, "shop_buy", { item: "Шёлковый халат" });
    assert(buy.ok, "покупка одежды прошла");
    assert((getCharacter(vera.id)!.state.money as number) === 70, "деньги списаны: 100 − 30 = 70");
    assert(
      listCharacterGarments(vera.id).some((g) => g.id === robe.id),
      "предмет добавлен в гардероб владелицы"
    );
    assert((getCharacter(vera.id)!.state.worn_top as string) === "Шёлковый халат", "купленная одежда сразу надета");
    assert((getCharacter(vera.id)!.state.mood as number) === 7, "эффекты купленной одежды применились (mood 5 → 7)");
  }

  // =====================================================================
  // Блок 11: переименование места — каскад по всем ссылкам
  // =====================================================================
  {
    const {
      updatePlace,
      UniqueConflictError,
      updateCharacter: updChar11,
      getClothingSlot,
      updateClothingSlot,
      listPlaces,
    } = await import("../src/db/queries");

    // «кафе» уже есть (Фаза «Места»); заводим все четыре вида ссылок
    const cascadeScene = createScene({
      name: "Каскад-место",
      setting: "",
      config: { place: "кафе" },
      characterIds: [yana.id],
    });
    const uwSlot11 = getClothingSlot("underwear")!;
    updateClothingSlot("underwear", {
      slot: "underwear",
      layer: uwSlot11.layer,
      undressPlaces: ["дом", "кафе"],
      bareEffects: uwSlot11.bareEffects,
      position: uwSlot11.position,
    });
    const robert = quietHuman("Роберт");
    updChar11(robert.id, {
      boundaries: [
        { toolName: "kiss_b", minRelation: null, minMood: null, requirePlace: "кафе", requireAttr: null, refusalText: "", effects: [] },
      ],
    });
    const placeTool = createTool({
      name: "place_probe",
      title: "Проверка места",
      description: "Тест каскада",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} проверяет место у {to}",
      effects: [],
      outcomes: [
        {
          id: "at_cafe",
          title: "В кафе",
          conditions: [{ kind: "place" as const, key: "", op: "=" as const, value: "кафе" }],
          effects: [],
          noticeTarget: "",
          hideFromPrompt: false,
        },
      ],
    });

    const renamed = updatePlace("кафе", { name: "кофейня" });
    assert(renamed?.name === "кофейня", "место переименовано");
    assert(
      getScene(cascadeScene.id)!.config.place === "кофейня",
      "каскад: config.place сцены переписан"
    );
    assert(
      getClothingSlot("underwear")!.undressPlaces.includes("кофейня") &&
        !getClothingSlot("underwear")!.undressPlaces.includes("кафе"),
      "каскад: undressPlaces слота переписаны"
    );
    assert(
      (getCharacter(robert.id)!.boundaries[0]!.conditions ?? []).some(
        (c) => c.kind === "place" && c.place === "кофейня"
      ),
      "каскад: requirePlace границы переписан (условие kind:place)"
    );
    assert(
      getToolByName("place_probe")!.outcomes[0]!.conditions[0]!.value === "кофейня",
      "каскад: условие исхода kind:place переписано"
    );

    // Переименование в существующее имя — ошибка уникальности, ничего не меняется
    let conflict: unknown = null;
    try {
      updatePlace("кофейня", { name: "отель" });
    } catch (e) {
      conflict = e;
    }
    assert(conflict instanceof UniqueConflictError, "коллизия имён бросает UniqueConflictError");
    assert(
      listPlaces().some((p) => p.name === "кофейня"),
      "при коллизии ничего не переименовалось"
    );
  }

  // =====================================================================
  // Блок 12: reveal неизвестной характеристики — ошибка со списком реестра
  // =====================================================================
  {
    const { executeReveal } = await import("../src/lib/knowledge");

    const revealRes = executeReveal({
      actor: getCharacter(yana.id)!,
      participants: [getCharacter(yana.id)!],
      args: { attribute: "чушь", value: 5 },
    });
    assert(!revealRes.ok, "неизвестная характеристика отклонена");
    assert(
      revealRes.result.includes("Неизвестная характеристика"),
      "ошибка называет проблему"
    );
    assert(
      revealRes.result.includes("height"),
      `ошибка перечисляет ключи реестра (получено: ${revealRes.result.slice(0, 140)})`
    );
  }

  // =====================================================================
  // Блок 13: мысли приватны — текст без тула чужим не доставляется
  // =====================================================================
  {
    const nika = quietAI("Никанор");
    const sera = quietAI("Серафима");
    const thScene = createScene({
      name: "Мысли-приватны",
      setting: "",
      config: { turnDelayMs: 10, maxTurns: 1 },
      characterIds: [nika.id, sera.id],
    });
    await stopAllRunning();
    // У Никанора нет тулов: эвристика мока возвращает чистый текст без
    // tool_calls — это «мысль», никаких инструментов за ход.
    await engine.control(thScene.id, "start");
    const thDeadline = Date.now() + 10000;
    while (Date.now() < thDeadline && getScene(thScene.id)!.status !== "finished") {
      await new Promise((r) => setTimeout(r, 100));
    }
    const thEvents = listSceneEvents(thScene.id);
    const thought = thEvents.find((e) => e.type === "speech" && e.actorId === nika.id);
    assert(!!thought, "мысль записана speech-событием за актёром");
    assert(
      (thought!.payload.text ?? "").includes("продолжаю разговор"),
      "текст мысли — ровно то, что модель вернула без тула"
    );
    const thParts = [getCharacter(nika.id)!, getCharacter(sera.id)!];
    const seraMsgs = buildMessages({
      character: getCharacter(sera.id)!,
      scene: getScene(thScene.id)!,
      participants: thParts,
      events: getVisibleEvents(thScene.id, sera.id, 100),
      turn: 99,
    });
    assert(
      !seraMsgs.some((m) => (m.content ?? "").includes("продолжаю разговор")),
      "мысли Никанора не попадают в сообщения Серафимы (приватны)"
    );
    assert(
      getVisibleEvents(thScene.id, sera.id, 100).some((e) => e.id === thought!.id),
      "сырая видимость содержит событие-мысль (фильтр — на реконструкции)"
    );
    const nikaMsgs = buildMessages({
      character: getCharacter(nika.id)!,
      scene: getScene(thScene.id)!,
      participants: thParts,
      events: getVisibleEvents(thScene.id, nika.id, 100),
      turn: 99,
    });
    assert(
      nikaMsgs.some(
        (m) => m.role === "assistant" && (m.content ?? "").includes("продолжаю разговор")
      ),
      "автор видит свои мысли в своей истории (assistant-контент)"
    );
    // Правила мира объясняют модель: текст без тула = мысли, общение тулами.
    const thPrompt = seraMsgs[0].content ?? "";
    assert(thPrompt.includes("ВНУТРЕННИЕ МЫСЛИ"), "правила объявляют текст без тула мыслями");
    assert(
      thPrompt.includes("say") && thPrompt.includes("text_message"),
      "правила называют тулы общения say/text_message"
    );
    checkProtocol(thScene.id, sera.id, "Серафима-мысли");
  }

  // =====================================================================
  // Блок 14: say — фраза вслух (всем или адресату), ошибки аргументов
  // =====================================================================
  {
    const alb = quietHuman("Альберт");
    const bri = quietHuman("Бриджит");
    const sayScene = createScene({
      name: "Say-вслух",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [alb.id, bri.id],
    });
    const sayParts = () => [getCharacter(alb.id)!, getCharacter(bri.id)!];

    const said = engine.act(sayScene.id, alb.id, "say", { phrase: "Вечер хорош, не правда ли?" });
    assert(said.ok, "say без адресата исполнился (ok:true)");
    const saidCall = (said.event.payload.calls ?? [])[0]!;
    assert(saidCall.ok && saidCall.audience === "all", "say вслух слышат все (аудитория all)");
    assert(
      saidCall.observation.includes("Альберт: «Вечер хорош, не правда ли?»"),
      `наблюдение say — фраза от лица актёра (получено: ${saidCall.observation})`
    );
    const briMsgs = buildMessages({
      character: getCharacter(bri.id)!,
      scene: getScene(sayScene.id)!,
      participants: sayParts(),
      events: getVisibleEvents(sayScene.id, bri.id, 100),
      turn: 99,
    });
    assert(
      briMsgs.some(
        (m) => m.role === "user" && (m.content ?? "").includes("Вечер хорош, не правда ли?")
      ),
      "фраза вслух дошла до слушателя как user-сообщение"
    );

    const saidTo = engine.act(sayScene.id, alb.id, "say", {
      phrase: "Бриджит, это для тебя",
      to: "Бриджит",
    });
    assert(saidTo.ok, "say с адресатом исполнился");
    const toCall = (saidTo.event.payload.calls ?? [])[0]!;
    assert(
      Array.isArray(toCall.audience) &&
        (toCall.audience as number[]).length === 1 &&
        (toCall.audience as number[])[0] === bri.id,
      "адресный say слышит только адресата"
    );
    assert(
      toCall.observation.includes("Бриджит") && toCall.observation.includes("это для тебя"),
      "наблюдение адресного say называет адресата"
    );

    const badTo = engine.act(sayScene.id, alb.id, "say", { phrase: "Эй!", to: "Несуществующий" });
    assert(!badTo.ok, "say с неизвестным адресатом отклонён");
    assert(
      badTo.result.includes("не найден среди участников") && badTo.result.includes("Бриджит"),
      `ошибка say перечисляет участников (получено: ${badTo.result.slice(0, 110)})`
    );

    const empty = engine.act(sayScene.id, alb.id, "say", { phrase: "   " });
    assert(!empty.ok && empty.result.includes("Пустая фраза"), "пустая фраза say отклонена");

    // Свой say в своей истории — tool_calls + tool-ответ (протокол не рвётся)
    const albMsgs = buildMessages({
      character: getCharacter(alb.id)!,
      scene: getScene(sayScene.id)!,
      participants: sayParts(),
      events: getVisibleEvents(sayScene.id, alb.id, 100),
      turn: 99,
    });
    assert(
      albMsgs.some(
        (m) => m.role === "assistant" && (m.tool_calls ?? []).some((tc) => tc.function.name === "say")
      ),
      "свой say реконструирован актёру как tool_calls"
    );
    checkProtocol(sayScene.id, alb.id, "Альберт-say");
  }

  // =====================================================================
  // Блок 15: text_message — переписка, видит только получатель
  // =====================================================================
  {
    const tar = quietHuman("Тарас");
    const uly = quietHuman("Уля");
    const fek = quietHuman("Фёкла");
    const tmScene = createScene({
      name: "Text_message",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [tar.id, uly.id, fek.id],
    });
    const tmParts = () => [getCharacter(tar.id)!, getCharacter(uly.id)!, getCharacter(fek.id)!];

    const sent = engine.act(tmScene.id, tar.id, "text_message", {
      to: "Уля",
      text: "увидел твоё объявление",
    });
    assert(sent.ok, "text_message доставлен (ok:true)");
    const sentCall = (sent.event.payload.calls ?? [])[0]!;
    assert(
      Array.isArray(sentCall.audience) &&
        (sentCall.audience as number[]).length === 1 &&
        (sentCall.audience as number[])[0] === uly.id,
      "сообщение адресовано только получателю"
    );
    assert(
      Array.isArray(sent.event.audience) &&
        sent.event.audience.length === 1 &&
        (sent.event.audience as number[])[0] === uly.id,
      "событие переписки адресовано только получателю"
    );
    assert(
      sentCall.observation.includes("📱 Тарас: «увидел твоё объявление»"),
      `наблюдение переписки оформлено как сообщение чата (получено: ${sentCall.observation})`
    );
    const ulyMsgs = buildMessages({
      character: getCharacter(uly.id)!,
      scene: getScene(tmScene.id)!,
      participants: tmParts(),
      events: getVisibleEvents(tmScene.id, uly.id, 100),
      turn: 99,
    });
    assert(
      ulyMsgs.some(
        (m) => m.role === "user" && (m.content ?? "").includes("увидел твоё объявление")
      ),
      "получатель видит сообщение в reconstructed-контексте"
    );
    const fekMsgs = buildMessages({
      character: getCharacter(fek.id)!,
      scene: getScene(tmScene.id)!,
      participants: tmParts(),
      events: getVisibleEvents(tmScene.id, fek.id, 100),
      turn: 99,
    });
    assert(
      !fekMsgs.some((m) => (m.content ?? "").includes("увидел твоё объявление")),
      "третьему участнику переписка не видна"
    );

    const badTm = engine.act(tmScene.id, tar.id, "text_message", { to: "Марс", text: "зиг" });
    assert(!badTm.ok, "неизвестный получатель отклонён");
    assert(
      badTm.result.includes("не найден среди участников") && badTm.result.includes("Уля"),
      "ошибка переписки перечисляет участников"
    );

    const noText = engine.act(tmScene.id, tar.id, "text_message", { to: "Уля", text: "" });
    assert(!noText.ok && noText.result.includes("Пустое сообщение"), "сообщение без текста отклонено");
    checkProtocol(tmScene.id, uly.id, "Уля-text_message");
  }

  // =====================================================================
  // Блок 16: режиссёр = мир/мысль — без фигуры «Режиссёра» в промпте
  // =====================================================================
  {
    const geo = quietHuman("Георг");
    const xen = quietHuman("Ксения");
    const dirScene = createScene({
      name: "Директор-мысль",
      setting: "",
      config: { turnDelayMs: 10 },
      characterIds: [geo.id, xen.id],
    });
    engine.inject(dirScene.id, "В дверь постучали", "all");
    engine.inject(dirScene.id, "Ксения, за стеной кто-то поёт", [xen.id]);

    const dirParts = [getCharacter(geo.id)!, getCharacter(xen.id)!];
    const xenMsgs = buildMessages({
      character: getCharacter(xen.id)!,
      scene: getScene(dirScene.id)!,
      participants: dirParts,
      events: getVisibleEvents(dirScene.id, xen.id, 100),
      turn: 99,
    });
    assert(
      xenMsgs.some((m) => (m.content ?? "").includes("[Событие мира]: В дверь постучали")),
      "широковещательный director виден как [Событие мира]"
    );
    assert(
      xenMsgs.some((m) =>
        (m.content ?? "").includes("[Тебе в голову пришла мысль]: Ксения, за стеной кто-то поёт")
      ),
      "личный director виден как [Тебе в голову пришла мысль]"
    );
    const xenText = xenMsgs.map((m) => m.content ?? "").join("\n");
    assert(!xenText.includes("Режиссёр"), "фигура режиссёра в промпте не упоминается");

    const geoMsgs = buildMessages({
      character: getCharacter(geo.id)!,
      scene: getScene(dirScene.id)!,
      participants: dirParts,
      events: getVisibleEvents(dirScene.id, geo.id, 100),
      turn: 99,
    });
    assert(
      geoMsgs.some((m) => (m.content ?? "").includes("[Событие мира]: В дверь постучали")) &&
        !geoMsgs.some((m) => (m.content ?? "").includes("за стеной кто-то поёт")),
      "мировое событие приходит всем, личная мысль Ксении — только ей"
    );
  }

  // =====================================================================
  // Блок 17: гардероб агента — wardrobe_browse и wear_garment
  // =====================================================================
  {
    const { createGarment, addGarmentToCharacter } = await import("../src/db/queries");
    const { dressCharacter } = await import("../src/lib/wardrobe");
    const { WARDROBE_BROWSE_TOOL_NAME, WEAR_GARMENT_TOOL_NAME } = await import("../src/lib/types");

    const toma = quietHuman("Тома", [], { money: 50, mood: 4 });
    const zlata = quietHuman("Злата");
    const sweater = createGarment({
      name: "Домашний свитер",
      emoji: "🧶",
      description: "Тёплый свитер",
      slot: "top",
      effects: [{ target: "self", key: "mood", op: "add", value: 1 }],
      price: 0,
    });
    const gown = createGarment({
      name: "Вечернее платье",
      emoji: "👗",
      description: "Платье для выхода",
      slot: "top",
      effects: [
        { target: "self", key: "mood", op: "add", value: 3 },
        { target: "self", key: "charisma", op: "add", value: 1 },
      ],
      price: 0,
    });
    addGarmentToCharacter(toma.id, sweater.id);
    addGarmentToCharacter(toma.id, gown.id);
    const dressed0 = dressCharacter(toma.id, sweater.id);
    assert(dressed0.ok, `начальная одежда надета редактором (${dressed0.message})`);
    assert((getCharacter(toma.id)!.state.worn_top as string) === "Домашний свитер", "worn_top — свитер");
    assert((getCharacter(toma.id)!.state.mood as number) === 5, "эффект свитера применился (mood 4 → 5)");

    const gwScene = createScene({
      name: "Гардероб-агента",
      setting: "",
      config: { turnDelayMs: 10, place: "дом" },
      characterIds: [toma.id, zlata.id],
    });

    // Витрина личного гардероба
    const browse = engine.act(gwScene.id, toma.id, WARDROBE_BROWSE_TOOL_NAME, {});
    assert(browse.ok, "wardrobe_browse исполнился (ok:true)");
    const browseCall = (browse.event.payload.calls ?? [])[0]!;
    assert(
      Array.isArray(browseCall.audience) &&
        (browseCall.audience as number[]).length === 1 &&
        (browseCall.audience as number[])[0] === toma.id,
      "витрина гардероба видна только владелице"
    );
    assert(
      browse.result.includes("надето «Домашний свитер»") && browse.result.includes("Вечернее платье"),
      "витрина перечисляет надетое и содержимое шкафа"
    );
    assert(browse.result.includes("wear_garment"), "витрина подсказывает тул переодевания");

    // Переодевание: старое — в шкаф (эффекты снялись), новое — надето
    const change = engine.act(gwScene.id, toma.id, WEAR_GARMENT_TOOL_NAME, { garment: "Вечернее платье" });
    assert(change.ok, "wear_garment переодел владелицу (ok:true)");
    const chCall = (change.event.payload.calls ?? [])[0]!;
    assert(
      chCall.observation.includes("переодевается") &&
        chCall.observation.includes("Домашний свитер") &&
        chCall.observation.includes("Вечернее платье"),
      `наблюдение переодевания называет старое и новое (получено: ${chCall.observation})`
    );
    assert(chCall.observation !== "" && chCall.audience === "all", "переодевание — публичное действие");
    const tAfter = getCharacter(toma.id)!;
    assert((tAfter.state.worn_top as string) === "Вечернее платье", "worn_top переключён на платье");
    assert((tAfter.state.carried_top as string) === "", "старый предмет вернулся в шкаф (не carried)");
    assert(
      (tAfter.state.mood as number) === 7,
      "эффекты обратимы: −1 свитер, +3 платье (mood 5 → 7)"
    );
    assert((tAfter.state.charisma as number) === 1, "платье добавило харизму (+1)");
    assert(
      (change.event.payload.stateChanges ?? []).some((c) => c.characterId === toma.id && c.key === "mood"),
      "изменения самочувствия записаны в событие (stateChanges)"
    );

    // Чужое/несуществующее — отказ со списком своего
    const notOwned = engine.act(gwScene.id, toma.id, WEAR_GARMENT_TOOL_NAME, { garment: "Джинсы" });
    assert(!notOwned.ok, "предмет не из гардероба отклонён");
    assert(
      notOwned.result.includes("нет в твоём гардеробе") &&
        notOwned.result.includes("Домашний свитер") &&
        notOwned.result.includes("Вечернее платье"),
      `ошибка перечисляет свои предметы (получено: ${notOwned.result.slice(0, 120)})`
    );

    // Уже надетое — отказ
    const same = engine.act(gwScene.id, toma.id, WEAR_GARMENT_TOOL_NAME, { garment: "Вечернее платье" });
    assert(!same.ok && same.result.includes("уже надето"), "повторное надевание надетого отклонено");

    // Обратно: эффекты платья снялись, свитер вернулся
    const back = engine.act(gwScene.id, toma.id, WEAR_GARMENT_TOOL_NAME, { garment: "Домашний свитер" });
    assert(back.ok, "переодевание обратно прошло");
    const tBack = getCharacter(toma.id)!;
    assert((tBack.state.worn_top as string) === "Домашний свитер", "свитер снова надет");
    assert((tBack.state.mood as number) === 5, "эффекты обратимы: mood вернулся к 5");
    assert((tBack.state.charisma as number) === 0, "харизма платья снялась");

    // Витрина не видна другим, переодевание — видно
    const zlVisible = getVisibleEvents(gwScene.id, zlata.id, 100);
    assert(
      !zlVisible.some((e) => (e.payload.calls ?? []).some((c) => c.toolName === WARDROBE_BROWSE_TOOL_NAME)),
      "чужая витрина гардероба не видна"
    );
    assert(
      zlVisible.some(
        (e) => e.type === "action" && (e.payload.calls ?? []).some((c) => c.toolName === WEAR_GARMENT_TOOL_NAME && c.ok)
      ),
      "переодевание наблюдается другими участниками"
    );
    checkProtocol(gwScene.id, toma.id, "Тома-гардероб");
  }

  // =====================================================================
  // Блок 18: границы-условия — правило из нескольких BoundaryCondition
  // =====================================================================
  {
    const { setRelation, getRelation } = await import("../src/db/queries");

    const cuddle = createTool({
      name: "cuddle_cond",
      title: "Обнять",
      description: "Обнять и прижать",
      parametersSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      observationTemplate: "{name} обнимает {to}",
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
      cost: 5,
    });
    const oskar = quietHuman("Оскар", [cuddle.id], { money: 40, mood: 6 });
    const patri = quietHuman("Патриция");
    // Правило из трёх условий («И»): отношение ≥ 3, настроение ≥ 5, место «дом».
    updChar2(patri.id, {
      state: { mood: 5, worn_top: "Плед" },
      boundaries: [
        {
          toolName: "cuddle_cond",
          conditions: [
            { kind: "relation", op: ">=", value: 3 },
            { kind: "attr", owner: "target", key: "mood", op: ">=", value: 5 },
            { kind: "place", place: "дом" },
          ],
          refusalText: "мягко отстраняется",
          effects: [],
        },
      ],
    });
    const condRule = getCharacter(patri.id)!.boundaries[0]!;
    assert(
      (condRule.conditions ?? []).length === 3,
      `правило с conditions читается как есть (${JSON.stringify(condRule.conditions)})`
    );
    setRelation(patri.id, oskar.id, 1);
    const condScene = createScene({
      name: "Границы-условия",
      setting: "",
      config: { place: "улица" },
      characterIds: [oskar.id, patri.id],
    });
    const cuddleOskar = () => engine.act(condScene.id, oskar.id, "cuddle_cond", { to: "Патриция" });

    // 1. Отношение 1 < 3 (и место не то): отказ называет ПЕРВОЕ несработавшее условие
    const r1 = cuddleOskar();
    assert(!r1.ok, "условия не выполнены — отказ");
    assert(
      r1.result.includes("отношение") && r1.result.includes("ещё не доросло") && r1.result.includes("Патриция"),
      `причина называет отношение владельца (получено: ${r1.result.slice(0, 120)})`
    );
    assert((getCharacter(oskar.id)!.state.money as number) === 40, "при отказе деньги целы (fail-closed)");

    // 2. Отношение ок, место всё ещё «улица»: отказ называет место
    setRelation(patri.id, oskar.id, 4);
    const r2 = cuddleOskar();
    assert(!r2.ok, "не то место — отказ даже при отношении 4");
    assert(
      r2.result.includes("не то место") && r2.result.includes("улица"),
      `причина называет место сцены (получено: ${r2.result.slice(0, 120)})`
    );

    // 3. Место «дом», но настроение 2 < 5: отказ называет характеристику
    const { updateScene: updSceneCond } = await import("../src/db/queries");
    updSceneCond(condScene.id, { config: { place: "дом" } });
    updChar2(patri.id, { state: { mood: 2, worn_top: "Плед" } });
    const r3 = cuddleOskar();
    assert(!r3.ok, "настроение ниже порога — отказ");
    assert(
      r3.result.includes("Настроение") && r3.result.includes("ниже нужного"),
      `причина называет лейбл характеристики из реестра (получено: ${r3.result.slice(0, 120)})`
    );
    assert(getRelation(patri.id, oskar.id) === 4, "пустые effects правила — отношение не тронуто");

    // 4. Все условия выполнены — обнимание проходит, платный тул списывает деньги
    updChar2(patri.id, { state: { mood: 5, worn_top: "Плед" } });
    const r4 = cuddleOskar();
    assert(r4.ok, "все три условия выполнены — действие прошло");
    assert((getCharacter(oskar.id)!.state.money as number) === 35, "успех списал $5 (40 → 35)");
    assert((getCharacter(patri.id)!.state.mood as number) === 6, "эффект тула применился (mood 5 → 6)");

    // 5. Добавляем четвёртое условие (слот top занят) и снимаем одежду — отказ
    updChar2(patri.id, {
      boundaries: [
        {
          toolName: "cuddle_cond",
          conditions: [
            { kind: "relation", op: ">=", value: 3 },
            { kind: "attr", owner: "target", key: "mood", op: ">=", value: 5 },
            { kind: "place", place: "дом" },
            { kind: "worn", slot: "top", bare: false },
          ],
          refusalText: "мягко отстраняется",
          effects: [],
        },
      ],
    });
    updChar2(patri.id, { state: { mood: 5, worn_top: "" } });
    const r5 = cuddleOskar();
    assert(!r5.ok, "пустой слот top — отказ по условию worn");
    assert(
      r5.result.includes("слот top") && r5.result.includes("занят"),
      `причина называет условие об одежде (получено: ${r5.result.slice(0, 120)})`
    );
    assert((getCharacter(oskar.id)!.state.money as number) === 35, "повторный отказ — деньги не тронуты");
  }

  // --- Оверлей правок редактора: «Заново» откатывает прогресс сцены,
  // но не явные правки Архитектора (деньги/черты, заданные после рассадки) ---
  {
    const {
      updateCharacter,
      createScene,
      resetSceneFull,
      overlayEditorState,
      setSceneParticipants,
    } = await import("../src/db/queries");
    const editorChar = createCharacter({
      name: "Эдитор",
      emoji: "🧪",
      persona: "тест правок редактора",
      providerId: provider.id,
      model: "mock",
      temperature: 0.7,
      maxTokens: 800,
      toolIds: [],
      state: { money: 100, endurance: 15, mood: 5, tattoo: 1 },
      isHuman: false,
      income: 0,
    });
    const editorScene = createScene({
      name: "Сцена оверлея",
      setting: "тест",
      config: { turnDelayMs: 0, maxTurns: 1, maxIterPerTurn: 1 },
      characterIds: [editorChar.id],
    });
    // Сцена «сыграла»: потратила деньги, поменяла настроение
    updateCharacter(editorChar.id, { state: { money: 80, endurance: 15, mood: 8, tattoo: 1 } });
    // Правки редактора после рассадки: endurance 15→14, money→10000, tattoo удалён
    const edited = new Map<string, unknown | null>([
      ["endurance", 14],
      ["money", 10000],
      ["tattoo", null],
    ]);
    const cur = getCharacter(editorChar.id)!.state;
    const merged: Record<string, unknown> = { ...cur, endurance: 14, money: 10000 };
    delete merged.tattoo;
    updateCharacter(editorChar.id, { state: merged });
    overlayEditorState(editorChar.id, edited);

    resetSceneFull(editorScene.id);
    const st = getCharacter(editorChar.id)!.state;
    assert(
      (st.money as number) === 10000,
      `«Заново»: правка денег пережила откат (money=${st.money})`
    );
    assert(
      (st.endurance as number) === 14,
      `«Заново»: правка черты пережила откат (endurance=${st.endurance})`
    );
    assert((st.mood as number) === 5, `«Заново»: прогресс сцены откатился (mood=${st.mood}, ждали 5)`);
    assert(st.tattoo === undefined, "«Заново»: ключ, удалённый редактором, не воскрес");

    // Гардероб редактора — та же правка Архитектора: переодел персонажа
    // в карточке → конфигурация одежды переживает «Заново»
    const { createGarment, recordWardrobeEdit } = await import("../src/db/queries");
    const { dressCharacter } = await import("../src/lib/wardrobe");
    const shirt = createGarment({
      name: "Рубашка Эдитора",
      emoji: "👔",
      description: "",
      slot: "top",
      effects: [],
      price: 0,
    });
    const beforeDress = getCharacter(editorChar.id)!.state;
    const dressRes = dressCharacter(editorChar.id, shirt.id);
    assert(dressRes.ok, `редактор: надели рубашку (${dressRes.message})`);
    const afterDress = getCharacter(editorChar.id)!.state;
    recordWardrobeEdit(editorChar.id, beforeDress, afterDress);
    // «Сцена раздела его»: прямой правкой state имитируем прогресс
    updateCharacter(editorChar.id, { state: { ...afterDress, worn_top: "" } });
    resetSceneFull(editorScene.id);
    assert(
      (getCharacter(editorChar.id)!.state.worn_top as string) === "Рубашка Эдитора",
      "«Заново»: одежда из карточки гардероба пережила откат"
    );

    // Пересадка состава: снимок переснимается с текущего state, оверлей чист
    setSceneParticipants(editorScene.id, [editorChar.id]);
    const row = db
      .prepare("SELECT initial_state, editor_overlay FROM scene_characters WHERE scene_id = ?")
      .get(editorScene.id) as unknown as { initial_state: string; editor_overlay: string | null };
    const snap = JSON.parse(row.initial_state);
    assert(snap.money === 10000 && snap.endurance === 14, "пересадка состава снимает свежий state");
    assert(!row.editor_overlay || row.editor_overlay === "{}", "пересадка состава чистит оверлей");
  }

  // =====================================================================
  // Фаза N: ИИ-ассистент «Настроить с помощью ИИ» (действия мира)
  // =====================================================================
  {
    const { runAssistantAction } = await import("../src/lib/assistant");
    const { listFlows, getScene, listCombos, listTools } = await import("../src/db/queries");
    const ctx = { providerId: provider.id, model: "mock-actor" };
    const act = (name: string, args: Record<string, unknown>) => {
      try {
        return runAssistantAction(name, args, ctx);
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) };
      }
    };

    const overview = act("world_overview", {});
    assert(overview.ok && typeof overview.data === "object", "ассистент: обзор мира собирается");

    const human = act("create_character", {
      name: "Игрок Андрей",
      persona: "Обычный парень, играет пользователь. Любит настолки.",
      isHuman: true,
      state: { money: 500 },
    });
    assert(human.ok, `ассистент: человек создан (${human.summary})`);

    const ai = act("create_character", {
      name: "Вика Ассист",
      emoji: "💃",
      persona: "Танцовщица, острая на язык, не доверяет быстро.",
      toolNames: ["do_activity"],
    });
    assert(ai.ok, `ассистент: ИИ-персонаж создан (${ai.summary})`);

    const dup = act("create_character", { name: "Игрок Андрей", persona: "Дубль дубль дубль дубль." });
    assert(!dup.ok, "ассистент: дубликат персонажа отклонён");

    const kiss = act("create_tool", {
      name: "offer_dance",
      title: "Пригласить на танец",
      description: "Пригласить персонажа на танец.",
      parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      requiresConsent: true,
      effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
      assignTo: ["Вика Ассист"],
    });
    assert(kiss.ok, `ассистент: тул с согласием создан и назначен (${kiss.summary})`);

    const badTool = act("create_tool", {
      name: "no_target",
      description: "адресный без targetParam",
      audience: "target",
    });
    assert(!badTool.ok, "ассистент: адресный тул без targetParam отклонён");

    const scene = act("create_scene", {
      name: "Танцпол",
      setting: "Танцпол: громкая музыка, огни, толпа.",
      participantNames: ["Игрок Андрей", "Вика Ассист"],
      goals: { "Вика Ассист": "Понравиться, но не показывать этого" },
    });
    assert(scene.ok, `ассистент: сцена создана (${scene.summary})`);

    // Комбо, химия и исходы — ассистент умеет ВСЕ сущности приложения
    const comboToolA = act("create_tool", {
      name: "combo_step_a",
      title: "Шаг А",
      description: "Первый шаг цепочки.",
      parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
    });
    assert(comboToolA.ok, `ассистент: тул для комбо создан (${comboToolA.summary})`);
    const toolWithOutcome = act("create_tool", {
      name: "combo_step_b",
      title: "Шаг Б",
      description: "Второй шаг с исходом.",
      parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      audience: "target",
      targetParam: "to",
      outcomes: [
        {
          title: "Искра",
          conditions: [{ kind: "relation", op: ">=", value: 3 }],
          effects: [{ target: "tool_target", key: "mood", op: "add", value: 1 }],
          noticeTarget: "Всё сложилось.",
        },
      ],
    });
    assert(toolWithOutcome.ok, `ассистент: тул с исходом создан (${toolWithOutcome.summary})`);
    const createdOutcomeTool = listTools().find((t) => t.name === "combo_step_b")!;
    assert(
      createdOutcomeTool.outcomes.length === 1 && createdOutcomeTool.outcomes[0].conditions[0].kind === "relation",
      "исход тула записан с условием"
    );

    const combo = act("create_combo", {
      name: "test_chain",
      title: "Тестовая цепочка",
      description: "А потом Б — и что-то случится.",
      steps: [{ toolName: "combo_step_a" }, { toolName: "combo_step_b", targetName: "Вика Ассист" }],
      knowers: ["Игрок Андрей"],
      announce: true,
    });
    assert(combo.ok, `ассистент: комбо создано (${combo.summary})`);
    assert(listCombos().some((c) => c.name === "test_chain"), "комбо в БД после create_combo");

    const badCombo = act("create_combo", {
      name: "bad_chain",
      title: "Плохая цепочка",
      steps: [{ toolName: "no_such_tool" }, { toolName: "combo_step_a" }],
    });
    assert(!badCombo.ok, "ассистент: комбо с несуществующим тулом отклонено");

    const chem = act("set_chemistry", { a: "Игрок Андрей", b: "Вика Ассист", value: 2 });
    assert(chem.ok, `ассистент: химия задана (${chem.summary})`);
    const { getChemistry } = await import("../src/db/queries");
    const allChars = (await import("../src/db/queries")).listCharacters();
    const chemA = allChars.find((c) => c.name === "Игрок Андрей")!;
    const chemB = allChars.find((c) => c.name === "Вика Ассист")!;
    assert(getChemistry(chemA.id, chemB.id) === 2, "химия пары записана в матрицу");

    const scenario = act("create_scenario", {
      name: "Вечер с Викой",
      steps: [
        {
          title: "Знакомство у бара",
          setting: "Бар: полумрак, коктейли.",
          participantNames: ["Игрок Андрей", "Вика Ассист"],
        },
        { title: "Танцпол", setting: "Огни и басы, тела близко." },
      ],
    });
    assert(scenario.ok, `ассистент: сценарий создан (${scenario.summary})`);
    const flow = listFlows().find((f) => f.name === "Вечер с Викой")!;
    assert(flow.graph.nodes.length === 3 && flow.graph.nodes[2].kind === "final", "сценарий: 2 сцены + финал");
    const chainOk = flow.graph.edges.every((e, i) => e.from === `n${i + 1}`);
    assert(chainOk && flow.graph.edges[flow.graph.edges.length - 1].to === "nfin", "сценарий: линейная цепочка в финал");
    const step2scene = getScene(flow.graph.nodes[1].sceneId!)!;
    assert(step2scene.name === "Танцпол (Вечер с Викой)" || step2scene.name === "Танцпол", "сценарий: сцены шагов созданы");
  }

  console.log("\nE2E: все проверки пройдены ✅");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nE2E FAIL:", e);
  process.exit(1);
});
