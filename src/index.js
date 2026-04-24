import { CopilotBridge } from './bridge.js';
import { createTelegramBot } from './telegram.js';
import { formatSystem } from './formatter.js';
import { config } from './config.js';

console.log('╔══════════════════════════════════════════╗');
console.log('║   Copilot Telegram Bridge                ║');
console.log('║   Connecting Copilot CLI ↔ Telegram      ║');
console.log('╚══════════════════════════════════════════╝');
console.log();
console.log(`[config] Copilot CLI: ${config.copilot.path}`);
console.log(`[config] Working dir: ${config.copilot.cwd}`);
console.log(`[config] PTY size:    ${config.pty.cols}x${config.pty.rows}`);
console.log(`[config] Debounce:    ${config.outputDebounceMs}ms`);
console.log(`[config] Chat ID:     ${config.telegram.chatId}`);
console.log();

// ─── Create the bridge and bot ────────────────────────────────────

const bridge = new CopilotBridge();
const bot = createTelegramBot(bridge);

// ─── Start the Copilot CLI ────────────────────────────────────────

bridge.start();

// ─── Start the Telegram bot ───────────────────────────────────────

bot.launch()
  .then(async () => {
    console.log('[telegram] Bot is running! Waiting for messages...');

    // Send a startup notification to Telegram
    try {
      await bot.telegram.sendMessage(
        config.telegram.chatId,
        formatSystem('✅ Copilot Telegram Bridge is online! Send /help for commands.'),
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[telegram] Failed to send startup message:', err.message);
      console.error('           Check your TELEGRAM_CHAT_ID is correct.');
    }
  })
  .catch((err) => {
    console.error('[telegram] Failed to start bot:', err.message);
    if (err.message.includes('401')) {
      console.error('           Invalid TELEGRAM_BOT_TOKEN. Check your .env file.');
    }
    process.exit(1);
  });

// ─── Graceful shutdown ────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, cleaning up...`);

  try {
    await bot.telegram.sendMessage(
      config.telegram.chatId,
      formatSystem('🔌 Bridge is shutting down. Goodbye!'),
      { parse_mode: 'HTML' }
    );
  } catch {
    // best effort
  }

  bot.stop(signal);
  bridge.destroy();

  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Windows: handle Ctrl+C via raw mode
if (process.platform === 'win32') {
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  bridge.destroy();
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled rejection:', err);
});
