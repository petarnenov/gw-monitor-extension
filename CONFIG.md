# config.yml — Configuration Reference

This document describes every field in `config.yml`, the main configuration file for the Server Monitor API.

## Quick Start

```bash
cp config.example.yml config.yml
# Edit config.yml with your environment-specific values
npm start
```

> **Important:** `config.yml` is environment-specific and should NOT be committed to git. Only `config.example.yml` is tracked.

---

## Template Variables

Any string value can reference other config values using `{section.key}` syntax. References are resolved recursively (two passes), so nested references work.

```yaml
paths:
  deploy_target: /home/user/BEServer

agents:
  log_dir: "{paths.deploy_target}/logs"   # Resolves to /home/user/BEServer/logs
```

---

## Required Fields

The server will refuse to start if any of these are missing:

| Field | Description |
|-------|-------------|
| `server.port` | API server listen port |
| `paths.source` | Path to source code / git repo |
| `paths.deploy_target` | Path to deploy target directory |
| `app_server.type` | App server type identifier |
| `app_server.home` | App server installation directory |
| `app_server.port` | App server HTTP port |
| `build.type` | Build tool type identifier |

---

## Sections

### `server`

Controls the monitor API server itself.

```yaml
server:
  port: 7103
  name: "Petar Dev Server"
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `port` | integer | **yes** | — | Port the monitor API listens on. Can be overridden with `--port` CLI argument. |
| `name` | string | no | `"Server Monitor"` | Display name shown in the Chrome extension popup header and notifications. Use it to distinguish between multiple dev servers. |

**CLI override:**
```bash
node server/index.js --port 9876          # overrides server.port
node server/index.js --config other.yml   # use a different config file
```

---

### `paths`

File system paths for your development environment. These are referenced by other sections via template variables.

```yaml
paths:
  source: /home/petar/AppServer/geowealth
  deploy_target: /home/petar/AppServer/BEServer
  java_home: /home/petar/AppServer/amazon-corretto-17.0.18.9.1-linux-x64
  gradle_cache: ~/.gradle/caches/modules-2/files-2.1
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | path | **yes** | — | Root of the source code / git repository. All git operations (`fetch`, `checkout`, `pull`, `stash`) run against this directory. Build commands also execute here. |
| `deploy_target` | path | **yes** | — | The deployment target directory (e.g., `BEServer/`). Built artifacts (JARs, configs, scripts) are copied here. Agent commands (`nfjobs`, `nfstart`, etc.) run from `{deploy_target}/sbin/`. |
| `java_home` | path | no | — | `JAVA_HOME` passed to Gradle and the app server. **Must point to a valid JDK installation.** If this is wrong, builds will fail with "JAVA_HOME is set to an invalid directory". |
| `gradle_cache` | path | no | — | Gradle dependency cache directory. Currently informational only. |

**Auto-derived paths** (set automatically if not explicitly configured):

| Derived Path | Default Value | Used For |
|--------------|---------------|----------|
| `paths.sbin` | `{deploy_target}/sbin` | Agent management scripts (`nfjobs`, `nfstart`, `nfstop`, etc.) |
| `paths.pids` | `{deploy_target}/pids` | Agent PID files |
| `paths.logs` | `{deploy_target}/logs` | Agent log directories |

---

### `app_server`

Configuration for the application server (Tomcat).

```yaml
app_server:
  type: tomcat
  home: /home/petar/AppServer/apache-tomcat-9.0.38
  port: 8080
  health_check:
    path: /platformOne/checkPlatformStatus.do
    expected_status: 200
    timeout_ms: 5000
  logs:
    main: logs/catalina.out
    access: "logs/localhost_access_log.{date}.txt"
  webapps_dir: webapps
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | **yes** | — | App server type. Currently only `tomcat` is supported. Determines which adapter class is instantiated. |
| `home` | path | **yes** | — | App server installation root directory. Used to locate `bin/startup.sh`, `bin/shutdown.sh`, logs, and webapps. |
| `port` | integer | **yes** | — | HTTP port the app server listens on. Used for health checks and status polling (`http://localhost:{port}/`). |

#### `app_server.health_check`

Controls how the monitor determines if the app server is **ready** (not just running, but fully loaded and serving requests). This directly affects the badge icon color in the Chrome extension:

- **Green** = running AND ready
- **Yellow** = running but NOT ready (health check fails)
- **Red/Gray** = not running or unreachable

```yaml
  health_check:
    path: /platformOne/checkPlatformStatus.do
    expected_status: 200
    timeout_ms: 5000
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | `/platformOne/checkPlatformStatus.do` | HTTP endpoint path to check. The monitor sends `GET http://localhost:{port}{path}`. **Choose an endpoint that only returns success when the application is fully loaded** — not just when Tomcat is up. |
| `expected_status` | integer | `302` | The HTTP status code that indicates "ready". If the endpoint returns this code, the server is considered ready. Common values: `200` (OK), `302` (redirect to login page). |
| `timeout_ms` | integer | `5000` | Timeout in milliseconds for the health check HTTP request. If the server doesn't respond within this time, it's considered not ready. |

> **Common mistake:** Setting `path: /health` when no such endpoint exists. This causes the badge to stay yellow even when the app is working fine. Use an endpoint that actually exists in your application.

#### `app_server.logs`

Paths to log files, **relative to `app_server.home`**.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `main` | string | `logs/catalina.out` | Main application log file. Used by the log viewer in the popup. |
| `access` | string | `logs/localhost_access_log.{date}.txt` | Access log file pattern. The `{date}` placeholder is replaced with today's date (`YYYY-MM-DD`) to count today's requests. |

#### Other `app_server` fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `webapps_dir` | string | `webapps` | Name of the webapps directory (relative to `home`). Used to list deployed applications in the status response. |
| `bin_dir` | string | `{home}/bin` | Auto-derived. Directory containing `startup.sh` and `shutdown.sh`. |
| `logs_dir` | string | `{home}/logs` | Auto-derived. Directory containing log files. |

---

### `build`

Configuration for the build tool (Gradle).

```yaml
build:
  type: gradle
  working_dir: "{paths.source}"
  commands:
    incremental: "./gradlew devClasses devLib jar"
    jar_only: "./gradlew jar"
    full_clean: "./gradlew clean"
    full_build: "./gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false"
  output:
    release_dir: build/release
    dev_dir: devBuild
    jar_dir: build/libs
    jar_name: geowealth.jar
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | **yes** | — | Build tool type. Currently only `gradle` is supported. |
| `working_dir` | path | no | `{paths.source}` | Directory where build commands are executed. Usually the same as the source code root. |

#### `build.commands`

Shell commands executed during deploy. Each command runs with `JAVA_HOME` set to `paths.java_home`.

| Field | Description | Used By |
|-------|-------------|---------|
| `incremental` | Fast build: compiles changed classes, copies dependencies, builds JAR. | **Deploy** button (Step 6 — tried first) |
| `jar_only` | Builds only the main JAR file. | **Quick Deploy** button (Step 1) |
| `full_clean` | Cleans all build outputs. | **Deploy** button (Step 6 — fallback if incremental fails) |
| `full_build` | Full build from scratch (without frontend builds). | **Deploy** button (Step 6 — fallback after clean) |

**Deploy build strategy:**
1. Try `incremental` first (fast, ~1-5 seconds if only code changed)
2. If incremental fails, fall back to `full_clean` + `full_build` (~2-5 minutes)

#### `build.output`

Paths to build outputs, **relative to `build.working_dir`**.

| Field | Type | Description |
|-------|------|-------------|
| `release_dir` | string | Full build output directory. Contains `lib/`, `WebContent/`, etc. after `full_build`. |
| `dev_dir` | string | Incremental build output directory. Contains compiled classes after `incremental`. |
| `jar_dir` | string | Directory containing the built JAR file. |
| `jar_name` | string | Name of the main application JAR file. Used when copying to `deploy_target/lib/` and to `app_server/webapps/ROOT/WEB-INF/lib/`. |

---

### `deploy`

Controls the deploy pipeline behavior.

```yaml
deploy:
  artifact_dirs:
    - lib
    - bin
    - sbin
    - etc
  copy_to_app_server:
    - source: WebContent
      target: "{app_server.home}/webapps/ROOT"
  startup_check:
    max_attempts: 30
    interval_ms: 2000
```

#### `deploy.artifact_dirs`

List of directories to copy from `paths.source` to `paths.deploy_target` during a full deploy. Each entry is a directory name relative to the source root.

Typical directories:
- `lib` — compiled JARs and dependencies
- `bin` — binary scripts
- `sbin` — admin scripts (nfstart, nfstop, nfjobs, etc.)
- `etc` — configuration files (Akka configs, Hibernate properties, agent XMLs)

#### `deploy.copy_to_app_server`

Additional file copies to the app server after artifact deployment. Each entry has:

| Field | Description |
|-------|-------------|
| `source` | Source directory (relative to `paths.source` or `build.output.release_dir`) |
| `target` | Destination path (supports template variables) |

#### `deploy.startup_check`

After starting the app server, the deploy pipeline polls to verify it's up.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_attempts` | integer | `30` | Maximum number of poll attempts before giving up. |
| `interval_ms` | integer | `2000` | Milliseconds between poll attempts. |

With defaults: waits up to **60 seconds** (30 attempts x 2s) for the app server to respond with HTTP 200.

---

### `agents`

Configuration for backend agent (process) management. Agents are JVM processes managed by shell scripts (`nfstart`, `nfstop`, `nfjobs`, etc.).

```yaml
agents:
  config_file: /home/petar/AppServer/petarServer.yml
  config_format: geowealth_yaml
  env_key: DevPetar
  server_key: DevPetar
  log_dir: "{paths.deploy_target}/logs"
  log_file: stdout.log
  commands:
    list: nfjobs
    check: nfcheckall
    start: "nfstart {name}"
    stop: "nfstop {name}"
    restart_all: "{paths.deploy_target}/sbin/restart_agents.sh"
  env_vars:
    GEO_TEMPLATE_NAME: "{agents.config_file}"
    GEO_ENV: "{agents.env_key}"
    GEO_SERVER: "{agents.server_key}"
```

| Field | Type | Description |
|-------|------|-------------|
| `config_file` | path | Path to the agent definition YAML file (e.g., `petarServer.yml`). This file defines all available agents, their memory allocation, and autostart settings. The monitor reads this to build the full agent list. |
| `config_format` | string | Parser format for the config file. Currently only `geowealth_yaml` is supported. |
| `env_key` | string | Environment key used to locate agents in the config file. Maps to `environments.{env_key}` in the YAML structure. **Must match exactly** — if the YAML has `DevPetar`, this must be `DevPetar`, not `Dev`. |
| `server_key` | string | Server key within the environment. Maps to `environments.{env_key}.servers.{server_key}`. Together with `env_key`, determines which agent list is loaded. |
| `log_dir` | path | Base directory for agent logs. Each agent's log is at `{log_dir}/{agent_name}/{log_file}`. |
| `log_file` | string | Log filename within each agent's log directory. |

> **Common mistake:** Setting `env_key` or `server_key` to wrong values. If they don't match the YAML structure, no configured agents will be found — only running agents detected by `nfjobs` will appear.

#### `agents.commands`

Shell commands for agent management. Executed from `{paths.deploy_target}/sbin/`.

| Field | Description |
|-------|-------------|
| `list` | Lists all running agents with PIDs and start times. Output is parsed for `Name: X PID: Y Start Time: Z` lines. |
| `check` | Checks which agents are accessible. Output is parsed for `Agentsystem X exists and is accessible` lines. |
| `start` | Starts a single agent. `{name}` is replaced with the agent name. |
| `stop` | Stops a single agent. `{name}` is replaced with the agent name. |
| `restart_all` | Restarts all agents. Called by the "Restart All" button. |

#### `agents.env_vars`

Environment variables set before executing any agent command. These are prepended to the command as `KEY="value" command args`.

Typical variables needed by the GeoWealth agent framework:
- `GEO_TEMPLATE_NAME` — path to the server config YAML
- `GEO_ENV` — environment name
- `GEO_SERVER` — server name

---

### `git`

Git authentication configuration for fetch/pull operations during deploy.

```yaml
git:
  auth:
    type: gitlab
    token_env: GITLAB_TOKEN
    user_env: GITLAB_USER
    default_user: oauth2
  askpass_script: /tmp/gw-git-askpass.sh
```

#### `git.auth`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | — | Git provider: `gitlab`, `github`, or `none`. Determines how authentication is configured. |
| `token_env` | string | — | Name of the environment variable containing the auth token. The monitor reads this from the process environment. |
| `user_env` | string | — | Name of the environment variable containing the git username. |
| `default_user` | string | `oauth2` | Username to use if `user_env` is not set. For GitLab token auth, this is typically `oauth2`. |

#### `git.askpass_script`

| Field | Type | Description |
|-------|------|-------------|
| `askpass_script` | path | File path where the monitor writes a temporary `GIT_ASKPASS` helper script. This script echoes the auth token when git asks for a password. The file is created at startup and used for all git operations. |

---

### `thresholds`

Visual thresholds for the Chrome extension UI. Control when status indicators change color.

```yaml
thresholds:
  ram_warning: 75
  ram_danger: 90
  ram_critical: 95
  bar_warning: 75
  bar_danger: 90
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ram_warning` | integer | `75` | RAM usage percentage for **warning** (yellow) indicator. |
| `ram_danger` | integer | `90` | RAM usage percentage for **danger** (orange) indicator. |
| `ram_critical` | integer | `95` | RAM usage percentage for **critical** (red) indicator. Above this threshold, the background health check considers the system unhealthy and sends a notification. |
| `bar_warning` | integer | `75` | Progress bar warning threshold (yellow) — used for memory bars in agent list. |
| `bar_danger` | integer | `90` | Progress bar danger threshold (red) — used for memory bars in agent list. |

These thresholds are sent to the Chrome extension via `GET /config/client` and applied client-side.

---

### `exec_whitelist`

Security whitelist for the `/exec` endpoint. This endpoint allows the Chrome extension to execute shell commands on the server (e.g., clicking on a command in deploy logs).

```yaml
exec_whitelist:
  - "tail "
  - "head "
  - "cat "
  - "df "
  - "du "
  - "ls "
  - "wc "
  - "git -C"
  - "git stash"
  - "git status"
  - "git log"
  - "git diff"
  - "ps "
  - "free "
  - "uptime"
```

Each entry is a **prefix**. A command is allowed only if it starts with one of these prefixes. This prevents arbitrary command execution through the API.

**Security notes:**
- Always include a trailing space for single-word commands (e.g., `"tail "` not `"tail"`) to prevent matching unintended commands (e.g., `tailspin`).
- Git commands are restricted to read-only operations (`status`, `log`, `diff`) and `stash`.
- If `exec_whitelist` is empty or omitted, **no commands** can be executed via `/exec`.
- Commands are executed with the same permissions as the Node.js server process.

---

## Full Example

```yaml
server:
  port: 7103
  name: "Petar Dev Server"

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
    expected_status: 200
    timeout_ms: 5000
  logs:
    main: logs/catalina.out
    access: "logs/localhost_access_log.{date}.txt"
  webapps_dir: webapps

build:
  type: gradle
  working_dir: "{paths.source}"
  commands:
    incremental: "./gradlew devClasses devLib jar"
    jar_only: "./gradlew jar"
    full_clean: "./gradlew clean"
    full_build: "./gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false"
  output:
    release_dir: build/release
    dev_dir: devBuild
    jar_dir: build/libs
    jar_name: geowealth.jar

deploy:
  artifact_dirs:
    - lib
    - bin
    - sbin
    - etc
  copy_to_app_server:
    - source: WebContent
      target: "{app_server.home}/webapps/ROOT"
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
    list: nfjobs
    check: nfcheckall
    start: "nfstart {name}"
    stop: "nfstop {name}"
    restart_all: "{paths.deploy_target}/sbin/restart_agents.sh"
  env_vars:
    GEO_TEMPLATE_NAME: "{agents.config_file}"
    GEO_ENV: "{agents.env_key}"
    GEO_SERVER: "{agents.server_key}"

git:
  auth:
    type: gitlab
    token_env: GITLAB_TOKEN
    user_env: GITLAB_USER
    default_user: oauth2
  askpass_script: /tmp/gw-git-askpass.sh

thresholds:
  ram_warning: 75
  ram_danger: 90
  ram_critical: 95
  bar_warning: 75
  bar_danger: 90

exec_whitelist:
  - "tail "
  - "head "
  - "cat "
  - "df "
  - "du "
  - "ls "
  - "wc "
  - "git -C"
  - "git stash"
  - "git status"
  - "git log"
  - "git diff"
  - "ps "
  - "free "
  - "uptime"
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Error: Config file not found` | `config.yml` doesn't exist | Copy `config.example.yml` to `config.yml` |
| `Missing required config fields` | Required fields not set | Check the error message for which fields are missing |
| Build fails: `JAVA_HOME is set to an invalid directory` | `paths.java_home` points to a non-existent path | Set to actual JDK path (e.g., `amazon-corretto-17.x.x/`) |
| No agents shown (only running ones appear) | `env_key` or `server_key` don't match YAML structure | Check `petarServer.yml` for exact key names under `environments:` and `servers:` |
| Badge stays yellow even though app works | `health_check.path` returns wrong status code | Verify the endpoint exists: `curl -o /dev/null -w "%{http_code}" http://localhost:8080/your/path` |
| Deploy hangs at "Waiting for app server" | `startup_check` timeout too short | Increase `max_attempts` or `interval_ms` |
| `/exec` commands rejected | Command not in `exec_whitelist` | Add the command prefix to the whitelist |
| Git fetch/pull fails during deploy | `GITLAB_TOKEN` env var not set or expired | Set the token: `export GITLAB_TOKEN=glpat-xxx` |
