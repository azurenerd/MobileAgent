import { CopilotBridge } from './bridge.js';
import { createTelegramBot } from './telegram.js';
import { formatSystem, formatSuccess } from './formatter.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

const log = createLogger('main');

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
  bridge.startHealthMonitor(60000); // 60s health checks

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
          allowed_updates: ['message', 'callback_query'],
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

  // Resilient polling: auto-restart on crash with backoff + Telegram notification
  const MAX_POLL_RESTARTS = 10;
  const POLL_RESTART_RESET_MS = 300_000; // 5 min healthy resets counter

  async function resilientPollLoop() {
    let restarts = 0;
    let healthySince = Date.now();

    while (true) {
      try {
        healthySince = Date.now();
        await pollLoop();
        break; // clean exit via pollingActive = false
      } catch (err) {
        // 409 errors are normal competing-instance conflicts, not crashes
        const code = err?.error_code || err?.payload?.error_code;
        if (code === 409) {
          console.warn('[polling] 409 in poll loop, retrying in 5s…');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (Date.now() - healthySince > POLL_RESTART_RESET_MS) {
          restarts = 0; // was healthy for 5+ min, reset
        }
        restarts++;
        console.error(`[polling] Loop crashed (${restarts}/${MAX_POLL_RESTARTS}):`, err.message);

        if (restarts >= MAX_POLL_RESTARTS) {
          console.error('[polling] Too many restarts. Exiting for process manager.');
          try {
            await sendHtml(config.telegram.chatId,
              formatSystem(`🚨 Poll loop crashed ${MAX_POLL_RESTARTS} times. Exiting.\nError: ${err.message}`)
            );
          } catch {}
          process.exit(1);
        }

        if (restarts === 1 || restarts % 5 === 0) {
          try {
            await sendHtml(config.telegram.chatId,
              formatSystem(`⚠️ Poll loop crashed, auto-restarting (${restarts}x)\nError: ${err.message}`)
            );
          } catch {}
        }

        const backoff = Math.min(30000, 2000 * Math.pow(2, restarts - 1));
        console.log(`[polling] Restarting in ${backoff / 1000}s…`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  resilientPollLoop();
  console.log('[telegram] Resilient polling started. Waiting for messages…');

  // Health monitoring notifications
  bridge.on('health_error', async (err) => {
    try { await sendHtml(config.telegram.chatId, formatSystem(`⚠️ SDK health check failed: ${err.message}`)); } catch {}
  });
  bridge.on('health_recovered', async () => {
    try { await sendHtml(config.telegram.chatId, formatSystem('✅ SDK connection recovered.')); } catch {}
  });

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

  // Periodic temp file sweeper — clean files older than 1 hour every 30 min
  setInterval(() => {
    try {
      if (!config.tempDir) return;
      const now = Date.now();
      const maxAge = 60 * 60 * 1000; // 1 hour
      for (const f of readdirSync(config.tempDir)) {
        const fp = join(config.tempDir, f);
        try {
          const st = statSync(fp);
          if (now - st.mtimeMs > maxAge) {
            unlinkSync(fp);
            console.log(`[cleanup] Removed old temp file: ${f}`);
          }
        } catch {}
      }
    } catch {}
  }, 30 * 60 * 1000);
}

startup().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, cleaning up…`);

  // Hard 10s deadline — if destroy() hangs (Playwright, SDK), force exit
  const forceExit = setTimeout(() => {
    console.error('[shutdown] Timed out after 10s. Force exiting.');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    if (sendHtml) {
      await sendHtml(config.telegram.chatId, formatSystem('🔌 Bridge shutting down. Goodbye!'));
    }
  } catch {}

  if (bot) {
    try { bot._stopPolling?.(); } catch {}
    try { await bot.stop(); } catch {}
  }
  await bridge.destroy().catch(() => {});

  clearTimeout(forceExit);
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
  const forceExit = setTimeout(() => {
    console.error('[fatal] Graceful shutdown timed out after 5s. Force exiting.');
    process.exit(1);
  }, 5000);
  forceExit.unref();
  bridge.destroy()
    .catch((e) => console.error('[fatal] Error during destroy:', e.message))
    .finally(() => { clearTimeout(forceExit); process.exit(1); });
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled rejection:', err);
});
