# Copilot Telegram Bridge v3

Control GitHub Copilot CLI from your phone via Telegram — while you're away from your desk. This bridge runs on your Windows PC and connects a private Telegram bot to the Copilot CLI through the **@github/copilot-sdk**, giving you full code generation, tool execution, session management, screenshots, and audit logging from anywhere.

```
┌─────────┐       ┌──────────┐       ┌─────────────────────────────────┐
│  iPhone  │◄────►│ Telegram │◄────►│  Node.js Bridge (your Windows PC)│
│  (you)   │       │   API    │       │                                 │
└─────────┘       └──────────┘       │  ┌───────────┐  ┌────────────┐  │
                                      │  │ Copilot   │  │ Playwright │  │
                                      │  │ SDK/CLI   │  │ (headless) │  │
                                      │  └───────────┘  └────────────┘  │
                                      └─────────────────────────────────┘
```

---

## Table of Contents

- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Commands Reference](#commands-reference)
- [Permission Modes](#permission-modes)
- [Session Management](#session-management)
- [Smart Screenshots](#smart-screenshots)
- [Retry & Error Recovery](#retry--error-recovery)
- [Activity Audit Log](#activity-audit-log)
- [Inline Keyboard](#inline-keyboard)
- [Health Monitoring](#health-monitoring)
- [Progress Indicators](#progress-indicators)
- [Photo & Image Analysis](#photo--image-analysis)
- [Usage Scenarios](#usage-scenarios)
- [Architecture](#architecture)
- [Security](#security)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## How It Works

1. The bridge runs a private Telegram bot on your Windows PC
2. You send messages from your phone; only your Telegram user ID is accepted
3. Messages are routed to Copilot via the `@github/copilot-sdk` (JSON-RPC over stdio)
4. Copilot processes the prompt with streaming — tool activity shows live in Telegram
5. Responses come back formatted in CLI style (🟣 purple header, code blocks, markdown)
6. Sessions persist across messages and bridge restarts (atomic state saves)
7. If the bridge crashes, the resilient poll loop auto-recovers with exponential backoff

---

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts, and copy the **bot token**
3. Message [@userinfobot](https://t.me/userinfobot) to get your **user ID**
4. Start a chat with your new bot and send any message
5. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find your **chat ID**

### 2. Authenticate Copilot CLI

Run `copilot` once manually in a terminal and complete the GitHub OAuth login:

```powershell
copilot
# Complete the login flow in your browser, then exit with Ctrl+C
```

### 3. Configure the Bridge

```powershell
cd copilot-telegram-bridge
copy .env.example .env
```

Edit `.env` with your values (see [Configuration](#configuration) for all options):

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_USER_ID=your_numeric_id
TELEGRAM_CHAT_ID=your_numeric_chat_id
COPILOT_MODEL=claude-sonnet-4
COPILOT_TIMEOUT_SECONDS=600
```

### 4. Install & Run

```powershell
npm install
npx playwright install chromium   # for /screenshot feature
npm start
```

You'll see a startup message on your phone:
> ✅ Copilot Mobile v3 online! Session: a1b2c3d4… Model: claude-sonnet-4. Send /help for commands.

---

## Configuration

All settings are in the `.env` file. Copy `.env.example` to `.env` and fill in your values.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_USER_ID` | ✅ | — | Your Telegram user ID (only this user can interact) |
| `TELEGRAM_CHAT_ID` | ✅ | — | Chat ID where the bot sends messages |
| `COPILOT_MODEL` | ❌ | `claude-sonnet-4` | Default AI model (changeable at runtime via `/model`) |
| `COPILOT_TIMEOUT_SECONDS` | ❌ | `600` | Max seconds per request before timeout (10 min default) |
| `COPILOT_CLI_PATH` | ❌ | Auto-detect | Path to `copilot.exe` — auto-detects WinGet install location |
| `LOG_LEVEL` | ❌ | `info` | Structured log level: `debug`, `info`, `warn`, `error` |

**Impact of settings:**

- **`COPILOT_MODEL`**: Determines the AI model for all conversations. Some models are faster but less capable; others are premium. Use `/model` at runtime to switch without restarting. Switching model creates a new session (fresh conversation context).
- **`COPILOT_TIMEOUT_SECONDS`**: How long to wait for Copilot to respond. Complex agent tasks (multi-file refactors, builds) often need the full 600s. If a timeout occurs, partial results are returned with a ⏱️ indicator — work may still be running in the background.
- **`LOG_LEVEL`**: Set to `debug` for detailed JSON-formatted logs useful when troubleshooting SDK connection issues. Set to `error` in production for minimal noise.

---

## Commands Reference

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/agent` | Switch to 🤖 Agent mode (full autonomy) |
| `/ask` | Switch to 💬 Ask mode (read-only) |
| `/plan` | Switch to 📋 Plan mode (suggest-only) |
| `/status` | Show bridge state + inline mode-switch buttons |
| `/sessions` | List active Copilot CLI terminal sessions |
| `/switch <n>` | Connect to session number N |
| `/new` | Start a fresh conversation (new session) |
| `/model` | Show current AI model |
| `/model <name>` | Switch model (creates new session) |
| `/models` | List all available models |
| `/screenshot` | Auto-detect running web app and capture |
| `/screenshot <url>` | Capture a specific URL |
| `/screenshot desktop` | Capture the full desktop |
| `/retry` | Resend the last message |
| `/cancel` | Cancel current request and clear the queue |
| `/history` | Show recent activity log (last 10 by default) |
| `/history <n>` | Show last N activity entries (max 50) |
| `/last` | Show details of the most recent request |

---

## Permission Modes

Modes control what Copilot is allowed to do. This is the **most important concept** for safe remote operation.

### 🤖 Agent Mode (`/agent`)

**Full autonomy.** Copilot can read files, write files, execute shell commands, browse URLs, and run any tool — like having someone at the keyboard.

**What it can do:**
- Execute `git commit`, `npm install`, `dotnet build`, and any shell command
- Create, edit, and delete files
- Read the entire codebase for context
- Run tools and MCP integrations

**When to use:** When you want Copilot to actually do work — build features, fix bugs, run tests, deploy code.

**⚠️ Risk:** Copilot will execute commands without asking. Only use when you trust the task scope.

### 💬 Ask Mode (`/ask`)

**Read-only.** Copilot can read files and browse URLs for context but cannot execute commands or write files.

**What it can do:**
- Read source code files
- Browse URLs for documentation
- Answer questions about the codebase

**What it can't do:**
- Execute shell commands
- Write, create, or delete files
- Run any side-effecting tools

**When to use:** When you want to ask questions about your code, get explanations, or review architecture — without risk of changes.

### 📋 Plan Mode (`/plan`)

**Suggest-only.** Copilot cannot execute any tools at all. It can only describe what it would do.

**What it can do:**
- Describe proposed changes in detail
- Outline step-by-step plans
- Suggest commands and file edits

**What it can't do:**
- Read files (works from conversation context only)
- Execute any tools whatsoever

**When to use:** When you want a plan before committing to action. Review the plan, then switch to `/agent` to execute it.

### Comparing Modes

| Capability | Agent | Ask | Plan |
|-----------|:-----:|:---:|:----:|
| Shell commands | ✅ | ❌ | ❌ |
| Write/create files | ✅ | ❌ | ❌ |
| Read files | ✅ | ✅ | ❌ |
| Browse URLs | ✅ | ✅ | ❌ |
| MCP tools | ✅ | ❌ | ❌ |
| Describe actions | ✅ | ✅ | ✅ |

---

## Session Management

### What are sessions?

Each Copilot CLI terminal window on your PC has its own session with conversation history and working directory context. The bridge can connect to any of them.

### Commands

- **`/sessions`** — Lists all active Copilot CLI sessions on your machine, showing the working directory and model for each.
- **`/switch <n>`** — Switches to session number N from the list. Your subsequent messages go to that session's context.
- **`/new`** — Creates a completely fresh session. Conversation memory resets.

### Session Persistence

The bridge saves its current session ID and mode to `session-state.json` using atomic writes (write to `.tmp` then rename). If the bridge restarts, it reconnects to the same session automatically.

---

## Smart Screenshots

Capture what's running on your PC and see it on your phone. Three modes:

### Auto-Detect (`/screenshot`)

1. Scans TCP ports 3000–9999 for listening processes
2. Matches running dev servers (node, python, dotnet) against the project directory
3. Opens the URL in headless Chromium (Playwright) at 1280×720
4. Sends the screenshot to Telegram with a caption showing the captured URL

**Impact:** See exactly what your app looks like while you're away. Great for verifying UI changes after asking Copilot to modify a frontend.

### Specific URL (`/screenshot http://localhost:3000`)

Captures any URL you specify. Useful when auto-detection doesn't find the right port, or for external URLs.

### Desktop (`/screenshot desktop`)

Takes a raw screenshot of the primary display using .NET APIs. Shows the full desktop including any open windows, terminal output, or IDE state.

### How it works internally

- **Port detection**: PowerShell `Get-NetTCPConnection` → filter ports 3000–9999 → `Get-CimInstance Win32_Process` to match against project directory
- **Web capture**: Playwright headless Chromium, 1280×720 viewport, waits for page `load` event + 2 second settle time
- **Fallback chain**: Auto-detect → Playwright → Desktop fallback → "no server found" help message
- **Temp cleanup**: Screenshot files are cleaned up immediately after sending, with a safety sweeper every 30 minutes for any leaked files

---

## Retry & Error Recovery

### `/retry` Command

Resends your last message to Copilot. Useful when:
- A response was cut off by timeout
- You got an error and want to try again
- The model misunderstood and you want a fresh attempt

**Safety guard in Agent mode:** If your last request timed out while in Agent mode, `/retry` warns you that work may still be running in the background (Copilot may still be executing commands). You must send `/retry confirm` to force the retry. This prevents accidentally running the same commands twice.

### Resilient Poll Loop

The Telegram polling loop automatically recovers from crashes:
- **Exponential backoff**: 2s → 4s → 8s → … up to 30s between retries
- **409 exclusion**: Competing-instance conflicts (409 errors) are retried immediately — they're not counted as crashes
- **Health reset**: If the loop runs healthy for 5+ minutes, the restart counter resets
- **Maximum 10 restarts**: After 10 crashes without recovery, the bridge exits for a process manager to restart it
- **Telegram notifications**: You get notified on your phone when the poll loop crashes and when it recovers

### Graceful Timeouts

When a request exceeds `COPILOT_TIMEOUT_SECONDS`:
- Any partial response accumulated via streaming is returned with a ⏱️ indicator
- If no content was captured, a summary of tools that were running is shown
- The message suggests sending a follow-up to check status
- Work may still be running in the background (Copilot doesn't abort)

---

## Activity Audit Log

Every request to Copilot is logged to `temp/audit.jsonl` for review and debugging.

### `/history` and `/history <n>`

Shows a summary of recent activity: timestamp, mode, duration, tools used, and a preview of the prompt.

### `/last`

Shows detailed info about the most recent request: time, mode, duration, timeout status, prompt preview, response preview, and tools used.

### What gets logged

| Field | Description |
|-------|-------------|
| `ts` | ISO timestamp |
| `type` | `message`, `message-retry`, or `error` |
| `mode` | `agent`, `ask`, or `plan` |
| `promptLength` | Character count of the original prompt |
| `responseLength` | Character count of the response |
| `promptPreview` | First 100 chars (redacted) |
| `responsePreview` | First 100 chars (redacted) |
| `tools` | Array of tool names used |
| `durationMs` | Request duration in milliseconds |
| `timedOut` | Whether the request hit the timeout |

### Security & Privacy

- **Redaction**: Sensitive patterns are automatically scrubbed before writing: GitHub PATs (`ghp_...`), API keys (`sk-...`), tokens, passwords, and base64 blobs
- **No full content**: Only the first 100 characters of prompts and responses are stored (as previews), not the full text
- **Auto-rotation**: Log file rotates at 5 MB (old file backed up as `.old`)
- **Local only**: The audit file is in your `temp/` directory, never transmitted anywhere

---

## Inline Keyboard

The `/status` command shows the bridge state and includes **inline buttons** for quick mode switching:

```
🟢 Bridge Status

State: idle
Mode: 🤖 Agent
Session: a1b2c3d4…
Model: claude-sonnet-4
...

[🤖 Agent] [💬 Ask] [📋 Plan]    ← tap to switch
```

Tapping a button instantly switches the permission mode and updates the status message in place. No need to type `/agent`, `/ask`, or `/plan` — just tap.

---

## Health Monitoring

The bridge runs a background health check every 60 seconds:

- **Busy-aware**: Skips the check when Copilot is actively processing a request (won't interrupt work)
- **Lightweight ping**: Calls `listModels()` as a health check on the SDK connection
- **Auto-reconnect**: If the health check fails, automatically disconnects and reconnects the SDK client
- **Telegram alerts**: You get a ⚠️ notification when the SDK connection drops and a ✅ when it recovers

**Impact:** If the SDK process crashes or the connection drops while you're away, the bridge heals itself without intervention. You'll know it happened because of the Telegram alert.

---

## Progress Indicators

When Copilot is working on a request:

1. **Immediate** — "⏳ Working…" status message appears
2. **5 seconds** — First proof-of-life update: "🔄 Processing… (5s)"
3. **Every 8 seconds** — Progress updates with elapsed time and recent tool names
4. **Typing indicator** — Telegram "typing…" bubble refreshes every 4 seconds

**Impact:** You always know the bridge is alive and working. The fast 5-second initial update is critical when you're on your phone — confirms your message was received before you put your phone down.

---

## Photo & Image Analysis

Send any photo to the bot and Copilot will analyze it:

1. The photo is downloaded to a temp directory
2. Sent to Copilot as an image attachment with your caption (or "What is in this image?" by default)
3. Copilot responds with its analysis
4. The temp file is cleaned up in a `finally` block (guaranteed cleanup even on error)

**Use cases:**
- Screenshot an error from another app and ask "what's wrong here?"
- Photo of a whiteboard diagram and ask "turn this into code"
- Screenshot of a UI and ask "recreate this in React"

---

## Usage Scenarios

### Scenario 1: "Fix a bug while I'm at lunch"

You're at a restaurant and your colleague Slacks you about a broken build.

```
You:     /agent
Bot:     🤖 Agent Mode — Full autonomy enabled.

You:     The unit tests in src/auth are failing. Fix them.
Bot:     🔄 Working… (8s elapsed)
         Tools: shell, read, write
Bot:     🟣 Copilot
         I found 2 failing tests in src/auth/login.test.ts...
         [detailed fix explanation with code changes]

You:     /screenshot http://localhost:3000
Bot:     📸 [photo of the running app with caption]

You:     looks good, commit and push
Bot:     🟣 Copilot
         Committed and pushed to main. ✅
```

**Key features used:** Agent mode, tool execution, screenshot verification, natural language commits.

### Scenario 2: "Review code safely from the train"

You want to understand a PR but don't want to accidentally run anything.

```
You:     /ask
Bot:     💬 Ask Mode — Read-only mode.

You:     What does the new middleware in src/auth/rbac.ts do?
Bot:     🟣 Copilot
         The RBAC middleware checks user roles against route permissions...

You:     Are there any security issues with this approach?
Bot:     🟣 Copilot
         I see two potential concerns:
         1. The token is not validated for expiry...
         2. The role check doesn't handle nested groups...
```

**Key features used:** Ask mode (safe read-only), file reading for context, multi-turn conversation.

### Scenario 3: "Plan before committing to changes"

You want Copilot to think through an approach before you let it execute.

```
You:     /plan
Bot:     📋 Plan Mode — Suggest-only mode.

You:     How would you add WebSocket support to the API?
Bot:     🟣 Copilot
         Here's my proposed approach:
         1. Install ws package...
         2. Create src/websocket/server.ts...
         3. Modify src/index.ts to...
         [detailed plan with no execution]

You:     /agent
Bot:     🤖 Agent Mode — Full autonomy enabled.

You:     Execute the WebSocket plan you just described
Bot:     🔄 Working… (15s elapsed)
         Tools: shell, write, read
```

**Key features used:** Plan → Agent workflow, mode switching, plan-then-execute pattern.

### Scenario 4: "Switch between projects"

You have multiple terminal windows open on your PC with different projects.

```
You:     /sessions
Bot:     📂 Active Sessions:
         1. C:\Git\WebApp — claude-sonnet-4 (2 min ago)
         2. C:\Git\MobileAgent — claude-sonnet-4 (15 min ago)
         3. C:\Git\API — claude-sonnet-4 (1 hr ago)

You:     /switch 3
Bot:     ✅ Switched to session for C:\Git\API

You:     What was I working on in this project?
Bot:     🟣 Copilot
         Based on our conversation, you were adding rate limiting...
```

**Key features used:** Session discovery (scans running processes), session switching, conversation continuity.

### Scenario 5: "Something went wrong, retry it"

A long operation timed out and you want to try again.

```
You:     Run the full test suite and fix any failures
Bot:     ⏱️ The request timed out after 600 seconds...
         Tools executed: shell, read, write
         The work may still be running in the background.

You:     /retry
Bot:     ⚠️ Last request timed out in Agent mode — work may still be running.
         Send /retry confirm to force retry, or check status first.

You:     what's the status of the test run?
Bot:     🟣 Copilot
         The tests finished — 247 passed, 3 still failing...

You:     fix the remaining 3 failures
Bot:     🔄 Working… (12s elapsed)
```

**Key features used:** Graceful timeout with partial results, `/retry` safety guard, follow-up status check.

### Scenario 6: "Check what happened while I was away"

You come back from being AFK and want to see what the bridge has been doing.

```
You:     /history 5
Bot:     📜 Recent Activity (5)
         1. 10:23 AM | agent | 45s [shell, read, write]
            "Fix the auth middleware..."
         2. 10:25 AM | agent | 12s [read]
            "Show me the test results"
         3. 10:30 AM | ask | 3s
            "What model am I using?"
         4. 10:35 AM | agent | 600s ⏱️ [shell, write]
            "Run the full integration test suite..."
         5. 10:45 AM | agent | 8s [shell]
            "git push origin main"

You:     /last
Bot:     📋 Last Request
         Time: 10:45 AM
         Mode: agent
         Duration: 8s
         Prompt: git push origin main
         Response: Pushed 3 commits to origin/main...
         Tools: shell
```

**Key features used:** Audit log, `/history`, `/last`, redacted previews.

### Scenario 7: "Quick mode switch from status"

You're in Ask mode but need to make a quick fix.

```
You:     /status
Bot:     🟢 Bridge Status
         State: idle
         Mode: 💬 Ask
         Session: a1b2c3d4…
         [🤖 Agent] [💬 Ask] [📋 Plan]    ← buttons

         *taps 🤖 Agent button*

Bot:     (status message updates in-place)
         Mode: 🤖 Agent
         ✓ Switched to 🤖 Agent
```

**Key features used:** Inline keyboard, in-place message updates, one-tap mode switching.

### Scenario 8: "Switch models for a different task"

You want to use a different AI model for a complex architecture discussion.

```
You:     /models
Bot:     • claude-sonnet-4 ← current
         • claude-opus-4
         • gpt-4.1
         • ...

You:     /model claude-opus-4
Bot:     🔵 Model switched to: claude-opus-4
         New session created.

You:     Design a microservices architecture for...
```

**Key features used:** Model listing, model switching (auto-creates new session), idle guard (blocks switch during busy).

---

## Architecture

```
┌────────────┐     ┌──────────────┐     ┌──────────────────────────────────────┐
│   iPhone    │────▶│  Telegram    │────▶│   Node.js Bridge (your Windows PC)   │
│  (Telegram) │◀────│    API       │◀────│                                      │
└────────────┘     └──────────────┘     │  ┌────────┐ ┌──────┐ ┌───────────┐  │
                                         │  │ bridge │ │ modes│ │ screenshot│  │
                                         │  │  .js   │ │  .js │ │    .js    │  │
                                         │  └───┬────┘ └──────┘ └───────────┘  │
                                         │      │                               │
                                         │  ┌───▼──────────────────────────┐   │
                                         │  │ @github/copilot-sdk          │   │
                                         │  │ (JSON-RPC over stdio)        │   │
                                         │  └───────────────┬──────────────┘   │
                                         │                  │                   │
                                         │  ┌───────────────▼──────────────┐   │
                                         │  │   copilot.exe (CLI process)  │   │
                                         │  └──────────────────────────────┘   │
                                         └──────────────────────────────────────┘
```

### Source Files

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point — resilient poll loop, shutdown handlers, temp sweeper, health events |
| `src/bridge.js` | Copilot SDK integration — session management, message queue, permission handlers, screenshots |
| `src/telegram.js` | All Telegram commands, message routing, inline keyboard, progress indicators |
| `src/modes.js` | Mode strategy object — single source of truth for permissions, tool exclusions, system prompts |
| `src/screenshot.js` | Playwright web capture + TCP port detection for auto-detecting dev servers |
| `src/sessions.js` | Discovers active CLI sessions via WMI process scan + SQLite session store |
| `src/formatter.js` | Markdown → Telegram HTML conversion, message chunking (≤4096 chars), CLI-style formatting |
| `src/config.js` | Environment config with auto-detection of copilot.exe (WinGet install path) |
| `src/logger.js` | Structured JSON logging with levels, request IDs, and component scoping |
| `src/audit-log.js` | Append-only JSONL audit log with sensitive data redaction and auto-rotation |
| `src/platform/windows.js` | Centralized PowerShell/OS helpers for Windows (screenshots, process queries, TCP scans) |
| `src/platform/index.js` | Platform abstraction entry point (currently Windows-only) |

### Safety & Reliability Features

| Feature | How It Works |
|---------|-------------|
| **Atomic state writes** | State saved to `.tmp` file then renamed — no corruption on crash |
| **Hard shutdown timeouts** | `destroy()` has a 10s deadline; uncaught exceptions have 5s — never hangs |
| **Poll loop recovery** | Auto-restarts up to 10 times with exponential backoff (409 conflicts excluded) |
| **Health monitoring** | SDK `listModels()` ping every 60s (skipped when busy); auto-reconnect on failure |
| **Temp file sweeper** | Periodic cleanup every 30 minutes removes files older than 1 hour |
| **Try/finally cleanup** | All temp files (screenshots, photo downloads) cleaned up in `finally` blocks |
| **Audit log redaction** | PATs, API keys, tokens, and base64 blobs scrubbed before writing to disk |
| **Audit log rotation** | Auto-rotates at 5 MB with one backup file |
| **Retry safety guard** | `/retry` in Agent mode after timeout requires `/retry confirm` to prevent duplicate execution |

---

## Security

- **User filtering**: Only messages from your configured `TELEGRAM_USER_ID` are accepted — all others silently dropped
- **Local execution**: The bridge runs on your PC; no cloud relay or third-party servers
- **Credentials in `.env`**: Bot token and IDs are in `.env` (gitignored), never committed
- **Audit redaction**: Sensitive values (tokens, passwords, API keys) are automatically scrubbed from audit logs
- **No full-content logging**: Audit stores only 100-char previews, not complete prompts/responses
- **Recommended**: Set your bot to private via BotFather (`/setjoingroups` → Disable)
- **Permission modes**: Use `/ask` or `/plan` when you don't need tool execution — limits blast radius

---

## Testing

The project includes a test suite with **vitest**:

```powershell
npm test            # Run all tests once
npm run test:watch  # Run in watch mode during development
```

**Test coverage:**

| Test File | What It Tests |
|-----------|--------------|
| `test/formatter.test.js` | HTML escaping, markdown conversion, message chunking, code block splitting |
| `test/modes.test.js` | Permission logic for all 3 modes (approve/reject decisions) |
| `test/modes-strategy.test.js` | Mode strategy object — labels, excluded tools, system suffixes, validation |
| `test/config.test.js` | Environment config loading, required fields, defaults |
| `test/logger.test.js` | Structured logger creation, level methods, request ID tracking |
| `test/audit-log.test.js` | Audit writing, redaction of secrets, entry count, rotation, formatting |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **409 Conflict errors** | Another bot instance is polling the same token. Stop the other instance. The bridge auto-retries with backoff and won't count these as crashes. |
| **Permission denied on commands** | You're in Ask or Plan mode. Send `/agent` to switch to full autonomy. |
| **Timeout on long tasks** | Default is 10 min. Increase `COPILOT_TIMEOUT_SECONDS` in `.env`. Partial results are returned on timeout. |
| **CLI auth fails** | Run `copilot` manually in a terminal first to complete the OAuth login flow. |
| **Session not found** | Use `/sessions` to see active sessions. Use `/new` for a fresh one. |
| **SDK connection drops** | Health monitor auto-reconnects every 60s. You'll see a ⚠️ then ✅ notification. |
| **Model switch fails** | The bridge blocks model switches while busy. Wait for the current request to finish. |
| **Screenshot shows "no server"** | No dev server detected on ports 3000–9999. Try `/screenshot http://localhost:PORT` with the specific port, or `/screenshot desktop`. |
| **Bot doesn't respond** | Check bridge console for errors. Verify `.env` values. Ensure the Telegram bot is started (`npm start`). |
| **Stale temp files** | The sweeper cleans files older than 1 hour every 30 minutes. Or manually clear `temp/`. |

---

## License

MIT
