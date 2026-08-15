# Подключение пяти плагинов к OpenClaw 2026.7.1-2

Инструкция описывает стек, проверенный на
`ghcr.io/openclaw/openclaw:2026.7.1-2`.

| Plugin ID | Источник | Путь в тестовом контейнере | Роль |
|---|---|---|---|
| `a2a-gateway` | [openclaw-a2a-gateway](https://github.com/YankovskiyVS/openclaw-a2a-gateway), v1.4.0 | `/plugins/a2a` | A2A HTTP/JSON-RPC, routing и task store |
| `browser` | встроен в OpenClaw | не нужен | browser-control service |
| `diagnostics-otel` | встроен в OpenClaw | не нужен | OpenTelemetry |
| `llm-action-judge` | [llm-approve-openclaw-plugin](https://github.com/YankovskiyVS/llm-approve-openclaw-plugin), v0.5.1 | `/plugins/judge` | проверка tool calls и audit |
| `nango-proxy` | [nango-openclaw-plugin](https://github.com/YankovskiyVS/nango-openclaw-plugin), v0.5.0 | `/plugins/nango` | 57 tools интеграций |

Все три репозитория используют ветку `openclaw-2026.7.1-2`.

## Схема запроса

```text
A2A client
  → :18800 a2a-gateway
  → OpenClaw Gateway RPC → agent main
  → Cloud.ru Qwen/Qwen3.6-35B-A3B
  → proposed tool call
  → llm-action-judge before_tool_call
  ├─ browser → browser-control
  └─ nango_* → nango-proxy plugin → Nango proxy → provider API
  → результат → ответ агента → A2A task/history

diagnostics-otel наблюдает работу OpenClaw и экспортирует telemetry.
```

Judge регистрирует также `before_model_resolve`, чтобы связать tool call с
исходным trusted user request.

## 1. Размещение репозиториев

```text
/opt/openclaw-stack/
├── openclaw-a2a-gateway/
├── llm-approve-openclaw-plugin/
└── nango-openclaw-plugin/
```

```bash
mkdir -p /opt/openclaw-stack
cd /opt/openclaw-stack
git clone https://github.com/YankovskiyVS/openclaw-a2a-gateway
git clone https://github.com/YankovskiyVS/llm-approve-openclaw-plugin
git clone https://github.com/YankovskiyVS/nango-openclaw-plugin

git -C openclaw-a2a-gateway checkout openclaw-2026.7.1-2
git -C llm-approve-openclaw-plugin checkout openclaw-2026.7.1-2
git -C nango-openclaw-plugin checkout openclaw-2026.7.1-2

npm --prefix openclaw-a2a-gateway ci
npm --prefix llm-approve-openclaw-plugin ci
npm --prefix nango-openclaw-plugin ci
```

Пути в `plugins.load.paths` должны быть абсолютными и видимыми из процесса
OpenClaw. Для Docker это пути внутри контейнера.

## 2. Переменные окружения

| Переменная | Назначение |
|---|---|
| `CLOUDRU_API_KEY` | Cloud.ru model API; по умолчанию также Api-Key для Nango proxy |
| `OPENCLAW_JUDGE_API_KEY` | ключ модели Judge |
| `OPENCLAW_JUDGE_PROFILE` | `shadow`, `supervised` или `autonomous` |
| `NANGO_PROXY_URL` | базовый URL Nango proxy |
| `EVOLUTION_PROJECT_ID` | project ID для Nango |
| `EVOCLAW_ID` | EvoClaw ID для Nango |
| `A2A_TOKEN` | bearer token входящего A2A API |

Пример без реальных секретов:

```dotenv
CLOUDRU_API_KEY=<secret>
OPENCLAW_JUDGE_API_KEY=<secret>
OPENCLAW_JUDGE_PROFILE=shadow
NANGO_PROXY_URL=https://nango-proxy.example.internal
EVOLUTION_PROJECT_ID=<project-id>
EVOCLAW_ID=<evoclaw-id>
A2A_TOKEN=<random-bearer-token>
```

Передавайте значения gateway-процессу или контейнеру. Не коммитьте env-файл;
установите для него режим `0600`.

## 3. Объединённый openclaw.json

Ниже проверенная структура. Замените публичный Agent Card URL, gateway token,
пути и адрес Nango:

```json
{
  "gateway": {
    "mode": "local",
    "port": 19080,
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "<openclaw-gateway-token>"
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "cloudru/Qwen/Qwen3.6-35B-A3B"
      },
      "models": {
        "cloudru/Qwen/Qwen3.6-35B-A3B": {
          "alias": "Cloud.ru Qwen3.6 35B A3B"
        }
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cloudru": {
        "baseUrl": "https://foundation-models.api.cloud.ru/v1",
        "apiKey": "${CLOUDRU_API_KEY}",
        "api": "openai-completions",
        "models": [{
          "id": "Qwen/Qwen3.6-35B-A3B",
          "name": "Qwen3.6 35B A3B (Cloud.ru)",
          "reasoning": false,
          "input": ["text"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "contextWindow": 131072,
          "maxTokens": 2500,
          "compat": {
            "requiresStringContent": true
          }
        }]
      }
    }
  },
  "plugins": {
    "allow": [
      "a2a-gateway",
      "browser",
      "diagnostics-otel",
      "llm-action-judge",
      "nango-proxy"
    ],
    "load": {
      "paths": [
        "/opt/openclaw-stack/openclaw-a2a-gateway",
        "/opt/openclaw-stack/llm-approve-openclaw-plugin",
        "/opt/openclaw-stack/nango-openclaw-plugin"
      ]
    },
    "entries": {
      "a2a-gateway": {
        "enabled": true,
        "config": {
          "agentCard": {
            "name": "Production OpenClaw",
            "url": "https://agent.example.com/a2a/jsonrpc",
            "skills": [{
              "id": "chat",
              "name": "chat",
              "description": "A2A bridge to the main agent"
            }]
          },
          "server": {
            "host": "0.0.0.0",
            "port": 18800,
            "grpcEnabled": false
          },
          "storage": {
            "tasksDir": "/var/lib/openclaw/a2a-tasks",
            "taskTtlHours": 72,
            "cleanupIntervalMinutes": 60
          },
          "routing": {
            "defaultAgentId": "main",
            "rules": []
          },
          "security": {
            "inboundAuth": "bearer",
            "token": "${A2A_TOKEN}"
          },
          "toolApproval": {
            "enabled": true,
            "timeoutMs": 120000
          }
        }
      },
      "browser": {
        "enabled": true
      },
      "diagnostics-otel": {
        "enabled": true
      },
      "llm-action-judge": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "mode": "supervised",
          "enforcement": "enforce"
        }
      },
      "nango-proxy": {
        "enabled": true,
        "config": {
          "proxyBaseUrl": "https://nango-proxy.example.internal",
          "apiKeyEnv": "CLOUDRU_API_KEY"
        }
      }
    }
  },
  "browser": {
    "enabled": true,
    "headless": true
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "traces": false,
      "metrics": false,
      "logs": true,
      "logsExporter": "stdout",
      "serviceName": "openclaw-five-plugin-stack",
      "captureContent": {
        "enabled": false
      }
    }
  }
}
```

### Почему A2A tool approval включён

В рабочем стеке `a2a-gateway.config.toolApproval.enabled=true`,
`OPENCLAW_JUDGE_PROFILE=supervised` и
`OPENCLAW_JUDGE_A2A_HITL_REPLACE=false`. Judge разрешает proven-passive calls,
блокирует policy deny и передаёт review/technical failure в один native A2A
pending approval. Mutation без доступной approval surface завершается
`approval_unavailable`, а не silent allow/deny.

Approval связан с `userTurnId + toolName + normalized params + session/context`
через `actionHash`; изменение адресата/контента требует нового решения, а retry
точного actionHash не запускает side effect повторно.

## 4. Docker paths и порты

```bash
--volume /opt/openclaw-stack/openclaw-a2a-gateway:/plugins/a2a:ro
--volume /opt/openclaw-stack/llm-approve-openclaw-plugin:/plugins/judge:ro
--volume /opt/openclaw-stack/nango-openclaw-plugin:/plugins/nango:ro
--publish 18800:18800
--publish 19080:19080
```

При таких mounts укажите в контейнерном `plugins.load.paths`:
`/plugins/a2a`, `/plugins/judge`, `/plugins/nango`.

## 5. Проверка конфигурации и runtime

```bash
openclaw config validate
openclaw plugins doctor
openclaw plugins inspect a2a-gateway --runtime --json
openclaw plugins inspect browser --runtime --json
openclaw plugins inspect diagnostics-otel --runtime --json
openclaw plugins inspect llm-action-judge --runtime --json
openclaw plugins inspect nango-proxy --runtime --json
```

Ожидаемые контракты:

- A2A service `a2a-gateway`;
- Browser service `browser-control`;
- Judge hooks `before_model_resolve` и `before_tool_call`;
- 57 Nango tools, включая `nango_list_connections`;
- Diagnostics service `diagnostics-otel`.

После `openclaw gateway run` в журнале должна появиться строка:

```text
[gateway] http server listening (5 plugins: a2a-gateway, browser, diagnostics-otel, llm-action-judge, nango-proxy; ...)
```

Проверьте Agent Card, metrics и реальную A2A-задачу:

```bash
curl --fail http://127.0.0.1:18800/.well-known/agent-card.json
curl --fail http://127.0.0.1:18800/a2a/metrics

A2A_TOKEN=<token> node skill/scripts/a2a-send.mjs \
  --peer-url http://127.0.0.1:18800 \
  --non-blocking --wait \
  --message "Call nango_list_connections once and report connection statuses."
```

После запроса проверьте:

- один `GET /api/v1/<project>/evo-claws/<id>/connections` в Nango proxy;
- запись `tool_name=nango_list_connections` в
  `logs/llm-action-judge.jsonl`;
- `service.name=openclaw-five-plugin-stack` в OTel output.

## 6. Автоматический smoke-тест

```bash
cd /opt/openclaw-stack/openclaw-a2a-gateway
CLOUDRU_API_KEY=<secret> npm run test:live:stack
```

Smoke-тест поднимает отдельный OpenClaw-контейнер и локальный mock Nango,
отправляет реальную задачу в Cloud.ru Qwen, проверяет Judge, Nango, Diagnostics
и точный список плагинов, затем удаляет временные config/env, state и контейнер.

Mock проверяет контракт Nango plugin. Реальные OAuth connections проверяются
отдельно через production `nango_list_connections`.

## 7. Kubernetes: профиль ресурсов 1:3

Готовый манифест:
[deploy/kubernetes/openclaw-five-plugin.yaml](../deploy/kubernetes/openclaw-five-plugin.yaml).

Для основного контейнера заданы одинаковые отношения `requests:limits = 1:3`:

| Ресурс | Request | Limit |
|---|---:|---:|
| CPU | `167m` | `501m` |
| RAM | `512Mi` | `1536Mi` |
| Ephemeral storage | `1Gi` | `3Gi` |

Init-контейнер использует `250m/750m`, `512Mi/1536Mi` и `1Gi/3Gi`.
Он последовательно скачивает три fork-репозитория по закреплённым commit SHA и
устанавливает только runtime dependencies. Образы Node и OpenClaw также
закреплены по digest. Для состояния A2A, cron и writable-копии config создаётся
PVC `5Gi`; Chromium получает отдельный `/dev/shm` размером `256Mi`.

Перед применением сделайте приватную рабочую копию YAML и замените:

- четыре placeholder в Secret;
- `EVOLUTION_PROJECT_ID` и `EVOCLAW_ID`;
- `NANGO_PROXY_URL`, если Nango работает не по указанному cluster DNS;
- `agentCard.url` на публичный URL, если A2A вызывают вне кластера.

Не сохраняйте рабочую копию с ключами в Git. Затем выполните:

```bash
kubectl apply -f /secure/path/openclaw-five-plugin.yaml
kubectl -n openclaw rollout status deployment/openclaw-five-plugin --timeout=5m
kubectl -n openclaw logs -f deployment/openclaw-five-plugin
```

Для локальной проверки без Ingress:

```bash
kubectl -n openclaw port-forward service/openclaw-five-plugin 18800:18800 19080:19080
curl --fail http://127.0.0.1:18800/.well-known/agent-card.json
```

Кластеру нужны default StorageClass и исходящий HTTPS-доступ к GitHub, GHCR,
Cloud.ru и Nango. Deployment использует `Recreate` и одну реплику, потому что
task store находится на `ReadWriteOnce` PVC.

Профиль проверен на browser-образе OpenClaw: все пять плагинов вышли в
`ready` за 3.6 секунды, Agent Card вернул HTTP 200, idle RAM составила
около `396Mi`, а короткий Playwright/Chromium test завершился успешно.
Ранее реальный A2A → Cloud.ru Qwen → Judge → Nango проходил на `0.25 CPU /
1GiB` с пиком около `790MiB`; limit `1536Mi` оставляет рабочий запас.

## Типовые ошибки

| Симптом | Что проверить |
|---|---|
| plugin not allowed | Все пять ID находятся в `plugins.allow` |
| plugin not found | Абсолютные paths видны процессу или контейнеру |
| Judge не видит запрос | `hooks.allowConversationAccess=true` |
| Judge: missing API key | Env передан именно gateway-процессу |
| Nango: 401 | `apiKeyEnv` и заголовок `Api-Key` |
| Nango: 404 | Project/EvoClaw IDs и наличие connection |
| Неверный Agent Card URL | URL должен быть доступен A2A-пирам |
| Запрос завис на approval | Не включены ли одновременно Judge и A2A HITL |
| Нет telemetry | Plugin entry и `diagnostics.otel.enabled` |
| Browser не запускается | Browser service, headless mode и образ |

После изменения config повторяйте `config validate`, `plugins doctor` и
реальный A2A end-to-end запрос.
