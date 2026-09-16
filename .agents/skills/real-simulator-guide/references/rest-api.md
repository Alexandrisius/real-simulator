# REST API real-simulator

База: `http://localhost:3999` (или порт dev-сервера). Все запросы и ответы —
JSON. Ошибки: `{"error": "текст"}`, 400 при нарушении zod-схемы. Точные схемы
полей — `src/lib/api.ts`; ниже — рабочие примеры, покрывающие 90% задач.
Поля в payload — camelCase (`providerId`, `maxTokens`, `characterIds`).

## Провайдеры

```bash
# Создать (kind: lmstudio | openrouter | openai-compatible | mock)
curl -s http://localhost:3999/api/providers -H "Content-Type: application/json" \
  -d '{"name":"LM Studio","kind":"lmstudio","baseUrl":"http://localhost:1234/v1"}'

# Список моделей / проверка соединения
curl -s "http://localhost:3999/api/providers/1/models?test=1"
```

## Инструменты

```bash
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
```

`effects.target`: `self` | `tool_target` (получателю в ключ `key`) | `relation`
(отношение получателя к актёру; ключ в эффект не используется, но обязан быть
непустым — по конвенции UI пишут `"key": "relation"`) | `chemistry` (аналогично,
`"key": "chemistry"`). Имя тула (`name`) — только `a-z0-9_`; человекочитаемое —
в `title`/`description` на любом языке.
Исходы (`outcomes`) — массив `{id, title, conditions, effects, noticeTarget,
hideFromPrompt}`, условие: `{kind: "actor_attr"|"target_attr"|"relation"|"place"|"worn"|"chemistry", key, op: ">="|"<"|"=", value}`
(в условиях `key` может быть пустым — для `relation`/`place`/`worn`).

## Реестры: характеристики, навыки, места, одежда, товары

```bash
# Характеристика (visibility: public | hidden; hidden → liePenalty, coveredBy)
curl -s http://localhost:3999/api/attributes -H "Content-Type: application/json" \
  -d '{"key":"mood","label":"Настроение","emoji":"😊","type":"number","min":0,"max":10,"visibility":"public"}'

# Навык (grows: true → авто-скрытый атрибут skill_<key>, практика каждые practicePerLevel)
curl -s http://localhost:3999/api/skills -H "Content-Type: application/json" \
  -d '{"key":"sex","label":"Секс","maxLevel":5,"practicePerLevel":10,"grows":true}'

# Место сцены
curl -s http://localhost:3999/api/places -H "Content-Type: application/json" \
  -d '{"name":"кафе","description":"Уютная кофейня в центре"}'

# Слот одежды (layer 1 = верхнее, 2 = бельё; undressPlaces — где можно обнажить)
curl -s http://localhost:3999/api/clothing-slots -H "Content-Type: application/json" \
  -d '{"slot":"top","layer":1,"undressPlaces":[]}'

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
    "minRelation": 3,
    "minMood": 2,
    "requirePlace": "дом",
    "requireAttr": {"owner": "actor", "key": "hygiene", "op": ">=", "value": 5},
    "refusalText": "Яна отстраняется: «Мы не на той стадии».",
    "effects": [{"target": "relation", "key": "", "op": "add", "value": -1}]
  }]
}'
```

`state` — свободный JSON, но ключи атрибутов должны быть в реестре
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
    "rulesExtra": "Никто не уходит до полуночи."
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
```

`reset` стирает события/курсор/траты, но сохраняет участников, цели и привязки
схем — удобно для повторных прогонов. Live-лента: SSE `GET /api/stream`
(`curl -N`), фильтрация по видимости на клиенте.

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
