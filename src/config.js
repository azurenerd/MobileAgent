import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

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

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    userId: Number(required('TELEGRAM_USER_ID')),
    chatId: Number(required('TELEGRAM_CHAT_ID')),
  },
  copilot: {
    path: optional('COPILOT_PATH', 'copilot'),
    cwd: optional('COPILOT_CWD', process.cwd()),
    model: process.env.COPILOT_MODEL || null,
    timeoutSeconds: Number(optional('COPILOT_TIMEOUT_SECONDS', '90')),
  },
  stateFile: join(projectRoot, 'session-state.json'),
  tempDir: join(projectRoot, 'temp'),
};
