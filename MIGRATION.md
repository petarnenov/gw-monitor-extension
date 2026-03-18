# Миграция към абстрактна архитектура

## Съдържание

1. [Текущо състояние](#1-текущо-състояние)
2. [Целева архитектура](#2-целева-архитектура)
3. [Фаза 1 — Конфигурационен слой](#3-фаза-1--конфигурационен-слой)
4. [Фаза 2 — Модуларизация на сървъра](#4-фаза-2--модуларизация-на-сървъра)
5. [Фаза 3 — Adapter система](#5-фаза-3--adapter-система)
6. [Фаза 4 — Абстракция на клиента](#6-фаза-4--абстракция-на-клиента)
7. [Фаза 5 — Multi-profile поддръжка](#7-фаза-5--multi-profile-поддръжка)
8. [Детайлни инструкции по файл](#8-детайлни-инструкции-по-файл)
9. [Нова файлова структура](#9-нова-файлова-структура)
10. [API промени](#10-api-промени)
11. [Тестова стратегия](#11-тестова-стратегия)
12. [Рискове и митигации](#12-рискове-и-митигации)
13. [Приоритизация](#13-приоритизация)

---

## 1. Текущо състояние

### Файлова структура

```
gw-monitor-extension/
├── server.js                  # 1397 реда — монолитен Express backend
├── package.json               # express + js-yaml
├── chrome-extension/
│   ├── manifest.json          # MV3, permissions: alarms, storage, notifications
│   ├── popup.html             # 183 реда — единичен HTML файл
│   ├── popup.js               # 1170 реда — монолитен клиент
│   ├── popup.css              # 701 реда — стилове с light/dark theme
│   ├── background.js          # 191 реда — service worker
│   └── icons/                 # 9 PNG файла (3 цвята x 3 размера)
```

### Hardcoded стойности в server.js

| Константа | Стойност | Категория |
|-----------|----------|-----------|
| `BE_HOME` | `/home/petar/AppServer/BEServer` | Пътища |
| `TOMCAT_HOME` | `/home/petar/AppServer/apache-tomcat-9.0.38` | Пътища |
| `GEO_DIR` | `/home/petar/AppServer/geowealth` | Пътища |
| `JAVA_HOME` | `/home/petar/AppServer/amazon-corretto-17.0.18.9.1-linux-x64` | Пътища |
| `CONFIG_YML` | `/home/petar/AppServer/petarServer.yml` | Пътища |
| `TOMCAT_PORT` | `8080` | Портове |
| `PORT` | `7103` | Портове |
| `GEO_ENV` | `DevPetar` | Среда |
| `GEO_SERVER` | `DevPetar` | Среда |
| `GRADLE_CACHE` | `/home/petar/.gradle/caches/modules-2/files-2.1` | Пътища |
| `GIT_ASKPASS_SCRIPT` | `/tmp/gw-git-askpass.sh` | Пътища |
| `TOMCAT_BIN` | `TOMCAT_HOME + '/bin'` | Деривирани |
| `SBIN` | `BE_HOME + '/sbin'` | Деривирани |

### Hardcoded стойности в popup.js

| Константа | Стойност | Категория |
|-----------|----------|-----------|
| `DEFAULT_URL` | `http://localhost:7103` | Конфигурация |
| `PENDING_TTL_MS` | `5 * 60 * 1000` | Таймаути |
| Fetch timeouts | 10s/15s/30s/120s/300s | Таймаути |
| Max dropdown items | `30` | UI |

### Hardcoded стойности в background.js

| Константа | Стойност | Категория |
|-----------|----------|-----------|
| `DEFAULT_URL` | `http://localhost:7103` | Конфигурация |
| Alarm period | `1` минута | Таймаути |
| RAM threshold | `95%` | Прагове |

### Дублиран код между файловете

| Функция/логика | popup.js | background.js |
|----------------|----------|---------------|
| `getApiUrl()` | Идентична | Идентична |
| Pending agents reconciliation | `reconcilePendingAgents()` | Inline в `checkStatus()` |
| Status fetch + parse | `refresh()` | `checkStatus()` |
| Agent filtering (manual start/stop) | При рендериране | При health check |

---

## 2. Целева архитектура

### Принципи

1. **Configuration over hardcoding** — всяка среда се описва с конфигурационен файл
2. **Separation of concerns** — всеки модул има една отговорност
3. **Adapter pattern** — app server, build tool и process manager са сменяеми
4. **Shared utilities** — общият код между popup.js и background.js се извлича
5. **Dynamic UI** — интерфейсът се адаптира спрямо capabilities на сървъра

### Диаграма на зависимости (целева)

```
┌─────────────────────────────────────────────────────┐
│                  Chrome Extension                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │background │  │ popup/   │  │   shared/         │  │
│  │  .js      │←→│  main.js │←→│  api-client.js    │  │
│  │          │  │          │  │  storage.js        │  │
│  │          │  │ renderers│  │  pending-agents.js │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP (REST + SSE)
┌─────────────────────▼───────────────────────────────┐
│                  Express Server                      │
│                                                      │
│  ┌─────────┐  ┌───────────────────────────────────┐  │
│  │ config  │→ │  modules/                          │  │
│  │  .yml   │  │  ├── system-monitor.js             │  │
│  │         │  │  ├── log-streamer.js               │  │
│  │         │  │  ├── git-ops.js                    │  │
│  │         │  │  ├── deploy-pipeline.js            │  │
│  │         │  │  ├── command-exec.js               │  │
│  └─────────┘  │  └── process-manager.js            │  │
│               └───────────┬───────────────────────┘  │
│                           │                          │
│               ┌───────────▼───────────────────────┐  │
│               │  adapters/                         │  │
│               │  ├── tomcat-adapter.js             │  │
│               │  ├── gradle-adapter.js             │  │
│               │  └── geowealth-agents-adapter.js   │  │
│               └───────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 3. Фаза 1 — Конфигурационен слой

**Цел**: Елиминиране на всички hardcoded стойности. Сървърът да стартира с `node server.js --config ./config.yml`.

### 3.1. Създаване на config.yml

```yaml
# config.yml — пример за GeoWealth среда
server:
  port: 7103
  name: "GeoWealth Dev Server"

paths:
  source: /home/petar/AppServer/geowealth
  deploy_target: /home/petar/AppServer/BEServer
  java_home: /home/petar/AppServer/amazon-corretto-17.0.18.9.1-linux-x64

app_server:
  type: tomcat
  home: /home/petar/AppServer/apache-tomcat-9.0.38
  port: 8080
  health_check:
    path: /platformOne/checkPlatformStatus.do
    expected_status: 302
    timeout_ms: 5000
  logs:
    main: logs/catalina.out
    access: logs/localhost_access_log.{date}.txt
  webapps_dir: webapps

build:
  type: gradle
  working_dir: /home/petar/AppServer/geowealth
  commands:
    incremental: "./gradlew devClasses devLib jar"
    full_clean: "./gradlew clean"
    full_build: "./gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false"
  output:
    release_dir: build/release
    dev_dir: devBuild
    jar_dir: build/libs

deploy:
  artifact_dirs:
    - lib
    - bin
    - sbin
    - etc
    - dev_etc
    - templates
    - exports
    - WebContent
  copy_to_app_server:
    - source: WebContent
      target: "{app_server.home}/webapps/ROOT"
  post_deploy:
    - extract: birt_platform.tar.gz
      to: "{paths.deploy_target}"
    - inject_billing_agents: true
  verify:
    checksum_jars: true
  startup_check:
    max_attempts: 30
    interval_ms: 2000

agents:
  config_file: /home/petar/AppServer/petarServer.yml
  config_format: geowealth_yaml
  env_key: DevPetar
  server_key: DevPetar
  log_dir: "{paths.deploy_target}/logs"
  log_file: stdout.log
  commands:
    list: "nfjobs"
    check: "nfcheckall"
    start: "nfstart {name}"
    stop: "nfstop {name}"
    restart_all: "{paths.deploy_target}/sbin/restart_agents.sh"
  env_vars:
    GEO_TEMPLATE_NAME: "{agents.config_file}"
    GEO_ENV: "{agents.env_key}"
    GEO_SERVER: "{agents.server_key}"

git:
  auth:
    type: gitlab          # gitlab | github | none
    token_env: GITLAB_TOKEN
    user_env: GITLAB_USER
    default_user: oauth2

thresholds:
  ram_warning: 75
  ram_danger: 90
  ram_critical: 95
  bar_warning: 75
  bar_danger: 90

exec_whitelist:
  - tail
  - head
  - cat
  - df
  - du
  - ls
  - git
  - "./gradlew"
  - ps
  - free
  - uptime
```

### 3.2. Промени в server.js

**Какво се премахва:**
- Всички константи `BE_HOME`, `TOMCAT_HOME`, `GEO_DIR`, `JAVA_HOME`, `CONFIG_YML`, `TOMCAT_PORT`, `GEO_ENV`, `GEO_SERVER`, `GRADLE_CACHE`

**Какво се добавя:**
- Config loader, който чете `config.yml` и валидира задължителните полета
- CLI аргумент `--config` (default: `./config.yml`)
- Всички функции получават стойности от `config` обекта вместо от глобални константи

**Пример за config loader:**

```javascript
// config.js
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(raw);

  // Resolve template variables like {paths.deploy_target}
  resolveTemplates(config, config);

  // Validate required fields
  const required = [
    'server.port',
    'paths.source',
    'paths.deploy_target',
    'app_server.type',
    'app_server.home',
    'app_server.port',
    'build.type'
  ];

  for (const key of required) {
    if (!getNestedValue(config, key)) {
      throw new Error(`Missing required config: ${key}`);
    }
  }

  return config;
}
```

### 3.3. Промени в popup.js и background.js

Минимални на тази фаза:
- Сървърът вече връща `GET /config/client` с информация, нужна на клиента (server name, capabilities)
- `DEFAULT_URL` остава, но е единственият hardcoded fallback

### 3.4. Критерий за завършване

- `server.js` стартира с `node server.js --config ./config.yml`
- Същият код работи на различна машина само с различен `config.yml`
- Нито един път или порт не е hardcoded в source кода
- Старият `config.yml` за GeoWealth среда е напълно еквивалентен на текущото поведение

---

## 4. Фаза 2 — Модуларизация на сървъра

**Цел**: Разделяне на `server.js` (1397 реда) на модули по домейн, без промяна на логиката.

### 4.1. Извличане на модули

#### system-monitor.js (~100 реда)

Извлича се от `server.js`:
- `getSystemInfo()` — RAM, swap, disk, uptime, load, CPU count
- Парсинг на `/proc` filesystem и `free`/`df` команди

**Функции:**
```
getSystemInfo(config) → { mem_total, mem_used, mem_free, mem_available,
                          swap_total, swap_used, disk_total, disk_used,
                          disk_avail, disk_percent, uptime, load_1m,
                          load_5m, load_15m, cpu_count }
```

**Зависимости:** `runCmd()` от `utils.js`

#### app-server-manager.js (~250 реда)

Извлича се от `server.js`:
- `getTomcatStatus()` → обобщава се като `getAppServerStatus(config)`
- `getTomcatProcess()` → `getAppServerProcess(config)`
- `getTomcatThreads(pid)` → `getProcessThreads(pid)`
- `getTomcatJvm(pid)` → `getJvmConfig(pid)`
- `getDeployedWebapps()` → `getDeployedApps(config)`
- `getRequestsToday()` → `getRequestsToday(config)`
- `checkPlatformReady()` → `checkHealthEndpoint(config)`

**Express routes:**
```
POST /stop/app-server     (бивш /stop/tomcat)
POST /restart/app-server  (бивш /restart/tomcat)
```

#### process-manager.js (~200 реда)

Извлича се от `server.js`:
- `getConfiguredAgents()` → `getConfiguredProcesses(config)`
- `getAgents()` → `getProcesses(config)`
- `enrichRunningAgent(agent)` → `enrichRunningProcess(process)`
- `updateAgentMemory(name, memory)` → `updateProcessMemory(config, name, memory)`
- `updateAgentAutostart(name, enabled)` → `updateProcessAutostart(config, name, enabled)`

**Express routes:**
```
POST /stop/process/:name      (бивш /stop/agent/:name)
POST /restart/process/:name   (бивш /restart/agent/:name)
POST /restart/processes       (бивш /restart/agents)
PUT  /config/process/:name/memory     (бивш /config/agent/:name/memory)
PUT  /config/process/:name/autostart  (бивш /config/agent/:name/autostart)
```

#### git-ops.js (~80 реда)

Извлича се от `server.js`:
- `getBranches(config)` — git fetch + list remotes
- `getGitStatus(config)` — current branch + porcelain
- `stashChanges(config)` — git stash push -u
- `pullBranch(config, branch)` — git pull origin
- Git auth setup (GIT_ASKPASS, SSH→HTTPS conversion)

**Express routes:**
```
GET  /git/branches
GET  /git/status
POST /git/stash
POST /pull
```

#### deploy-pipeline.js (~400 реда)

Извлича се от `server.js`:
- `runDeploy(config, branch)` — 8-стъпков deploy
- `runDeploySteps(...)` — core deploy logic
- `runQuickDeploy(config, agents, restartTomcat)` — quick deploy
- `waitForTomcatStop(config)` → `waitForAppServerStop(config)`
- `fixCorruptedJars(config)` — MD5 verification
- `logDeploy(msg)`, `lastLines(str, n)` — deploy log utilities
- `deployInProgress`, `deployLog` — deploy state

**Express routes:**
```
POST /deploy
POST /quick-deploy
GET  /deploy/status
GET  /deploy/stream
```

#### log-streamer.js (~60 реда)

Извлича се от `server.js`:
- `getTomcatLogs(lines)` → `getAppServerLogs(config, lines)`
- `getAgentLogs(name, lines)` → `getProcessLogs(config, name, lines)`

**Express routes:**
```
GET /logs/app-server      (бивш /logs/tomcat)
GET /logs/process/:name   (бивш /logs/agent/:name)
```

#### command-exec.js (~40 реда)

Извлича се от `server.js`:
- `execCommand(cmd, whitelist)` — whitelist validation + execution

**Express routes:**
```
POST /exec
```

#### utils.js (~30 реда)

Общи utility функции:
- `runCmd(cmd, timeout)` — sync command execution
- `runCmdStrict(cmd, timeout)` — throws on failure
- `runAsync(cmd, timeout)` — async command execution

### 4.2. Нов entry point — index.js

```javascript
// server/index.js
const express = require('express');
const { loadConfig } = require('./config');
const systemMonitor = require('./modules/system-monitor');
const appServer = require('./modules/app-server-manager');
const processManager = require('./modules/process-manager');
const gitOps = require('./modules/git-ops');
const deployPipeline = require('./modules/deploy-pipeline');
const logStreamer = require('./modules/log-streamer');
const commandExec = require('./modules/command-exec');

const configPath = process.argv.find(a => a.startsWith('--config='))
  ?.split('=')[1] || './config.yml';
const config = loadConfig(configPath);

const app = express();
app.use(express.json());

// Register route groups
systemMonitor.registerRoutes(app, config);
appServer.registerRoutes(app, config);
processManager.registerRoutes(app, config);
gitOps.registerRoutes(app, config);
deployPipeline.registerRoutes(app, config);
logStreamer.registerRoutes(app, config);
commandExec.registerRoutes(app, config);

// Aggregated status endpoint
app.get('/status', async (req, res) => { ... });
app.get('/ping', (req, res) => res.send('pong'));

// Client config endpoint (new)
app.get('/config/client', (req, res) => {
  res.json({
    name: config.server.name,
    app_server_type: config.app_server.type,
    build_type: config.build.type,
    has_agents: !!config.agents,
    has_deploy: !!config.deploy,
    thresholds: config.thresholds
  });
});

app.listen(config.server.port);
```

### 4.3. Маппинг на функции от server.js към модули

| Текуща функция в server.js | Целеви модул | Ново име |
|----------------------------|-------------|----------|
| `runCmd()` | utils.js | `runCmd()` |
| `runCmdStrict()` | utils.js | `runCmdStrict()` |
| `runAsync()` | utils.js | `runAsync()` |
| `getSystemInfo()` | system-monitor.js | `getSystemInfo(config)` |
| `checkPlatformReady()` | app-server-manager.js | `checkHealthEndpoint(config)` |
| `getTomcatStatus()` | app-server-manager.js | `getAppServerStatus(config)` |
| `getTomcatProcess()` | app-server-manager.js | `getAppServerProcess(config)` |
| `getTomcatThreads()` | app-server-manager.js | `getProcessThreads(pid)` |
| `getTomcatJvm()` | app-server-manager.js | `getJvmConfig(pid)` |
| `getDeployedWebapps()` | app-server-manager.js | `getDeployedApps(config)` |
| `getRequestsToday()` | app-server-manager.js | `getRequestsToday(config)` |
| `getConfiguredAgents()` | process-manager.js | `getConfiguredProcesses(config)` |
| `getAgents()` | process-manager.js | `getProcesses(config)` |
| `enrichRunningAgent()` | process-manager.js | `enrichRunningProcess(proc)` |
| `updateAgentMemory()` | process-manager.js | `updateProcessMemory(config, ...)` |
| `updateAgentAutostart()` | process-manager.js | `updateProcessAutostart(config, ...)` |
| `collectStatus()` | index.js (inline) | `collectStatus(config)` |
| `getBranches()` (inline) | git-ops.js | `getBranches(config)` |
| `runDeploy()` | deploy-pipeline.js | `runDeploy(config, branch)` |
| `runDeploySteps()` | deploy-pipeline.js | `runDeploySteps(config, ...)` |
| `runQuickDeploy()` | deploy-pipeline.js | `runQuickDeploy(config, ...)` |
| `waitForTomcatStop()` | deploy-pipeline.js | `waitForAppServerStop(config)` |
| `fixCorruptedJars()` | deploy-pipeline.js | `verifyArtifacts(config)` |
| `logDeploy()` | deploy-pipeline.js | `logDeploy(msg)` |
| `lastLines()` | deploy-pipeline.js | `lastLines(str, n)` |
| `execSyncDeploy()` | deploy-pipeline.js | `execWithEnv(config, cmd)` |
| Tomcat log route | log-streamer.js | `getAppServerLogs(config, lines)` |
| Agent log route | log-streamer.js | `getProcessLogs(config, name, lines)` |
| `/exec` route | command-exec.js | `execCommand(cmd, config.exec_whitelist)` |

### 4.4. Критерий за завършване

- `server.js` е заменен от `server/index.js` (~100 реда)
- Всеки модул е <= 400 реда
- Всички съществуващи API endpoints работят идентично
- `npm start` стартира сървъра както преди

---

## 5. Фаза 3 — Adapter система

**Цел**: App server, build tool и process manager да са сменяеми чрез конфигурация.

### 5.1. App Server Adapter Interface

```javascript
// adapters/app-server-adapter.js — абстрактен interface
class AppServerAdapter {
  constructor(config) { this.config = config; }

  /** Стартира app server. Връща Promise<void>. */
  async start() { throw new Error('Not implemented'); }

  /** Спира app server. gracePeriodMs — време за graceful shutdown. */
  async stop(gracePeriodMs = 15000) { throw new Error('Not implemented'); }

  /** Връща { running, pid, uptime, port }. */
  async getProcessInfo() { throw new Error('Not implemented'); }

  /** Връща { responseTime, healthy, ready, memory, cpu, threads, fds }. */
  async getMetrics() { throw new Error('Not implemented'); }

  /** Health check — дали сървърът е готов за заявки. */
  async isReady() { throw new Error('Not implemented'); }

  /** Абсолютен път до main log файла. */
  getLogPath() { throw new Error('Not implemented'); }

  /** Списък на deployed приложения. */
  async getDeployedApps() { throw new Error('Not implemented'); }

  /** Брой заявки за днес (ако е налично). */
  async getRequestsToday() { throw new Error('Not implemented'); }

  /** JVM/runtime конфигурация (ако е Java-based). */
  async getRuntimeConfig(pid) { return null; }
}
```

### 5.2. Tomcat Adapter

```javascript
// adapters/tomcat-adapter.js
class TomcatAdapter extends AppServerAdapter {
  // Имплементира всички методи с текущата Tomcat-специфична логика
  // от getTomcatStatus(), getTomcatProcess(), getTomcatThreads(), etc.
}
```

**Какво се премества от server.js:**

| Текуща функция | Метод в TomcatAdapter |
|---------------|----------------------|
| `getTomcatProcess()` | `getProcessInfo()` |
| `getTomcatStatus()` | `getMetrics()` |
| `checkPlatformReady()` | `isReady()` |
| `getTomcatThreads(pid)` | вътрешен helper в `getMetrics()` |
| `getTomcatJvm(pid)` | `getRuntimeConfig(pid)` |
| `getDeployedWebapps()` | `getDeployedApps()` |
| `getRequestsToday()` | `getRequestsToday()` |
| Stop: `shutdown.sh` + `kill -9` | `stop(gracePeriodMs)` |
| Start: `startup.sh` | `start()` |
| Log path: `TOMCAT_HOME/logs/catalina.out` | `getLogPath()` |

### 5.3. Build Adapter Interface

```javascript
// adapters/build-adapter.js
class BuildAdapter {
  constructor(config) { this.config = config; }

  /** Бърз incremental build. Връща Promise<{ success, output }>. */
  async buildIncremental(logFn) { throw new Error('Not implemented'); }

  /** Пълен clean build. Връща Promise<{ success, output }>. */
  async buildFull(logFn) { throw new Error('Not implemented'); }

  /** Списък от пътища на build artifacts за копиране. */
  getArtifactPaths() { throw new Error('Not implemented'); }

  /** Копира artifacts към deploy target. */
  async copyArtifacts(targetDir, logFn) { throw new Error('Not implemented'); }

  /** Верифицира artifacts (checksums и т.н.). */
  async verifyArtifacts(targetDir, logFn) { return true; }
}
```

### 5.4. Gradle Adapter

```javascript
// adapters/gradle-adapter.js
class GradleAdapter extends BuildAdapter {
  // Имплементира с текущата Gradle логика от runDeploySteps()
}
```

**Какво се премества:**

| Текуща логика в runDeploySteps() | Метод в GradleAdapter |
|----------------------------------|----------------------|
| `./gradlew devClasses devLib jar` | `buildIncremental()` |
| `./gradlew clean` + `makebuild` | `buildFull()` |
| `build/release`, `devBuild`, `build/libs` | `getArtifactPaths()` |
| rm + cp логика за lib/bin/sbin/etc | `copyArtifacts()` |
| MD5 checksum comparison | `verifyArtifacts()` |

### 5.5. Process Manager Adapter Interface

```javascript
// adapters/process-adapter.js
class ProcessManagerAdapter {
  constructor(config) { this.config = config; }

  /** Списък на конфигурирани процеси от config файла. */
  async getConfiguredProcesses() { throw new Error('Not implemented'); }

  /** Списък на текущо работещи процеси. */
  async getRunningProcesses() { throw new Error('Not implemented'); }

  /** Агрегиран списък: configured + running + enriched metrics. */
  async getAllProcesses() { throw new Error('Not implemented'); }

  /** Стартира процес по име. */
  async startProcess(name) { throw new Error('Not implemented'); }

  /** Спира процес по име. */
  async stopProcess(name) { throw new Error('Not implemented'); }

  /** Рестартира всички процеси. */
  async restartAll() { throw new Error('Not implemented'); }

  /** Обновява memory config за процес. */
  async updateMemory(name, value) { throw new Error('Not implemented'); }

  /** Обновява autostart config за процес. */
  async updateAutostart(name, enabled) { throw new Error('Not implemented'); }

  /** Път до лог файл на процес. */
  getLogPath(name) { throw new Error('Not implemented'); }
}
```

### 5.6. GeoWealth Agents Adapter

```javascript
// adapters/geowealth-agents-adapter.js
class GeoWealthAgentsAdapter extends ProcessManagerAdapter {
  // Имплементира с текущата логика за nfjobs/nfstart/nfstop/YAML parsing
}
```

### 5.7. Adapter Factory

```javascript
// adapters/factory.js
function createAdapters(config) {
  return {
    appServer: createAppServerAdapter(config),
    build: createBuildAdapter(config),
    processManager: config.agents ? createProcessAdapter(config) : null
  };
}

function createAppServerAdapter(config) {
  switch (config.app_server.type) {
    case 'tomcat': return new TomcatAdapter(config);
    // Бъдещи: case 'jetty': case 'spring-boot': case 'custom':
    default: throw new Error(`Unknown app server type: ${config.app_server.type}`);
  }
}

function createBuildAdapter(config) {
  switch (config.build.type) {
    case 'gradle': return new GradleAdapter(config);
    // Бъдещи: case 'maven': case 'npm': case 'custom':
    default: throw new Error(`Unknown build type: ${config.build.type}`);
  }
}
```

### 5.8. Промяна на модулите да използват adapters

**deploy-pipeline.js** — най-голямата промяна:

Текущо `runDeploySteps()` съдържа inline:
- `shutdown.sh` → `adapters.appServer.stop()`
- `./gradlew ...` → `adapters.build.buildIncremental()` / `buildFull()`
- cp/rm → `adapters.build.copyArtifacts()`
- `startup.sh` → `adapters.appServer.start()`
- HTTP poll → `adapters.appServer.isReady()`

Новият deploy pipeline става:
```
1. Git operations (git-ops module)
2. adapters.appServer.stop()
3. adapters.build.buildIncremental() || adapters.build.buildFull()
4. adapters.build.copyArtifacts()
5. adapters.build.verifyArtifacts()
6. adapters.appServer.start()
7. poll adapters.appServer.isReady()
```

### 5.9. Критерий за завършване

- `config.yml` определя кой adapter се зарежда
- Промяна на app server type изисква само нов adapter + промяна в config
- Deploy pipeline не съдържа Tomcat/Gradle-специфичен код
- Всички текущи функционалности работят идентично

---

## 6. Фаза 4 — Абстракция на клиента

**Цел**: Разделяне на `popup.js` (1170 реда) на модули и елиминиране на дублиран код с `background.js`.

### 6.1. Shared модули (extension-wide)

#### shared/api-client.js (~80 реда)

Извлича се от popup.js и background.js:

```javascript
// Единна точка за комуникация със сървъра
class ApiClient {
  constructor(baseUrl) { this.baseUrl = baseUrl; }

  static async create() {
    const { serverUrl } = await chrome.storage.local.get('serverUrl');
    return new ApiClient(serverUrl || 'http://localhost:7103');
  }

  async getStatus(timeoutMs = 10000) { ... }
  async getClientConfig() { ... }
  async stopAppServer(timeoutMs = 120000) { ... }
  async restartAppServer(timeoutMs = 120000) { ... }
  async stopProcess(name) { ... }
  async restartProcess(name) { ... }
  async restartAllProcesses() { ... }
  async getBranches() { ... }
  async getGitStatus() { ... }
  async stash() { ... }
  async pull(branch) { ... }
  async deploy(branch) { ... }
  async quickDeploy(agents, restartAppServer) { ... }
  async getDeployStatus() { ... }
  createDeployStream() { ... }  // returns EventSource
  async getLogs(type, name, lines) { ... }
  async execCommand(cmd) { ... }
  async freeRam() { ... }
  async clearSwap() { ... }
  async restartServer() { ... }
  async updateProcessMemory(name, memory) { ... }
  async updateProcessAutostart(name, enabled) { ... }
}
```

**Елиминира дублиране**: `getApiUrl()` е идентична в popup.js и background.js.

#### shared/storage.js (~50 реда)

```javascript
// Единна точка за chrome.storage операции
const StorageKeys = {
  SERVER_URL: 'serverUrl',
  THEME: 'theme',
  LAST_STATUS: 'lastStatus',
  LAST_CHECK: 'lastCheck',
  HEALTHY: 'healthy',
  ERROR: 'error',
  MANUALLY_STARTED: 'manuallyStarted',
  MANUALLY_STOPPED: 'manuallyStopped',
  PENDING_RESTARTS: 'pendingRestarts'
};

async function getAll(keys) { ... }
async function set(data) { ... }
async function clearCachedData() { ... }
```

#### shared/pending-agents.js (~60 реда)

```javascript
// Единна логика за pending agent tracking
const PENDING_TTL_MS = 5 * 60 * 1000;

async function loadPending() { ... }
async function savePending(map) { ... }
async function markPending(name) { ... }
async function removePending(name) { ... }
async function reconcile(statusData) { ... }  // returns { changed, resolved[] }
function isStale(timestamp) { ... }
```

**Елиминира дублиране**: `reconcilePendingAgents()` е в popup.js, подобна логика е inline в background.js `checkStatus()`.

### 6.2. Разделяне на popup.js

#### popup/main.js (~60 реда)

Entry point — инициализация:

```javascript
// DOMContentLoaded handler
// - applyTheme()
// - loadClientConfig() ← NEW: fetch /config/client за dynamic UI
// - loadAndRender()
// - loadBranches()
// - setupEventListeners()
// - resumePendingPolls()
// - checkDeployStatus()
```

#### popup/renderers/system-stats.js (~50 реда)

Извлича се от `render()`:
- Рендериране на system section: uptime, load, RAM/swap/disk bars
- `setBar(id, used, total, text)`
- `formatBytes(bytes)`
- `formatUptime(secs)`

#### popup/renderers/app-server.js (~80 реда)

Извлича се от `render()`:
- Рендериране на Tomcat/app server section
- Status dot, response time, uptime, requests, memory bar, CPU, threads, FDs
- JVM config display
- Webapps list

**Динамично**: Секцията се показва/скрива спрямо `clientConfig.app_server_type`.

#### popup/renderers/processes.js (~150 реда)

Извлича се от `render()` (agents table rendering):
- Agent/process table generation
- Sorting (running first, then by name)
- Status dots (green/yellow/red/gray)
- Memory bars per process
- Autostart toggles
- Action buttons (stop/restart/logs)

#### popup/renderers/deploy.js (~250 реда)

Извлича се от popup.js (deploy-related functions):
- `loadBranches()`, `setupTypeahead()`, `showDropdown()`, `selectBranch()`
- `updateDirtyState()`
- `startPull()`, `stashChanges()`
- `startDeploy()`, `startQuickDeploy()`
- `streamDeployLog()`, `pollDeployLog()`
- `renderDeployLog()`, `linkifyCommands()`, `execCommand()`
- `checkDeployStatus()`

**Динамично**: Секцията се показва/скрива спрямо `clientConfig.has_deploy`.

#### popup/renderers/log-viewer.js (~60 реда)

Извлича се от popup.js:
- `openLogViewer()`, `closeLogViewer()`, `refreshLogViewer()`
- `fetchLogs()`, `highlightLogErrors()`

#### popup/renderers/settings.js (~30 реда)

- `toggleSettings()`, `saveUrl()`

#### popup/theme.js (~30 реда)

- `applyTheme()`, `toggleTheme()`

#### popup/utils.js (~20 реда)

- `escapeHtml()`, `showError()`, `hideError()`, `parseXmx()`

### 6.3. Маппинг: popup.js функции → нови файлове

| Функция в popup.js | Целеви файл |
|---------------------|-------------|
| `getApiUrl()` | shared/api-client.js |
| `applyTheme()` | popup/theme.js |
| `toggleTheme()` | popup/theme.js |
| `loadPendingAgents()` | shared/pending-agents.js |
| `savePendingAgents()` | shared/pending-agents.js |
| `reconcilePendingAgents()` | shared/pending-agents.js |
| `pollPendingAgents()` | popup/renderers/processes.js |
| `startPollLoop()` | popup/renderers/processes.js |
| `stopPollLoop()` | popup/renderers/processes.js |
| `resumePendingPolls()` | popup/main.js |
| `loadAndRender()` | popup/main.js |
| `refresh()` | popup/main.js |
| `render()` | popup/main.js (orchestrates renderers) |
| `setBar()` | popup/renderers/system-stats.js |
| `formatBytes()` | popup/renderers/system-stats.js |
| `formatUptime()` | popup/renderers/system-stats.js |
| `parseXmx()` | popup/utils.js |
| `escapeHtml()` | popup/utils.js |
| `showError()` / `hideError()` | popup/utils.js |
| `toggleSettings()` | popup/renderers/settings.js |
| `saveUrl()` | popup/renderers/settings.js |
| `loadBranches()` | popup/renderers/deploy.js |
| `setupTypeahead()` | popup/renderers/deploy.js |
| `showDropdown()` | popup/renderers/deploy.js |
| `highlightMatch()` | popup/renderers/deploy.js |
| `selectBranch()` | popup/renderers/deploy.js |
| `updateDirtyState()` | popup/renderers/deploy.js |
| `stashChanges()` | popup/renderers/deploy.js |
| `startPull()` | popup/renderers/deploy.js |
| `startDeploy()` | popup/renderers/deploy.js |
| `startQuickDeploy()` | popup/renderers/deploy.js |
| `streamDeployLog()` | popup/renderers/deploy.js |
| `streamQuickDeployLog()` | popup/renderers/deploy.js |
| `pollDeployLog()` | popup/renderers/deploy.js |
| `checkDeployStatus()` | popup/renderers/deploy.js |
| `renderDeployLog()` | popup/renderers/deploy.js |
| `linkifyCommands()` | popup/renderers/deploy.js |
| `execCommand()` | popup/renderers/deploy.js |
| `restartAgent()` | popup/renderers/processes.js |
| `stopAgent()` | popup/renderers/processes.js |
| `restartAllAgents()` | popup/renderers/processes.js |
| `editAgentMemory()` | popup/renderers/processes.js |
| `toggleAutostart()` | popup/renderers/processes.js |
| `freeRam()` | popup/renderers/system-stats.js |
| `clearSwap()` | popup/renderers/system-stats.js |
| `restartServer()` | popup/renderers/system-stats.js |
| `stopTomcat()` | popup/renderers/app-server.js |
| `restartTomcat()` | popup/renderers/app-server.js |
| `openLogViewer()` | popup/renderers/log-viewer.js |
| `closeLogViewer()` | popup/renderers/log-viewer.js |
| `refreshLogViewer()` | popup/renderers/log-viewer.js |
| `fetchLogs()` | popup/renderers/log-viewer.js |
| `highlightLogErrors()` | popup/renderers/log-viewer.js |

### 6.4. manifest.json промени

Понеже Chrome extensions MV3 не поддържат ES modules в popup контекст без bundler, има две опции:

**Опция A: Без bundler** — всички JS файлове като отделни `<script>` в popup.html:
```html
<script src="shared/storage.js"></script>
<script src="shared/api-client.js"></script>
<script src="shared/pending-agents.js"></script>
<script src="popup/utils.js"></script>
<script src="popup/theme.js"></script>
<script src="popup/renderers/system-stats.js"></script>
<script src="popup/renderers/app-server.js"></script>
<script src="popup/renderers/processes.js"></script>
<script src="popup/renderers/deploy.js"></script>
<script src="popup/renderers/log-viewer.js"></script>
<script src="popup/renderers/settings.js"></script>
<script src="popup/main.js"></script>
```

Споделяне на модулите със shared/ чрез глобални обекти или IIFE pattern.

**Опция B: С esbuild bundler** — позволява ES modules (`import/export`), tree-shaking, и единен bundle:
```json
// package.json
"scripts": {
  "build:extension": "esbuild chrome-extension/popup/main.js --bundle --outfile=chrome-extension/dist/popup.js"
}
```

**Препоръка**: Опция A за простота на Фаза 4. Bundler може да се добави по-късно ако проектът нарасне.

### 6.5. background.js рефакторинг

background.js ще import-не shared модулите чрез `importScripts()` (поддържано в MV3 service workers):

```javascript
// background.js
importScripts('shared/storage.js', 'shared/api-client.js', 'shared/pending-agents.js');
```

Останалата логика (alarm management, badge updates, notifications) остава в background.js, но:
- `getApiUrl()` → `ApiClient.create()`
- Pending agent logic → `PendingAgents.reconcile()`
- Storage reads → `Storage.getAll()`

### 6.6. Критерий за завършване

- popup.js е разделен на ~10 файла, всеки < 250 реда
- Нулев дублиран код между popup и background
- Всички UI функционалности работят идентично
- shared/ модулите се ползват и от popup, и от background

---

## 7. Фаза 5 — Multi-profile поддръжка

**Цел**: Extension-ът да поддържа мониторинг на множество сървъри едновременно.

### 7.1. Концепция

```
Profiles: [
  { name: "Dev Petar", url: "http://dev-petar:7103", color: "#3b82f6" },
  { name: "Dev Ivan",  url: "http://dev-ivan:7103", color: "#22c55e" },
  { name: "Staging",   url: "http://staging:7103",  color: "#f59e0b" }
]
```

### 7.2. Промени в UI

- **Header**: Dropdown за избор на профил (вместо единично "GeoWealth Server")
- **Settings**: Списък от профили с add/edit/remove
- **Badge**: Показва aggregate health от всички активни профили
- **Notifications**: Включват име на профила в текста

### 7.3. Промени в storage

```javascript
// Текущо
{ serverUrl: "http://localhost:7103", lastStatus: {...} }

// Ново
{
  profiles: [
    { id: "uuid1", name: "Dev Petar", url: "http://localhost:7103", active: true },
    { id: "uuid2", name: "Staging", url: "http://staging:7103", active: true }
  ],
  activeProfile: "uuid1",  // за popup display
  profileData: {
    "uuid1": { lastStatus: {...}, lastCheck: ..., healthy: true },
    "uuid2": { lastStatus: {...}, lastCheck: ..., healthy: false }
  }
}
```

### 7.4. Промени в background.js

- Alarm проверява ВСИЧКИ активни профили
- Badge показва обобщен статус (worst-case от всички)
- Notifications включват profile name

### 7.5. Критерий за завършване

- Потребителят може да добави/премахне сървъри от Settings
- Popup показва данни за избрания профил
- Badge отразява health на ВСИЧКИ профили
- Всеки профил се мониторира независимо

---

## 8. Детайлни инструкции по файл

### server.js → разделяне

```
Ред 1-20     (imports, constants)     → config.js + utils.js
Ред 21-30    (PORT, paths, env)       → config.yml
Ред 31-50    (CORS, express setup)    → index.js
Ред 51-65    (runCmd, runCmdStrict)   → utils.js
Ред 66-130   (getSystemInfo)          → modules/system-monitor.js
Ред 131-145  (checkPlatformReady)     → adapters/tomcat-adapter.js
Ред 146-230  (getTomcat*)             → adapters/tomcat-adapter.js
Ред 231-340  (getAgents, enrich*)     → modules/process-manager.js + adapters/geowealth-agents-adapter.js
Ред 341-360  (collectStatus)          → index.js
Ред 361-380  (GET /status, /ping)     → index.js
Ред 381-420  (POST /stop|restart/tomcat) → modules/app-server-manager.js
Ред 421-500  (POST agent routes)      → modules/process-manager.js
Ред 501-530  (POST system routes)     → modules/system-monitor.js
Ред 531-560  (POST /exec)            → modules/command-exec.js
Ред 561-600  (GET /logs/*)           → modules/log-streamer.js
Ред 601-630  (PUT /config/agent/*)   → modules/process-manager.js
Ред 631-700  (GET /git/*, POST /git/*) → modules/git-ops.js
Ред 701-750  (POST /pull)            → modules/git-ops.js
Ред 751-770  (deploy helpers)         → modules/deploy-pipeline.js
Ред 771-1100 (runDeploy, runDeploySteps) → modules/deploy-pipeline.js + adapters/gradle-adapter.js
Ред 1101-1200 (runQuickDeploy)       → modules/deploy-pipeline.js
Ред 1201-1260 (POST /deploy, /quick-deploy) → modules/deploy-pipeline.js
Ред 1261-1320 (GET /deploy/status|stream) → modules/deploy-pipeline.js
Ред 1321-1397 (app.listen, git auth setup) → index.js
```

### popup.js → разделяне

```
Ред 1-10     (constants, DEFAULT_URL)  → shared/api-client.js
Ред 11-30    (module vars, pendingAgents) → shared/pending-agents.js
Ред 31-50    (getApiUrl, applyTheme)   → shared/api-client.js, popup/theme.js
Ред 51-80    (loadPendingAgents, savePendingAgents) → shared/pending-agents.js
Ред 81-110   (DOMContentLoaded setup)  → popup/main.js
Ред 111-140  (toggleTheme, toggleSettings) → popup/theme.js, popup/renderers/settings.js
Ред 141-170  (saveUrl)                → popup/renderers/settings.js
Ред 171-240  (refresh, loadAndRender)  → popup/main.js
Ред 241-430  (render — system + tomcat + agents) → popup/renderers/*.js
Ред 431-450  (setBar, formatBytes, formatUptime) → popup/renderers/system-stats.js
Ред 451-470  (parseXmx, escapeHtml)    → popup/utils.js
Ред 471-540  (agent actions: restart, stop, editMemory) → popup/renderers/processes.js
Ред 541-570  (toggleAutostart)         → popup/renderers/processes.js
Ред 571-640  (pending agents polling)  → popup/renderers/processes.js
Ред 641-700  (freeRam, clearSwap, restartServer) → popup/renderers/system-stats.js
Ред 701-730  (stopTomcat, restartTomcat) → popup/renderers/app-server.js
Ред 731-800  (loadBranches, typeahead) → popup/renderers/deploy.js
Ред 801-870  (showDropdown, selectBranch, highlightMatch) → popup/renderers/deploy.js
Ред 871-920  (stashChanges, startPull) → popup/renderers/deploy.js
Ред 921-1010 (startDeploy, startQuickDeploy) → popup/renderers/deploy.js
Ред 1011-1090 (streamDeployLog, pollDeployLog, renderDeployLog) → popup/renderers/deploy.js
Ред 1091-1120 (linkifyCommands, execCommand) → popup/renderers/deploy.js
Ред 1121-1170 (log viewer: open, close, refresh, fetch, highlight) → popup/renderers/log-viewer.js
```

---

## 9. Нова файлова структура

```
gw-monitor-extension/
├── server/
│   ├── index.js                         # Express app entry point (~100 реда)
│   ├── config.js                        # Config loader + validator (~60 реда)
│   ├── utils.js                         # runCmd, runCmdStrict, runAsync (~30 реда)
│   ├── modules/
│   │   ├── system-monitor.js            # RAM/CPU/disk/uptime + routes (~100 реда)
│   │   ├── app-server-manager.js        # App server routes, delegates to adapter (~80 реда)
│   │   ├── process-manager.js           # Process/agent routes, delegates to adapter (~120 реда)
│   │   ├── git-ops.js                   # Git operations + routes (~80 реда)
│   │   ├── deploy-pipeline.js           # Deploy orchestration + routes (~300 реда)
│   │   ├── log-streamer.js              # Log tailing + routes (~60 реда)
│   │   └── command-exec.js              # Whitelisted exec + route (~40 реда)
│   └── adapters/
│       ├── app-server-adapter.js        # Abstract interface (~30 реда)
│       ├── tomcat-adapter.js            # Tomcat implementation (~200 реда)
│       ├── build-adapter.js             # Abstract interface (~25 реда)
│       ├── gradle-adapter.js            # Gradle implementation (~200 реда)
│       ├── process-adapter.js           # Abstract interface (~30 реда)
│       ├── geowealth-agents-adapter.js  # GeoWealth agent implementation (~180 реда)
│       └── factory.js                   # Adapter instantiation (~30 реда)
│
├── chrome-extension/
│   ├── manifest.json
│   ├── popup.html                       # Обновен с multiple <script> tags
│   ├── popup.css                        # Без промяна
│   ├── background.js                    # Рефакториран, ползва shared/ (~120 реда)
│   ├── shared/
│   │   ├── api-client.js               # HTTP client (~80 реда)
│   │   ├── storage.js                  # chrome.storage wrapper (~50 реда)
│   │   └── pending-agents.js           # Pending tracking logic (~60 реда)
│   ├── popup/
│   │   ├── main.js                     # Entry point + orchestration (~60 реда)
│   │   ├── theme.js                    # Theme management (~30 реда)
│   │   ├── utils.js                    # escapeHtml, showError, parseXmx (~20 реда)
│   │   └── renderers/
│   │       ├── system-stats.js         # System section (~50 реда)
│   │       ├── app-server.js           # App server section (~80 реда)
│   │       ├── processes.js            # Process/agent table (~150 реда)
│   │       ├── deploy.js              # Deploy section + log (~250 реда)
│   │       ├── log-viewer.js          # Log modal (~60 реда)
│   │       └── settings.js            # Settings panel (~30 реда)
│   └── icons/                          # Без промяна
│
├── config.yml                           # Конфигурация за конкретна среда
├── config.example.yml                   # Примерна конфигурация с коментари
├── package.json                         # Обновен main: "server/index.js"
└── README.md                            # Обновена документация
```

**Общо редове код (приблизително):**
- Сървър: ~1185 реда (vs 1397 текущо) — по-малко заради елиминиран boilerplate
- Клиент: ~960 реда (vs 1361 текущо popup.js + background.js) — по-малко заради елиминиран дублиран код
- Конфигурация: ~80 реда config.yml

---

## 10. API промени

### Backwards-compatible aliases

За плавна миграция, старите endpoints ще имат aliases към новите:

| Стар endpoint | Нов endpoint | Alias период |
|---------------|-------------|-------------|
| `POST /stop/tomcat` | `POST /stop/app-server` | Фаза 2-3 |
| `POST /restart/tomcat` | `POST /restart/app-server` | Фаза 2-3 |
| `POST /stop/agent/:name` | `POST /stop/process/:name` | Фаза 2-3 |
| `POST /restart/agent/:name` | `POST /restart/process/:name` | Фаза 2-3 |
| `POST /restart/agents` | `POST /restart/processes` | Фаза 2-3 |
| `PUT /config/agent/:name/memory` | `PUT /config/process/:name/memory` | Фаза 2-3 |
| `PUT /config/agent/:name/autostart` | `PUT /config/process/:name/autostart` | Фаза 2-3 |
| `GET /logs/tomcat` | `GET /logs/app-server` | Фаза 2-3 |
| `GET /logs/agent/:name` | `GET /logs/process/:name` | Фаза 2-3 |

### Нов endpoint

```
GET /config/client → {
  name: "GeoWealth Dev Server",
  app_server_type: "tomcat",
  build_type: "gradle",
  has_agents: true,
  has_deploy: true,
  thresholds: { ram_warning: 75, ram_danger: 90, ram_critical: 95 }
}
```

### Status response промени

Текущият `/status` response се запазва, но ключовете се генерализират:

```json
{
  "system": { ... },
  "app_server": {               // бивш "tomcat"
    "type": "tomcat",           // NEW
    "running": true,
    "ready": true,
    "response_time": 45,
    "pid": 12345,
    ...
  },
  "processes": [ ... ],         // бивш "agents"
  "timestamp": "..."
}
```

**Важно**: `processes` вместо `agents`, `app_server` вместо `tomcat`. Клиентът ще трябва да се обнови да чете новите ключове.

---

## 11. Тестова стратегия

### Преди да започнеш (Фаза 0)

1. **Snapshot тестове на API**: Запиши текущите responses от всеки endpoint
   ```bash
   curl http://localhost:7103/status > tests/snapshots/status.json
   curl http://localhost:7103/git/branches > tests/snapshots/branches.json
   # ... за всеки endpoint
   ```

2. **Manual test checklist** — документирай всички user flows:
   - [ ] Popup зарежда и показва status
   - [ ] Refresh бутон обновява данните
   - [ ] Theme toggle работи (light/dark/auto)
   - [ ] Settings: промяна на URL + save + reload
   - [ ] System: Free RAM / Clear Swap / Restart Server
   - [ ] App Server: Stop / Restart / Logs
   - [ ] Agents: Start / Stop / Restart / Restart All
   - [ ] Agents: Edit Memory / Toggle Autostart
   - [ ] Agent Logs: Open / Change lines / Refresh
   - [ ] Deploy: Branch search / Select / Pull / Stash
   - [ ] Deploy: Full deploy with log streaming
   - [ ] Deploy: Quick deploy with options
   - [ ] Background: Badge updates (green/red/gray)
   - [ ] Background: Notifications on state change
   - [ ] Pending agents: Yellow dot + "Starting..." + auto-resolve

### По време на всяка фаза

3. **Regression check**: След всяка промяна, сравни API responses с snapshot-ите
4. **Smoke test**: Зареди extension-а в Chrome, провери popup + background

### След Фаза 2 (модуларизация)

5. **Unit тестове за модулите** (по желание, но препоръчително):
   ```
   tests/
   ├── system-monitor.test.js
   ├── app-server-manager.test.js
   ├── process-manager.test.js
   ├── git-ops.test.js
   ├── deploy-pipeline.test.js
   └── config.test.js
   ```

### След Фаза 3 (adapters)

6. **Adapter тестове**: Всеки adapter се тества с mock shell commands
7. **Integration test**: Пълен deploy pipeline с mock adapter-и

---

## 12. Рискове и митигации

| # | Риск | Вероятност | Impact | Митигация |
|---|------|-----------|--------|-----------|
| 1 | **Регресии при рефакторинг** — нещо спира да работи | Висока | Висок | API snapshots преди начало; тествай всеки endpoint след всеки commit |
| 2 | **Over-engineering** — прекалено много абстракция за единичен проект | Средна | Среден | Спри след Фаза 2 ако нямаш нужда от multi-server support |
| 3 | **Chrome MV3 ограничения** — shared/ модули и importScripts() | Ниска | Среден | Опция A (multiple scripts) е proven; esbuild като fallback |
| 4 | **Deploy pipeline чупене** — критичен production flow | Средна | Висок | Тествай deploy pipeline на staging преди production; запази стария server.js като backup |
| 5 | **YAML config грешки** — typo в config.yml чупи всичко | Средна | Среден | Config validator в config.js с ясни error messages; config.example.yml с коментари |
| 6 | **Performance degradation** — повече файлове = по-бавно зареждане | Ниска | Нисък | Chrome extension popup.html зарежда локални файлове — delay е < 10ms |
| 7 | **Scope creep** — "щом рефакторираме, нека добавим и X" | Висока | Среден | Всяка фаза е self-contained; не добавяй нови features по време на рефакторинг |
| 8 | **Config format промени** — нужда от миграция на config файлове | Ниска | Нисък | Версионирай config format с `version: 1` поле; migration script при нужда |

### Rollback план

За всяка фаза:
1. Работи в отделен git branch (`migration/phase-N`)
2. Merge само когато фазата е напълно функционална
3. Tag преди merge: `git tag pre-phase-N`
4. При проблеми: `git revert` на merge commit-а

---

## 13. Приоритизация

### Матрица Impact vs Effort

```
          │ Нисък effort    │ Среден effort     │ Висок effort
──────────┼─────────────────┼───────────────────┼──────────────────
Висок     │ ФАЗА 1          │ ФАЗА 3            │ ФАЗА 5
impact    │ Config файл     │ Adapter система   │ Multi-profile
          │ ★★★★★           │ ★★★★              │ ★★★
──────────┼─────────────────┼───────────────────┼──────────────────
Среден    │                 │ ФАЗА 2            │ ФАЗА 4
impact    │                 │ Модуларизация     │ Client абстракция
          │                 │ ★★★★              │ ★★★
──────────┼─────────────────┼───────────────────┼──────────────────
Нисък     │                 │                   │
impact    │                 │                   │
```

### Препоръчан план

| Фаза | Описание | Предварително условие | Приблизителен обхват |
|------|----------|----------------------|---------------------|
| **0** | API snapshots + test checklist | Няма | 10-15 endpoint snapshots |
| **1** | Config файл | Фаза 0 | ~20 промени в server.js |
| **2** | Модуларизация на server.js | Фаза 1 | 1 файл → 9 файла |
| **3** | Adapter система | Фаза 2 | 3 abstract + 3 concrete adapters |
| **4** | Client абстракция | Фаза 1 (минимум) | 2 файла → 13 файла |
| **5** | Multi-profile | Фаза 4 | Storage schema + UI changes |

### Minimum Viable Abstraction (MVP)

Ако целта е само **"да работи на друга машина без промяна на код"**, достатъчно е:

**Фаза 0 + Фаза 1** = Config файл + API snapshots

Това покрива 80% от ползата с 20% от усилието.

### Пълна абстракция

Ако целта е **"extension за произволен Java app server с произволен build tool"**:

**Фаза 0 → 1 → 2 → 3 → 4** (без Фаза 5 ако не трябва multi-server)

### Enterprise-grade

Ако целта е **"всеки разработчик в екипа да мониторира множество сървъри"**:

**Фаза 0 → 1 → 2 → 3 → 4 → 5**
