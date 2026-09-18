# REST API real-simulator

База: `http://localhost:3999` (или порт dev-сервера). Все запросы и ответы —
JSON. Ошибки: `{"error": "текст"}`, 400 при нарушении zod-схемы. Точные схемы
полей — `src/lib/api.ts`; ниже — рабочие примеры, покрывающие 90% задач.
Поля в payload — camelCase (`providerId`, `maxTokens`, `characterIds`).

## Провайдеры

```bash
# Создать (kind: lmstudio | openrouter | opencode | openai-compatible | mock)
curl -s http://localhost:3999/api/providers -H "Content-Type: application/json" \
  -d '{"name":"LM Studio","kind":"lmstudio","baseUrl":"http://localhost:1234/v1"}'

# OpenCode Go (подписка opencode.ai/auth): шлюз OpenAI-совместимый,
# заголовок x-opencode-session приложение ставит само
curl -s http://localhost:3999/api/providers -H "Content-Type: application/json" \
  -d '{"name":"OpenCode Go","kind":"opencode","baseUrl":"https://opencode.ai/zen/go/v1","apiKey":"..."}'

# Список моделей / проверка соединения
curl -s "http://localhost:3999/api/providers/1/models?test=1"
```

## Инструменты

```bash
# Обычный адресный тул
curl -s http://localhost:3999/api/tools -H "Content-Type: application/json" -d '{
  "name": "compliment",
  "title": "Сделать комплимент",
  "description": "Сказать собеседнику комплимент. Уместно в разговоре.",
  "parametersSchema": {
    "type": "object",
    "properties": {"to": {"type": "string", "description": "Имя персонажа"},
                   "what": {"type": "string", "description": "За что похвалить"}},
    "required": ["to"]
  },
  "audience": "target",
  "targetParam": "to",
  "observationTemplate": "{name} говорит {to} комплимент: {what}",
  "effects": [{"target": "relation", "key": "relation", "op": "add", "value": 1},
              {"target": "tool_target", "key": "mood", "op": "add", "value": 1}],
  "cost": 0
}'

# Инструмент с согласием получателя: вызов создаёт предложение,
# действие исполняется только после respond_to_offer decision=accept.
# declineEffects — эффекты отказа (на отказавшегося и его чувства).
curl -s http://localhost:3999/api/tools -H "Content-Type: application/json" -d '{
  "name": "kiss",
  "title": "Поцеловать",
  "description": "Мягко поцеловать собеседника.",
  "parametersSchema": {
    "type": "object",
    "properties": {"to": {"type": "string", "x-entity": "character"}},
    "required": ["to"]
  },
  "audience": "target",
  "targetParam": "to",
  "observationTemplate": "{name} целует {to}",
  "effects": [{"target": "relation", "key": "relation", "op": "add", "value": 1}],
  "requiresConsent": true,
  "declineEffects": [{"target": "tool_target", "key": "mood", "op": "add", "value": -1}]
}'
```

`effects.target`: `self` | `tool_target` (получателю в ключ `key`) | `relation`
(отношение получателя к актёру; ключ в эффект не используется, но обязан быть
непустым — по конвенции UI пишут `"key": "relation"`) | `chemistry` (аналогично,
`"key": "chemistry"`). Имя тула (`name`) — только `a-z0-9_`; человекочитаемое —
в `title`/`description` на любом языке.
Исходы (`outcomes`) — массив `{id, title, conditions, effects, noticeTarget,
hideFromPrompt}`, условие: `{kind: "actor_attr"|"target_attr"|"relation"|"place"|"worn"|"chemistry", key, op: ">="|"<"|"=", value}`
(в условиях `key` может быть пустым — для `relation`/`place`/`worn`).

**Согласие (offers)**: тул с `requiresConsent: true` при вызове не исполняется —
создаётся предложение (живёт 6 ходов), а цель в свой ход вызывает виртуальный
тул вручную или моделью:

```bash
# Ответить за персонажа на предложение #3 (id предложений — в промпте цели
# и в событиях сцены): accept = исполнить тул от имени автора,
# decline = применить declineEffects
curl -s http://localhost:3999/api/scenes/1/act -H "Content-Type: application/json" \
  -d '{"characterId":2,"toolName":"respond_to_offer","args":{"offer":"3","decision":"accept","words":"Ну… давай"}}'
```

**`x-entity`**: свойство схемы с `"x-entity": "character" | "place" |
"product" | "slot" | "attribute"` получает на каждый ход `enum` реальных
значений реестра (у `targetParam` — имена участников, он в аннотации не
нуждается). Аннотация вырезается из схемы до отправки модели; выдуманное
значение отклоняется ошибкой со списком («Выбери из: …»).

## Реестры: характеристики, навыки, места, одежда, товары

```bash
# Характеристика (visibility: public | hidden; hidden → liePenalty, coveredBy)
curl -s http://localhost:3999/api/attributes -H "Content-Type: application/json" \
  -d '{"key":"mood","label":"Настроение","emoji":"😊","type":"number","min":0,"max":10,"visibility":"public"}'

# Навык (grows: true → авто-скрытый атрибут skill_<key>, практика каждые practicePerLevel)
curl -s http://localhost:3999/api/skills -H "Content-Type: application/json" \
  -d '{"key":"sex","label":"Секс","maxLevel":5,"practicePerLevel":10,"grows":true}'

# Место сцены (реестр мест; из него выбирается config.place и строятся go_to/invite)
curl -s http://localhost:3999/api/places -H "Content-Type: application/json" \
  -d '{"name":"кафе","description":"Уютная кофейня в центре"}'

# Переименовать место: каскад обновит config.place сцен, undressPlaces слотов,
# requirePlace границ и place-условия исходов; коллизия имён → 409
# (нестандартные символы в пути — процентная кодировка: кафе = %D0%BA%D0%B0%D1%84%D0%B5)
curl -s -X PATCH http://localhost:3999/api/places/%D0%BA%D0%B0%D1%84%D0%B5 -H "Content-Type: application/json" \
  -d '{"name":"кофейня у метро"}'

# Слот одежды (layer 1 = верхнее, 2 = бельё; undressPlaces — где можно обнажить,
# bareEffects — эффекты ПУСТОГО слота, пока он не надет)
curl -s http://localhost:3999/api/clothing-slots -H "Content-Type: application/json" \
  -d '{"slot":"underwear","layer":2,"undressPlaces":["дом"],"bareEffects":[{"target":"self","key":"anxiety","op":"add","value":1}]}'

# Одежда (гардероб): слот из реестра слотов (или пусто — просто хранится),
# эффекты действуют «пока надето»; price > 0 → продаётся в магазине
curl -s http://localhost:3999/api/garments -H "Content-Type: application/json" -d '{
  "name":"Джинсы","emoji":"👖","description":"Обычные синие джинсы",
  "slot":"bottom","price":40,
  "effects":[{"target":"self","key":"looks","op":"add","value":1}]}'

# Товар магазина (slot → сразу надевается; delayScenes → эффект через N сцен)
curl -s http://localhost:3999/api/products -H "Content-Type: application/json" -d '{
  "name":"Букет роз","emoji":"🌹","price":15,
  "description":"Классика жанра",
  "effects":[{"target":"relation","key":"relation","op":"add","value":2}],
  "slot": ""}'

# Химия пары (-3..+3)
curl -s http://localhost:3999/api/chemistry -H "Content-Type: application/json" \
  -d '{"aId":1,"bId":2,"value":2}'
```

## Персонаж

```bash
curl -s http://localhost:3999/api/characters -H "Content-Type: application/json" -d '{
  "name": "Яна",
  "emoji": "👩",
  "persona": "Яна, 24, бариста. Говорит быстро, сыплет сленгом кофейни...",
  "providerId": 1,
  "model": "qwen/qwen-3-235b-a22b-instruct",
  "temperature": 0.8,
  "maxTokens": 2048,
  "toolIds": [1, 2],
  "state": {"money": 350, "mood": 6, "growth": 172},
  "isHuman": false,
  "income": 1200,
  "boundaries": [{
    "toolName": "kiss",
    "scope": "incoming",
    "conditions": [
      {"kind": "relation", "op": ">=", "value": 3},
      {"kind": "attr", "owner": "target", "key": "mood", "op": ">=", "value": 2},
      {"kind": "place", "place": "дом"},
      {"kind": "attr", "owner": "actor", "key": "hygiene", "op": ">=", "value": 5}
    ],
    "refusalText": "Яна отстраняется: «Мы не на той стадии».",
    "effects": [{"target": "relation", "key": "", "op": "add", "value": -1}]
  }]
}
```

Условия («И»): `relation` (отношение владельца к партнёру), `attr` с
`owner: "actor"|"target"` (истинный state того, кто действует / на кого
действуют), `place`, `worn {slot, bare}`. `scope`: `incoming` (по умолчанию —
когда действуют на владельца), `outgoing` (когда владелец сам действует на
других — «не сплю с теми, у кого…»), `both`. Легаси-поля `minRelation`/
`minAttr`/`minMood`/`requirePlace`/`requireAttr` ещё принимаются и
переписываются в `conditions`.

`PATCH /api/characters/:id` со `state` **мёржит по ключам** (полная замена
стерла бы свежие изменения движка); `null` в значении удаляет ключ. Правки
запоминаются оверлеем `scene_characters.editor_overlay`: полный сброс сцены
«Заново» (`POST /api/scenes/:id/reset {"full":true}`) восстанавливает снимок
state на момент рассадки, а затем накатывает оверлей — явно заданные в
редакторе значения (деньги, статичные черты) откат «Заново» не сжигает,
откатывается только прогресс сцены (траты, эффекты). `state` —
свободный JSON, но ключи атрибутов должны быть в реестре
(значения клампятся по min/max). `money` — атрибут «Деньги» из дефолтного
сида (min 0): его списание делает `cost` тулов, начисление — доход во флоу.
Для человека: `isHuman: true` (providerId и model не нужны). Списки:
`GET /api/characters`. Ключи объектов `goals`/`schemas` — строки с id персонажа
(в JSON ключи объектов всегда строки).

## Сцена: создание и управление

```bash
# Создать (characterIds = порядок ходов; goals и schemas — по characterId)
curl -s http://localhost:3999/api/scenes -H "Content-Type: application/json" -d '{
  "name": "Вечер у Яны",
  "setting": "Квартира Яны, поздний вечер",
  "characterIds": [1, 2],
  "config": {
    "place": "дом",
    "maxTurns": 20,
    "turnDelayMs": 1500,
    "pauseForHumans": false,
    "allowToolRequests": true,
    "allowAgentStops": true,
    "rulesExtra": "Никто не уходит до полуночи.",
    "finish": {
      "conditions": [
        {"type": "toolCall", "toolName": "kiss", "characterId": 1},
        {"type": "state", "key": "mood", "op": ">=", "value": 5}
      ],
      "delayTurns": 2
    }
  },
  "goals": {"1": "Выяснить, где Саша был вчера, не выдав интереса.",
            "2": "Скрыть опоздание в бар и перевести тему на Яну."},
  "schemas": {"1": null}
}'

# Управление: action = start | pause | resume | step | stop
curl -s http://localhost:3999/api/scenes/1/control -H "Content-Type: application/json" -d '{"action":"start"}'

# Режиссёрское событие: всем или лично (audience = "all" | [characterId,…])
curl -s http://localhost:3999/api/scenes/1/inject -H "Content-Type: application/json" \
  -d '{"text":"В дверь звонят.","audience":"all"}'

# Реплика за персонажа (человека или кукловодство ИИ)
curl -s http://localhost:3999/api/scenes/1/say -H "Content-Type: application/json" \
  -d '{"characterId":2,"text":"Привет! Я принёс пирожные."}'

# Ручной вызов инструмента персонажем (тот же executeTool: границы/деньги работают)
curl -s http://localhost:3999/api/scenes/1/act -H "Content-Type: application/json" \
  -d '{"characterId":2,"toolName":"compliment","args":{"to":"Яна","what":"Причёска"}}'

# ВАЖНО: при включённой pauseForHumans сцена после хода человека (say или act)
# продолжает сама — движок делает авторезюм. Ручной control resume после
# каждого хода НЕ нужен (а лишний resume перезапускает цикл ходов).

# Лента событий (вся история), логи вызовов модели, скоринг, сброс сцены
curl -s http://localhost:3999/api/scenes/1/events
curl -s http://localhost:3999/api/scenes/1/apilogs
curl -s http://localhost:3999/api/scenes/1/scores
curl -s -X POST http://localhost:3999/api/scenes/1/reset

# Активные предложения сцены (тулы с requiresConsent, ждущие ответа адресата)
curl -s http://localhost:3999/api/scenes/1/offers
# Ответить за адресата можно тем же act: respond_to_offer (offer = id из списка)
curl -s http://localhost:3999/api/scenes/1/act -H "Content-Type: application/json" \
  -d '{"characterId":2,"toolName":"respond_to_offer","args":{"offer":"3","decision":"accept"}}'
```

`reset` стирает события/курсор/траты, а также предложения, блокировки и
флаги `left_scene`, но сохраняет участников, цели и привязки схем — удобно
для повторных прогонов. Live-лента: SSE `GET /api/stream`
(`curl -N`), фильтрация по видимости на клиенте.

`config.finish` (если задан): когда все условия выполнены (считаются только
исполненные вызовы, предложения не считаются), сцена доигрывает `delayTurns`
ходов и завершается сама. Типы условий: `toolCall` (успешный вызов тула,
опц. `characterId`), `outcome` (`toolName` + `outcomeId`), `state`
(`key`, `op: ">="|"<"|"="`, `value`, опц. `characterId`); максимум 10, «И».

## Гардероб персонажа и комбо

```bash
# Вид гардероба: что лежит (owned) и что надето по слотам
curl -s http://localhost:3999/api/characters/2/wardrobe

# Надеть (выдаёт предмет во владение и применяет эффекты ношения) / снять
curl -s -X POST http://localhost:3999/api/characters/2/wardrobe -H "Content-Type: application/json" \
  -d '{"garmentId":1,"action":"wear"}'        # или "remove" (worn → carried)

# Комбо: скрытая цепочка вызовов; steps — существующие тула (порядок важен),
# actorName/targetName — фильтры «кто делает»/«на кого» (необязательно),
# knowers — id персонажей, видящих подсказку с порядком шагов (пусто = секретное
# достижение, рецепт не знает никто), announce — объявить срабатывание всем
curl -s http://localhost:3999/api/combos -H "Content-Type: application/json" -d '{
  "name": "wave",
  "title": "Волна",
  "description": "Поцелуй, массаж и смена позы — и её накрывает волной.",
  "steps": [{"toolName": "kiss", "targetName": "Яна"}, {"toolName": "massage", "targetName": "Яна"}, {"toolName": "pose_change", "targetName": "Яна"}],
  "windowTurns": 8,
  "effects": [{"target": "tool_target", "key": "arousal", "op": "add", "value": 3}],
  "knowers": [2],
  "announce": true
}'

curl -s http://localhost:3999/api/combos          # список
curl -s -X PATCH http://localhost:3999/api/combos/1 -H "Content-Type: application/json" -d '{…}'
curl -s -X DELETE http://localhost:3999/api/combos/1
```

Комбо срабатывает, когда шаги исполнены **точно по порядку** в пределах
`windowTurns` ходов (предложения и `ok:false` не считаются; реплики и чужие
посторонние вызовы цепочку не рвут; исполнение по согласию — полноправный
шаг); раз за сцену. С `targetName` шаг засчитывается только направленным на
этого участника. `announce:true` объявляет срабатывание всем участникам
событием мира («достижение открыто»). `steps`/`knowers` проверяются на
существование (400 при битых ссылках), `name` уникален (409).

## Схемы валидации

```bash
curl -s http://localhost:3999/api/schemas -H "Content-Type: application/json" -d '{
  "name": "Ухаживание по шагам",
  "steps": [
    {"toolName": "compliment", "required": true,  "points": 10, "minCount": 1, "argContains": null},
    {"toolName": "kiss",       "required": true,  "points": 30, "minCount": 1, "argContains": "Яна"},
    {"toolName": "have_sex",   "required": false, "points": 40}
  ],
  "forbidden": ["insult"],
  "penalty": 5
}'
```

Шаг засчитывается после всех предыдущих обязательных; раннее вхождение —
нарушение. Привязка — при создании сцены (`schemas`) или PATCH `/api/scenes/:id`.

## Заявки на инструменты (request_tool)

```bash
curl -s http://localhost:3999/api/tool-requests            # очередь
curl -s -X POST http://localhost:3999/api/tool-requests/5/decision \
  -H "Content-Type: application/json" \
  -d '{"action":"approve","reason":"ок, но скромнее"}'      # или reject
```

## Сценарии (флоу)

```bash
curl -s http://localhost:3999/api/flows -H "Content-Type: application/json" -d '{
  "name": "Свидание",
  "graph": {
    "nodes": [
      {"id": "n1", "kind": "scene", "sceneId": 1, "bonus": 0, "resetOnEntry": true, "grantIncome": false, "x": 100, "y": 100},
      {"id": "ok", "kind": "final", "bonus": 50, "x": 400, "y": 100},
      {"id": "no", "kind": "exit",  "stopsRun": false, "x": 400, "y": 300}
    ],
    "edges": [
      {"id": "e1", "from": "n1", "to": "ok", "priority": 0, "label": "поцеловал",
       "conditions": [{"type": "step", "toolName": "kiss", "argContains": "Яна", "characterId": 1}]},
      {"id": "e2", "from": "n1", "to": "no", "priority": 9, "conditions": []}
    ]
  }
}'

# Прогон: состав участников → отчёт
curl -s http://localhost:3999/api/flows/1/runs -H "Content-Type: application/json" -d '{"characterIds":[1,2]}'
curl -s http://localhost:3999/api/flow-runs/1
curl -s -X POST http://localhost:3999/api/flow-runs/1/evaluate -H "Content-Type: application/json" -d '{"nodeId":"n1"}'
```

Типы условий рёбер: `step` (успешный вызов тула, опц. фильтр argContains),
`score` (`metric: "score"|"completionPct"`, порог), `clean` (без нарушений
схемы), `state` (числовая проверка state), `relation` (whoseId → toId, порог),
`outcome` (сработавший исход тула). `characterId: null` — условие личное для
каждого переходящего. Первое подходящее ребро — по меньшему `priority`.

## Сеть

```bash
curl -s http://localhost:3999/api/network-settings
curl -s -X PATCH http://localhost:3999/api/network-settings \
  -H "Content-Type: application/json" -d '{"insecureTls":true}'
```

`insecureTls` — корпоративный режим (отключение проверки SSL). Действует на
исходящие вызовы провайдеров сразу, без перезапуска.

## Прямой доступ к БД — нельзя

Не INSERT/UPDATE таблицы напрямую живой БД `data/app.db`: движок кеширует
состояние сцен в памяти, а в БД лежат незашифрованные ключи. Данные — только
через API. Для собственных скриптов/экспериментов: `SIM_DB_PATH=data/test.db`
перед запуском (схема и сиды создадутся сами).
