# GeoWealth Server Monitor - Chrome Extension

A Chrome extension for real-time monitoring and management of a GeoWealth development server environment. Provides system health visibility, Tomcat and agent control, and full deployment capabilities — all from a browser popup.

## Features

### System Monitoring
- **System stats:** uptime, load average, RAM/swap usage, disk usage with visual progress bars
- **Free RAM:** drops Linux caches and triggers GC on all running Java processes
- **Restart server:** restarts the status API server via pm2

### Tomcat Monitoring & Control
- Running status with platform readiness check (detects 302 redirect to login page)
- HTTP response time, process uptime, CPU usage, thread count
- JVM configuration display (Xmx, Xms, GC type, Reactor pool size, Akka config, dev mode flag)
- Memory usage (RSS vs Xmx limit) with color-coded progress bars
- Open file descriptors tracking
- Deployed web applications list
- Daily request count
- **Log viewer** with configurable line count (100 / 200 / 500 / 1000 lines)
- **Stop / Restart** Tomcat directly from the popup

### Agent Management
- Monitors agents defined in the server's YAML configuration
- Per-agent metrics: memory (RSS), CPU, threads, open FDs, uptime
- Running / stopped / unreachable status indicators
- **Start / Stop / Restart** individual agents
- **Edit memory** configuration per agent
- **Toggle autostart** setting
- Tracks manually stopped agents to avoid false-positive notifications
- Aggregate health summary across all agents
- Per-agent log viewer
- **Restart All Agents** button

### Deployment
- **Standard Deploy** — full pipeline with 8-step progress tracking:
  1. Stash local changes (handles assume-unchanged / skip-worktree flags)
  2. Fetch latest from remote
  3. Checkout target branch
  4. Apply stashed changes
  5. Stop Tomcat
  6. Gradle build (incremental first, falls back to full on failure)
  7. Copy artifacts to BE_HOME
  8. Start Tomcat
- **Quick Deploy** — build JAR and copy without git pull, with optional Tomcat restart and optional agent restart
- **Pull** — fetch and pull latest changes from origin
- **Stash** — stash all uncommitted changes including untracked files
- **Branch selector** — typeahead search through available branches with commit dates
- **Dirty state detection** — warns when uncommitted changes may interfere with deploy
- **Real-time deploy logs** — streamed via SSE with clickable commands for inline execution
- **Error recovery** — auto-restores stash on original branch if deploy fails

### General
- **Background monitoring** with 1-minute health check intervals
- **Chrome notifications** on server issues and recovery events
- **Light / dark theme** toggle with system preference detection
- **Configurable server URL** for remote monitoring
- **Status badge** on the extension icon — green for healthy, red number for issue count, `!` for unreachable

## Architecture

```
gw-monitor-extension/
├── chrome-extension/              # Chrome extension (client)
│   ├── manifest.json             # Manifest v3 config
│   ├── popup.html                # Popup UI
│   ├── popup.js                  # Popup logic and rendering
│   ├── popup.css                 # Styles with light/dark theme support
│   ├── background.js             # Service worker for background monitoring
│   └── icons/                    # Extension icons (green/red/gray, multiple sizes)
├── server.js                     # Status API server (Node.js + Express)
├── package.json                  # Dependencies
└── package-lock.json
```

### Client (Chrome Extension)

Built with vanilla HTML/CSS/JavaScript — no frameworks. Uses Chrome Extension Manifest v3 APIs:
- `chrome.storage.local` for persisting status, settings, and theme
- `chrome.alarms` for periodic background health checks
- `chrome.notifications` for alerting on server state changes
- `chrome.action` for dynamic badge/icon updates
- `chrome.runtime` messaging between popup and service worker

### Server (Status API)

A Node.js Express server that runs on the monitored machine (default port `7103`). Collects system data by executing Linux commands (`/proc` filesystem, `systemctl`, `ps`, `df`, etc.) and exposes it via a REST API.

**Dependencies:** `express`, `js-yaml`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/status` | Full system status (system, Tomcat, agents) |
| `GET` | `/ping` | Simple health check |
| `GET` | `/deploy/status` | Current deploy state |
| `POST` | `/stop/tomcat` | Stop Tomcat |
| `POST` | `/restart/tomcat` | Restart Tomcat |
| `POST` | `/stop/agent/:name` | Stop a specific agent |
| `POST` | `/restart/agent/:name` | Restart a specific agent |
| `POST` | `/restart/agents` | Restart all agents |
| `PUT` | `/config/agent/:name/autostart` | Toggle agent autostart |
| `PUT` | `/config/agent/:name/memory` | Update agent memory config |
| `POST` | `/system/free-ram` | Drop caches + trigger Java GC |
| `POST` | `/restart/server` | Restart the status server (pm2) |
| `POST` | `/exec` | Execute a command (for inline log actions) |
| `GET` | `/git/branches` | List branches with commit dates |
| `GET` | `/git/status` | Check for uncommitted changes |
| `POST` | `/git/stash` | Stash changes |
| `POST` | `/pull` | Fetch + pull from origin |
| `POST` | `/deploy` | Run full deploy pipeline |
| `POST` | `/quick-deploy` | JAR-only deploy (no git) |
| `GET` | `/deploy/stream` | SSE stream for real-time deploy logs |
| `GET` | `/logs/tomcat` | Fetch Tomcat logs |
| `GET` | `/logs/agent/:name` | Fetch agent logs |

## Setup

### Server

1. Install Node.js on the target machine
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the status server:
   ```bash
   node server.js
   ```
   Or with a custom port:
   ```bash
   node server.js --port 8080
   ```
4. (Optional) Use pm2 for process management:
   ```bash
   pm2 start server.js --name gw-monitor
   ```

### Chrome Extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `chrome-extension/` directory
4. Click the extension icon and configure the server URL in **Settings**

## Environment

The server expects a GeoWealth development environment with:
- Linux OS (relies on `/proc`, `systemctl`, `bash`)
- Apache Tomcat (configured at a known path)
- Gradle build system for the GeoWealth project
- Git repository for the source code
- A GeoWealth YAML configuration file defining agents and server settings

## License

Private / Internal use.
