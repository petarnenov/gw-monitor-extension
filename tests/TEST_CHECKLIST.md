# Manual Test Checklist — Phase 0

Преди всяка фаза на миграцията, провери всички flows по-долу.
Маркирай с [x] преминалите тестове.

---

## Popup — Зареждане и статус

- [ ] Popup се отваря без грешки
- [ ] Status секция показва: RAM, Swap, Disk, Uptime, Load, CPU
- [ ] App Server секция показва: Running/Stopped, PID, Port, Uptime
- [ ] Agents секция показва списък от агенти с техния статус
- [ ] Refresh бутон обновява всички данни
- [ ] Грешка при недостъпен сървър показва подходящо съобщение

## Popup — Theme

- [ ] Light theme се прилага коректно
- [ ] Dark theme се прилага коректно
- [ ] Auto theme следва системната настройка
- [ ] Theme toggle запазва избора след затваряне на popup

## Popup — Settings

- [ ] Settings панел се отваря
- [ ] Промяна на Server URL
- [ ] Save записва URL в chrome.storage
- [ ] Reload след save използва новия URL

## System операции

- [ ] Free RAM бутон — изпраща POST /system/free-ram
- [ ] Clear Swap бутон — изпраща POST /system/clear-swap
- [ ] Restart Server бутон — изпраща POST /restart/server
- [ ] Confirmation dialog преди опасни операции

## App Server (Tomcat)

- [ ] Stop бутон — спира Tomcat (POST /stop/tomcat)
- [ ] Restart бутон — рестартира Tomcat (POST /restart/tomcat)
- [ ] Logs бутон — показва Tomcat логове (GET /logs/tomcat)
- [ ] Health check индикатор (зелен/червен)
- [ ] Thread count и JVM info се показват

## Agents

- [ ] Start agent — POST /restart/agent/:name
- [ ] Stop agent — POST /stop/agent/:name
- [ ] Restart All — POST /restart/agents
- [ ] Edit Memory — PUT /config/agent/:name/memory
- [ ] Toggle Autostart — PUT /config/agent/:name/autostart
- [ ] Agent Logs — GET /logs/agent/:name
- [ ] Change log lines count
- [ ] Refresh agent logs

## Deploy

- [ ] Branch search — GET /git/branches
- [ ] Branch select от dropdown
- [ ] Git status — GET /git/status
- [ ] Pull — POST /pull
- [ ] Stash — POST /git/stash
- [ ] Full deploy — POST /deploy с log streaming (GET /deploy/stream SSE)
- [ ] Quick deploy — POST /quick-deploy с опции (agents, restartTomcat)
- [ ] Deploy status — GET /deploy/status (in progress / idle)
- [ ] Deploy log streaming работи в реално време

## Background (Service Worker)

- [ ] Badge update — зелен при running, червен при stopped, сив при недостъпен
- [ ] Alarm fires на всяка минута
- [ ] Notification при промяна на състояние (running→stopped, stopped→running)
- [ ] Pending agents — жълта точка + "Starting..." + auto-resolve

## Pending Agents

- [ ] Pending agent се маркира с жълт индикатор
- [ ] "Starting..." текст се показва
- [ ] Auto-resolve след успешен старт
- [ ] TTL изтичане (5 минути) премахва pending статус

## Exec

- [ ] POST /exec с whitelisted команда (напр. uptime) — успех
- [ ] POST /exec с non-whitelisted команда — отказ

---

## Бележки

- Дата на тестване: _______________
- Тестващ: _______________
- Branch: _______________
- Server URL: _______________
- Забележки: _______________
