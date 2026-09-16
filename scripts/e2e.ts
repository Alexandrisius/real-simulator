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
  assert(dimaVis.some((e) => e.id === humanSpeech!.id), "ИИ видит речь человека");
  assert(dimaVis.some((e) => e.id === humanAct!.id), "ИИ видит личное сообщение от человека");
  assert(getScene(mixed.id)!.cursor >= 1, "автостарт привёл к ходам ИИ (человек в ротацию не входит)");
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
    assert(dimaSees.includes("Место: дом"), "место сцены попало в промпт");
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
    updChar2(dima.id, { toolIds: [kiss.id, sex.id], state: { money: 100, mood: 3, penis: 15 } });
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
          requireAttr: { owner: "actor", key: "penis", op: ">=", value: 18 },
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
      !!refEvent && Array.isArray(refEvent.audience) && (refEvent.audience as number[]).includes(yana.id),
      "попытка автоматически видна цели"
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

    // 4. В доме, но физика не проходит (penis 15 < 18) — отказ всегда
    updScene(boundScene.id, { config: { place: "дом" } });
    const homeSex = engine.act(boundScene.id, dima.id, "try_sex", { who: "Яна" });
    assert(!homeSex.ok && homeSex.result.includes("penis"), "дома близость отклонена физикой (15 < 18)");

    // 5. Физика проходит — успех
    updChar2(dima.id, { state: { money: 95, mood: 3, penis: 18 } });
    const okSex = engine.act(boundScene.id, dima.id, "try_sex", { who: "Яна" });
    assert(okSex.ok, "при penis=18 и месте «дом» близость проходит");

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
    updChar2(dima.id, { toolIds: [kiss.id], state: { money: 95, mood: 3, penis: 18 } });
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
    updChar2(dima.id, { toolIds: [msgTool.id], state: { money: 95, mood: 3, penis: 18 } });
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
  // Фаза 3: знания, заявления, ложь, разоблачение
  // =====================================================================
  {
    const { knowledgeOf, knowledgeAbout, updateScene: updScene } = await import("../src/db/queries");
    const { executeReveal, verifyForObserver, hasHiddenAttributes } = await import("../src/lib/knowledge");
    const { REVEAL_TOOL_NAME } = await import("../src/lib/types");

    // Скрытая характеристика Димы
    attr("penis", "Достоинство", { emoji: "🍆", visibility: "hidden", liePenalty: 2, coveredBy: [] });
    updChar2(dima.id, { state: { money: 95, mood: 3, penis: 15 } });
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
    assert(!yanaBefore.includes("penis"), "до заявления скрытая характеристика не существует для наблюдателя");

    // Дима заявляет 20 (истина 15) — лично Яне
    const claim = engine.act(knowScene.id, dima.id, REVEAL_TOOL_NAME, {
      attribute: "penis",
      value: 20,
      to: "Яна",
    });
    assert(claim.ok, "reveal_attribute работает через единый путь act");
    const kn = knowledgeAbout(yana.id, dima.id);
    assert(kn.some((k) => k.key === "penis" && k.status === "claimed" && k.value === "20"), "заявление записано как claimed");
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
      key: "penis",
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
    assert(kn2.some((k) => k.key === "penis" && k.status === "verified" && k.value === "15"), "запись стала verified с истиной");

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
      key: "penis",
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

    // penis теперь прикрыт бельём
    const { updateAttribute: updAttr } = await import("../src/db/queries");
    const penisDef = listAttributes().find((a) => a.key === "penis")!;
    updAttr(penisDef.id, {
      key: "penis", label: penisDef.label, emoji: penisDef.emoji, type: penisDef.type,
      unit: penisDef.unit, min: penisDef.min, max: penisDef.max, options: penisDef.options,
      position: penisDef.position, visibility: "hidden", liePenalty: 2, coveredBy: ["underwear"],
    });

    updC(dima.id, {
      state: {
        money: 95, mood: 3, penis: 15,
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
    engine.act(clothScene.id, dima.id, "reveal_attribute", { attribute: "penis", value: 20, to: "Яна" });
    assert(knowledgeAbout(yana.id, dima.id).some((k) => k.key === "penis" && k.status === "claimed"), "новое заявление вернуло статус claimed");
    const relBefore = getRelation(yana.id, dima.id);

    const uw = engine.act(clothScene.id, dima.id, UNDRESS_TOOL_NAME, { slot: "underwear" });
    assert(uw.ok, "бельё снимается после верхнего");
    assert(uw.result.includes("видят") || uw.result.includes("видит"), "ответ модели упоминает открывшееся");
    const knUw = knowledgeAbout(yana.id, dima.id).find((k) => k.key === "penis");
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
    assert(knowledgeAbout(yana.id, dima.id).some((k) => k.key === "penis" && k.status === "verified"), "память (verified) не забывается при одевании");

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
    upsertClaim({ observerId: yana.id, subjectId: dima.id, key: "penis", value: 25 });
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

  console.log("\nE2E: все проверки пройдены ✅");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nE2E FAIL:", e);
  process.exit(1);
});
