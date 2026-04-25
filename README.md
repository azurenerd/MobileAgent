# Copilot Telegram Bridge v3

Chat with GitHub Copilot CLI from your phone via Telegram. Runs on your Windows PC and bridges messages between a Telegram bot and the Copilot CLI using the **@github/copilot-sdk** — full tool execution, session switching, and permission modes.

```
iPhone (Telegram) ←→ Telegram API ←→ This bridge (your PC) ←→ Copilot SDK ←→ copilot.exe
```

## How It Works

1. The bridge runs a Telegram bot that listens for your messages
2. Messages are sent to Copilot via the `@github/copilot-sdk` (JSON-RPC)
3. Copilot processes the prompt with streaming — tool activity shows live in Telegram
4. Session persists across messages and bridge restarts
5. Switch between active terminal CLI sessions from your phone
6. Control permissions with `/agent`, `/ask`, `/plan` modes

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
# Complete the login, then exit with Ctrl+C
```

### 3. Configure the Bridge

```powershell
cd copilot-telegram-bridge
copy .env.example .env
```

Edit `.env`:

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
npm start
```

## Telegram Commands

### Permission Modes

| Command | Mode | Description |
|---------|------|-------------|
| `/agent` | 🤖 Agent | Full autonomy — executes commands, reads/writes files |
| `/ask` | 💬 Ask | Read-only — answers questions, can read files for context |
| `/plan` | 📋 Plan | Suggest-only — describes what it would do, no execution |

### Session Management

| Command | Description |
|---------|-------------|
| `/sessions` | List active Copilot CLI sessions from your terminal windows |
| `/switch <n>` | Switch to session N (connect to a terminal session) |
| `/new` | Start a fresh conversation (new session) |

### General

| Command | Description |
|---------|-------------|
| `/screenshot` | 📸 Auto-detect running web app and capture with Playwright |
| `/screenshot <url>` | Capture a specific URL (e.g., `http://localhost:3000`) |
| `/screenshot desktop` | Raw desktop screenshot |
| `/status` | Bridge state, mode, session ID, uptime |
| `/cancel` | Cancel current request, clear queue |
| `/model` | Show or change the AI model |
| `/models` | List all available models |
| `/help` | Show all commands |

## Features

- **🤖 Permission Modes** — `/agent` for full tool execution, `/ask` for read-only, `/plan` for suggestions
- **🔀 Session Switching** — Connect to any active Copilot CLI terminal session from your phone
- **📸 Smart Screenshots** — Auto-detects running dev servers and captures web apps via Playwright headless Chromium
- **📱 Text Messages** — Type anything to chat with Copilot
- **📷 Photo Support** — Send a photo for image analysis
- **⏳ Live Progress** — Shows tool activity and elapsed time during long operations
- **🔄 Session Persistence** — Conversation memory survives bridge restarts
- **📋 Message Queue** — Messages queued when Copilot is busy
- **⏱️ Graceful Timeouts** — Returns partial results if timeout is reached (no lost work)
- **🟣 CLI-Style Formatting** — Purple Copilot header with HTML-formatted responses

## Architecture (v3)

```
┌────────────┐     ┌──────────────┐     ┌──────────────────┐
│   iPhone    │────▶│  Telegram    │────▶│   Node.js Bridge  │
│  (Telegram) │◀────│    API       │◀────│   (your PC)       │
└────────────┘     └──────────────┘     └────────┬─────────┘
                                                  │
                                         @github/copilot-sdk
                                          (JSON-RPC over stdio)
                                                  │
                                         ┌────────▼─────────┐
                                         │   copilot.exe     │
                                         │  (CLI subprocess) │
                                         └──────────────────┘
```

**Key Components:**
- `src/index.js` — Entry point, custom Telegram polling loop (handles 409 conflicts)
- `src/bridge.js` — Copilot SDK integration, session management, permission modes
- `src/telegram.js` — Telegram bot commands and message handling
- `src/screenshot.js` — Playwright web capture + TCP port detection for dev servers
- `src/sessions.js` — Discovers active CLI sessions (process scan + SQLite)
- `src/formatter.js` — CLI-style message formatting for Telegram
- `src/config.js` — Environment config with auto-detection of copilot.exe

## Configuration (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_USER_ID` | ✅ | — | Your Telegram user ID (auth filter) |
| `TELEGRAM_CHAT_ID` | ✅ | — | Chat ID for the bot conversation |
| `COPILOT_MODEL` | ❌ | `claude-sonnet-4` | AI model to use |
| `COPILOT_TIMEOUT_SECONDS` | ❌ | `600` | Max seconds per request (10 min) |
| `COPILOT_CLI_PATH` | ❌ | Auto-detect | Path to copilot.exe |

## Security

- Only messages from your configured `TELEGRAM_USER_ID` are accepted
- All other messages are silently dropped
- Bot token and credentials are in `.env` (gitignored)
- Recommended: Set your bot to private mode via BotFather (`/setjoingroups` → Disable)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| 409 Conflict | Another bot instance is polling — stop it first (auto-retries with backoff) |
| Permission restrictions | Use `/agent` to switch to full autonomy mode |
| Timeout errors | Timeout is 10 min; partial results returned on timeout |
| CLI auth fails | Run `copilot` manually first to complete OAuth login |
| Session not found | Use `/sessions` to list active sessions, `/new` for fresh one |
