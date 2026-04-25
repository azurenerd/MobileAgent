/**
 * Audit Log — append-only JSONL store of bridge requests/responses.
 * Includes redaction of sensitive patterns + retention cleanup.
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

const AUDIT_FILE = join(config.tempDir || '.', 'audit.jsonl');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB max before rotation
const SENSITIVE_PATTERNS = [
  /(?:token|password|secret|api_key|apikey|auth)\s*[:=]\s*\S+/gi,
  /ghp_[a-zA-Z0-9]{36,}/g,          // GitHub PAT
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI key pattern
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,  // Base64 blobs (likely tokens)
];

/**
 * Redact sensitive values from text.
 */
function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/**
 * Log an audit entry.
 */
export function auditLog(entry) {
  try {
    // Rotate if too large
    if (existsSync(AUDIT_FILE)) {
      const st = statSync(AUDIT_FILE);
      if (st.size > MAX_LOG_SIZE) {
        const backupPath = AUDIT_FILE + '.old';
        try { writeFileSync(backupPath, readFileSync(AUDIT_FILE)); } catch {}
        writeFileSync(AUDIT_FILE, '');
      }
    }

    const safe = {
      ts: new Date().toISOString(),
      type: entry.type,
      mode: entry.mode,
      // Metadata only — no full prompts/responses by default
      promptLength: entry.prompt?.length || 0,
      responseLength: entry.response?.length || 0,
      // Redacted first 100 chars as preview
      promptPreview: redact((entry.prompt || '').slice(0, 100)),
      responsePreview: redact((entry.response || '').slice(0, 100)),
      tools: entry.tools || [],
      durationMs: entry.durationMs,
      timedOut: entry.timedOut || false,
      error: entry.error ? redact(entry.error) : undefined,
    };

    appendFileSync(AUDIT_FILE, JSON.stringify(safe) + '\n');
  } catch (err) {
    console.error(`[audit] Write failed: ${err.message}`);
  }
}

/**
 * Get last N audit entries.
 */
export function getRecentAuditEntries(count = 5) {
  try {
    if (!existsSync(AUDIT_FILE)) return [];
    const content = readFileSync(AUDIT_FILE, 'utf-8').trim();
    if (!content) return [];
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-count).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Format audit entries for display in Telegram.
 */
export function formatAuditEntries(entries) {
  if (entries.length === 0) return 'No activity logged yet.';
  return entries.map((e, i) => {
    const time = new Date(e.ts).toLocaleTimeString();
    const duration = e.durationMs ? `${Math.round(e.durationMs / 1000)}s` : '?';
    const timeout = e.timedOut ? ' ⏱️' : '';
    const tools = e.tools?.length ? ` [${e.tools.join(', ')}]` : '';
    return `${i + 1}. ${time} | ${e.mode || '?'} | ${duration}${timeout}${tools}\n   "${e.promptPreview || '?'}"`;
  }).join('\n\n');
}
