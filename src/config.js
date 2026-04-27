import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const homeDir = process.env.USERPROFILE || process.env.HOME || '';

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

// Detect the WinGet-installed copilot.exe path
function detectCliPath() {
  const envPath = process.env.COPILOT_CLI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const wingetPath = join(
    homeDir,
    'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages',
    'GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'copilot.exe'
  );
  if (existsSync(wingetPath)) return wingetPath;

  return null; // SDK will use its bundled CLI
}

// Transport selection: 'telegram' (default) or 'teams'
const transport = optional('TRANSPORT', 'telegram');

function buildTelegramConfig() {
  return {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    userId: Number(required('TELEGRAM_USER_ID')),
    chatId: Number(required('TELEGRAM_CHAT_ID')),
  };
}

function buildTeamsConfig() {
  return {
    clientId: optional('TEAMS_CLIENT_ID', 'de8bc8b5-d9f9-48b1-a8ad-b748da725064'),
    tenantId: optional('TEAMS_TENANT_ID', 'organizations'),
    recipientUpn: optional('TEAMS_RECIPIENT_UPN', 'me'),
    chatId: optional('TEAMS_CHAT_ID', ''),
    pollIntervalMs: Number(optional('TEAMS_POLL_INTERVAL_MS', '3000')),
  };
}

export const config = {
  transport,
  telegram: transport === 'telegram' ? buildTelegramConfig() : {},
  teams: transport === 'teams' ? buildTeamsConfig() : {},
  copilot: {
    model: optional('COPILOT_MODEL', 'claude-sonnet-4'),
    timeoutMs: Number(optional('COPILOT_TIMEOUT_SECONDS', '600')) * 1000,
    cliPath: detectCliPath(),
  },
  paths: {
    home: homeDir,
    copilotDir: join(homeDir, '.copilot'),
    sessionStoreDb: join(homeDir, '.copilot', 'session-store.db'),
    sessionStateDir: join(homeDir, '.copilot', 'session-state'),
  },
  stateFile: join(projectRoot, 'session-state.json'),
  tempDir: join(projectRoot, 'temp'),
};
