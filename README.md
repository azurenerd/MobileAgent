# Copilot Telegram Bridge v2

Chat with GitHub Copilot CLI from your phone via Telegram. Runs on your Windows PC and bridges messages between a Telegram bot and the Copilot CLI using **pipe mode** — no PTY, no duplicate messages.

```
iPhone (Telegram) ←→ Telegram API ←→ This bridge (your PC) ←→ copilot.exe -p
```

## How It Works

1. The bridge runs a Telegram bot that listens for your messages
2. When you send a message, it spawns `copilot -p "<your message>" --resume=<sessionId>` 
3. Copilot processes the prompt and returns a single clean response via stdout
4. Process exit = response complete (no debounce/timing issues)
5. Session persists across messages via `--resume` (Copilot remembers the conversation)
6. Messages are **queued** if the CLI is busy — one at a time, in order

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts, and copy the **bot token**
3. Message [@userinfobot](https://t.me/userinfobot) to get your **user ID**
4. Start a chat with your new bot and send any message
5. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find your **chat ID**

### 2. Authenticate Copilot CLI

**Important:** Run `copilot` once manually in a terminal and complete the GitHub OAuth login. The bridge cannot handle the browser-based auth flow.

```powershell
copilot
# Complete the login, then exit with Ctrl+C
```

### 3. Configure the Bridge

```powershell
cd copilot-telegram-bridge
copy .env.example .env
```

Edit `.env` and fill in your credentials:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_USER_ID=your_numeric_id
TELEGRAM_CHAT_ID=your_numeric_chat_id
COPILOT_PATH=C:\path\to\copilot.exe
```

### 4. Install & Run

```powershell
npm install
npm start
```

You'll see a startup banner and receive a confirmation message in Telegram.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Bridge state, session ID, uptime, queue |
| `/cancel` | Cancel current Copilot request, clear queue |
| `/newsession` | Start a new conversation (fresh context) |
| `/session` | Show current session ID |
| `/queue` | Show queued messages |
| `/help` | Show all commands |

## Features

- **📱 Text messages** — Type anything to chat with Copilot
- **📷 Photo support** — Send a photo and Copilot will try to analyze it
- **⏳ Thinking indicator** — Shows "Thinking..." while Copilot processes
- **🔄 Session persistence** — Conversation memory persists across messages
- **📋 Message queue** — Messages queued when Copilot is busy
- **🟣 Purple-style formatting** — Copilot responses with purple emoji marker

## Message Format

- 🟣 **Purple circle** = Copilot's response (monospace code block)
- 🔵 **Blue circle** = System/bridge notifications

## Configuration (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_USER_ID` | ✅ | — | Your Telegram user ID |
| `TELEGRAM_CHAT_ID` | ✅ | — | Chat ID for the bot conversation |
| `COPILOT_PATH` | ❌ | `copilot` | Full path to copilot.exe |
| `COPILOT_CWD` | ❌ | Current dir | Working directory for CLI |
| `COPILOT_TIMEOUT_SECONDS` | ❌ | `90` | Max seconds per Copilot request |
| `COPILOT_MODEL` | ❌ | (default) | Override model (e.g., `claude-sonnet-4`) |

## Tips

- **Long responses**: Automatically chunked into multiple Telegram messages (4096 char limit)
- **New conversation**: Use `/newsession` to reset context
- **Stuck?**: Try `/cancel` then resend your message
- **Run at startup**: Use Task Scheduler to run `npm start` on login
- **Model selection**: Set `COPILOT_MODEL` in `.env` to use a specific model

## Security

- Only messages from your configured `TELEGRAM_USER_ID` + `TELEGRAM_CHAT_ID` are accepted
- All other messages are silently dropped
- Bot token and chat ID are in `.env` (gitignored)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Invalid bot token" | Double-check `TELEGRAM_BOT_TOKEN` in `.env` |
| 409 Conflict | Another bot instance is polling — stop it first, or wait for the retry loop |
| No messages received | Verify `TELEGRAM_CHAT_ID` via `/getUpdates` |
| CLI auth fails | Run `copilot` manually first to complete OAuth login |
| Timeout errors | Increase `COPILOT_TIMEOUT_SECONDS` or simplify your prompt |
