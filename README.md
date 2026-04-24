# Copilot Telegram Bridge

Chat with GitHub Copilot CLI from your phone via Telegram. Runs on your Windows PC and bridges messages between a Telegram bot and the interactive Copilot CLI session.

```
iPhone (Telegram) ←→ Telegram API ←→ This bridge (your PC) ←→ copilot.exe
```

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts, and copy the **bot token**
3. Message [@userinfobot](https://t.me/userinfobot) to get your **user ID**
4. Start a chat with your new bot and send any message
5. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find your **chat ID**

### 2. Authenticate Copilot CLI

**Important:** Run `copilot` once manually in a terminal and complete the GitHub OAuth login. The bridge cannot handle the browser-based auth flow — it must be done beforehand.

```powershell
copilot
# Complete the login, then exit with Ctrl+C
```

### 3. Configure the Bridge

```powershell
cd C:\Users\behumphr\source\copilot-telegram-bridge
copy .env.example .env
```

Edit `.env` and fill in:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_USER_ID=your_numeric_id
TELEGRAM_CHAT_ID=your_numeric_chat_id
```

### 4. Run

```powershell
npm start
```

You'll see a startup banner in the console and receive a confirmation message in Telegram.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Show bridge state, uptime, queue length |
| `/cancel` | Send Ctrl+C to Copilot, clear message queue |
| `/reset` | Kill and restart the Copilot CLI process |
| `/key <name>` | Send a keypress: `enter`, `esc`, `up`, `down`, `left`, `right`, `tab`, `y`, `n`, `space`, `ctrl-c` |
| `/raw` | Toggle raw output mode (for debugging) |
| `/queue` | Show how many messages are queued |
| `/help` | Show all commands |

## Message Format

- 🟣 **Purple circle** = Copilot's response (monospace code block)
- 🟢 **Green circle** = Your message echo (confirmation of what was sent)
- 🔵 **Blue circle** = System/bridge notifications

## How It Works

1. The bridge spawns `copilot.exe` in a pseudo-terminal (Windows ConPTY via `node-pty`)
2. A Telegram bot listens for your messages
3. When you type in Telegram → the text is written to the CLI's stdin
4. When the CLI outputs text → it's cleaned (ANSI stripped), formatted, and sent to Telegram
5. Output detection uses **debounce** (quiet period = CLI is done responding)
6. Messages are **queued** if the CLI is busy — no input corruption

## Configuration (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from BotFather |
| `TELEGRAM_USER_ID` | ✅ | — | Your Telegram user ID |
| `TELEGRAM_CHAT_ID` | ✅ | — | Chat ID for the bot conversation |
| `COPILOT_PATH` | ❌ | `copilot` | Full path to copilot.exe |
| `COPILOT_CWD` | ❌ | Current dir | Working directory for CLI |
| `OUTPUT_DEBOUNCE_MS` | ❌ | `1500` | Quiet time before sending output (ms) |
| `PTY_COLS` | ❌ | `120` | Terminal width |
| `PTY_ROWS` | ❌ | `40` | Terminal height |

## Tips

- **Interactive prompts**: If Copilot shows a menu or confirmation, use `/key up`, `/key down`, `/key enter`, `/key y`, `/key n`
- **Long responses**: Automatically chunked into multiple Telegram messages
- **Stuck?**: Try `/cancel` first, then `/reset` if that doesn't help
- **Run at startup**: Use Task Scheduler to run `npm start` in this directory on login
- **Debounce tuning**: If responses are split across messages, increase `OUTPUT_DEBOUNCE_MS`. If there's too much delay, decrease it.

## Security

- Only messages from your configured `TELEGRAM_USER_ID` + `TELEGRAM_CHAT_ID` are accepted
- All other messages are silently dropped
- The bot token and your chat ID should be kept private (in `.env`, not committed)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Invalid bot token" | Double-check `TELEGRAM_BOT_TOKEN` in `.env` |
| No messages received | Verify `TELEGRAM_CHAT_ID` — send a message to your bot and check `/getUpdates` |
| CLI auth fails | Run `copilot` manually first to complete OAuth login |
| Output looks garbled | Try `/raw` to see unformatted output, or increase `PTY_COLS` |
| Responses split weirdly | Increase `OUTPUT_DEBOUNCE_MS` to 2000-3000 |
