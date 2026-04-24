import 'dotenv/config';
import { existsSync } from 'fs';

function required(key) {
  const val = process.env[key];
  if (!val) {
    console.error(`❌ Missing required env var: ${key}`);
    console.error(`   Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
  return val;
}

function optional(key, fallback) {
  return process.env[key] || fallback;
}

const copilotPath = optional(
  'COPILOT_PATH',
  'copilot'
);

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    userId: Number(required('TELEGRAM_USER_ID')),
    chatId: Number(required('TELEGRAM_CHAT_ID')),
  },
  copilot: {
    path: copilotPath,
    cwd: optional('COPILOT_CWD', process.cwd()),
  },
  pty: {
    cols: Number(optional('PTY_COLS', '120')),
    rows: Number(optional('PTY_ROWS', '40')),
  },
  outputDebounceMs: Number(optional('OUTPUT_DEBOUNCE_MS', '1500')),
};
