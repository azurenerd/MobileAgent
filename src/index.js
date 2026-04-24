import { CopilotBridge } from './bridge.js';
import { createTelegramBot } from './telegram.js';
import { formatSystem } from './formatter.js';
import { config } from './config.js';

console.log('╔══════════════════════════════════════════╗');
console.log('║   Copilot Telegram Bridge v2             ║');
console.log('║   Pipe mode — no PTY, no duplicates      ║');
console.log('╚══════════════════════════════════════════╝');
console.log();
console.log(`[config] Copilot CLI: ${config.copilot.path}`);
console.log(`[config] Working dir: ${config.copilot.cwd}`);
console.log(`[config] Timeout:     ${config.copilot.timeoutSeconds}s`);
console.log(`[config] Model:       ${config.copilot.model || '(default)'}`);
console.log(`[config] Chat ID:     ${config.telegram.chatId}`);
console.log();

// ─── Create the bridge and bot ────────────────────────────────────

const bridge = new CopilotBridge();
const { bot, sendToChat } = createTelegramBot(bridge);

// ─── Smoke test: verify copilot CLI is available ──────────────────

async function startup() {
  console.log('[startup] Verifying Copilot CLI...');
  const version = await bridge.verifyCliAvailable();
  if (!version) {
    console.error('[startup] ❌ Copilot CLI not found or not working.');
    console.error(`         Path: ${config.copilot.path}`);
    console.error('         Make sure the CLI is installed and authenticated.');
    process.exit(1);
  }
  console.log(`[startup] ✅ Copilot CLI: ${version}`);

  // Start the Telegram bot with custom polling to handle 409 conflicts
  // (Telegraf's built-in polling gives up too easily when competing with another instance)
  console.log('[startup] Launching Telegram bot with custom polling...');

  let pollingOffset = 0;
  let pollingActive = true;

  async function pollLoop() {
    let consecutiveErrors = 0;
    while (pollingActive) {
      try {
        const updates = await bot.telegram.callApi('getUpdates', {
          offset: pollingOffset,
          timeout: 10,
          allowed_updates: ['message'],
        });
        consecutiveErrors = 0;

        for (const update of updates) {
          pollingOffset = update.update_id + 1;
          try {
            await bot.handleUpdate(update);
          } catch (err) {
            console.error('[telegram] Error handling update:', err.message);
          }
        }
      } catch (err) {
        if (err.response?.error_code === 409) {
          consecutiveErrors++;
          // Short wait then immediately retry — we'll eventually win the slot
          const wait = Math.min(2000, 500 * consecutiveErrors);
          await new Promise(r => setTimeout(r, wait));
        } else {
          console.error('[telegram] Polling error:', err.message);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  // Store stop function for shutdown
  bot._customPollingActive = () => pollingActive;
  bot._stopCustomPolling = () => { pollingActive = false; };

  // Start polling in background
  pollLoop().catch(err => console.error('[telegram] Poll loop crashed:', err));
  console.log('[telegram] Custom polling started. Waiting for messages...');

  // Send startup notification
  try {
    const statusMsg =
      `✅ Copilot Bridge v2 online!\n` +
      `CLI: ${version}\n` +
      `Session: ${bridge.getSessionId().slice(0, 8)}...\n` +
      `Send /help for commands.`;
    await sendToChat(formatSystem(statusMsg));
  } catch (err) {
    console.error('[telegram] Failed to send startup message:', err.message);
  }
}

startup().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, cleaning up...`);

  try {
    await sendToChat(formatSystem('🔌 Bridge is shutting down. Goodbye!'));
  } catch {
    // best effort
  }

  bot._stopCustomPolling?.();
  bridge.destroy();

  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (process.platform === 'win32') {
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  bridge.destroy();
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled rejection:', err);
});
