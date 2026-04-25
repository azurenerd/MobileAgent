import { CopilotBridge } from './bridge.js';
import { createTelegramBot } from './telegram.js';
import { formatSystem, formatSuccess } from './formatter.js';
import { config } from './config.js';

console.log('╔═══════════════════════════════════════════════╗');
console.log('║   🟣 Copilot Mobile Assistant v3              ║');
console.log('║   Powered by GitHub Copilot SDK               ║');
console.log('╚═══════════════════════════════════════════════╝');
console.log();
console.log(`[config] Model:   ${config.copilot.model}`);
console.log(`[config] Timeout: ${config.copilot.timeoutMs / 1000}s`);
console.log(`[config] Chat ID: ${config.telegram.chatId}`);
console.log();

// ─── Create the bridge and bot ────────────────────────────────────

const bridge = new CopilotBridge();
let bot, sendHtml;

async function startup() {
  // Start the Copilot SDK client + session
  console.log('[startup] Initializing Copilot SDK…');
  await bridge.start();

  const status = bridge.getStatus();
  console.log(`[startup] ✅ Session: ${status.sessionId?.slice(0, 8)}…`);
  console.log(`[startup] ✅ Model: ${status.model}`);

  // Create and start the Telegram bot
  console.log('[startup] Starting Telegram bot…');
  const tg = createTelegramBot(bridge);
  bot = tg.bot;
  sendHtml = tg.sendHtml;

  // Initialize bot info (required before handling updates)
  await bot.init();
  console.log(`[telegram] Bot initialized as @${bot.botInfo.username}`);

  // Custom polling loop that handles 409 conflicts gracefully
  // (competing instance on Texas desktop may be running)
  let pollingOffset = 0;
  let pollingActive = true;

  async function pollLoop() {
    // Drop pending updates on startup
    try {
      await bot.api.raw.deleteWebhook({ drop_pending_updates: true });
    } catch {}

    let consecutiveErrors = 0;
    let pollCount = 0;

    while (pollingActive) {
      try {
        const updates = await bot.api.raw.getUpdates({
          offset: pollingOffset,
          timeout: 3,
          allowed_updates: ['message'],
        });

        if (consecutiveErrors > 0) {
          console.log(`[polling] Recovered after ${consecutiveErrors} 409 errors`);
        }
        consecutiveErrors = 0;
        pollCount++;

        if (updates.length > 0) {
          console.log(`[polling] Got ${updates.length} update(s)`);
        } else if (pollCount % 60 === 0) {
          console.log(`[polling] Heartbeat — ${pollCount} polls, idle`);
        }

        for (const update of updates) {
          pollingOffset = update.update_id + 1;
          try {
            await bot.handleUpdate(update);
          } catch (err) {
            console.error('[telegram] Error handling update:', err.message);
          }
        }
      } catch (err) {
        const code = err?.error_code || err?.payload?.error_code;
        if (code === 409) {
          consecutiveErrors++;
          if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
            console.warn(`[polling] 409 conflict (count=${consecutiveErrors})`);
          }
          await new Promise(r => setTimeout(r, Math.min(2000, 500 * consecutiveErrors)));
        } else {
          console.error('[telegram] Polling error:', err?.message || err);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  // Store stop function for shutdown
  const stopPolling = () => { pollingActive = false; };
  bot._stopPolling = stopPolling;

  pollLoop().catch(err => console.error('[telegram] Poll loop crashed:', err));
  console.log('[telegram] Custom polling started. Waiting for messages…');

  // Send startup notification
  try {
    await sendHtml(config.telegram.chatId,
      formatSuccess(
        `Copilot Mobile v3 online!\n` +
        `Session: ${status.sessionId?.slice(0, 8)}…\n` +
        `Model: ${status.model}\n` +
        `Send /help for commands.`
      )
    );
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
  console.log(`\n[shutdown] Received ${signal}, cleaning up…`);

  try {
    if (sendHtml) {
      await sendHtml(config.telegram.chatId, formatSystem('🔌 Bridge shutting down. Goodbye!'));
    }
  } catch {}

  if (bot) {
    try { bot._stopPolling?.(); } catch {}
    try { await bot.stop(); } catch {}
  }
  await bridge.destroy();

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
  bridge.destroy().then(() => process.exit(1));
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled rejection:', err);
});
