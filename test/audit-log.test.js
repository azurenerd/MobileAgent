import { describe, it, expect, beforeEach } from 'vitest';
import { auditLog, getRecentAuditEntries, formatAuditEntries } from '../src/audit-log.js';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../src/config.js';

const AUDIT_FILE = join(config.tempDir || '.', 'audit.jsonl');

describe('audit-log', () => {
  beforeEach(() => {
    // Clear audit file before each test
    try { unlinkSync(AUDIT_FILE); } catch {}
  });

  it('auditLog writes an entry', () => {
    auditLog({ type: 'test', mode: 'agent', prompt: 'hello', response: 'world' });
    expect(existsSync(AUDIT_FILE)).toBe(true);
    const content = readFileSync(AUDIT_FILE, 'utf-8').trim();
    const entry = JSON.parse(content);
    expect(entry.type).toBe('test');
    expect(entry.mode).toBe('agent');
    expect(entry.promptPreview).toBe('hello');
    expect(entry.responsePreview).toBe('world');
  });

  it('redacts sensitive data', () => {
    auditLog({ type: 'test', mode: 'agent', prompt: 'token: ghp_abc123abc123abc123abc123abc123abc123ab' });
    const entries = getRecentAuditEntries(1);
    expect(entries[0].promptPreview).toContain('[REDACTED]');
    expect(entries[0].promptPreview).not.toContain('ghp_');
  });

  it('getRecentAuditEntries returns correct count', () => {
    for (let i = 0; i < 10; i++) {
      auditLog({ type: 'test', mode: 'agent', prompt: `msg ${i}` });
    }
    expect(getRecentAuditEntries(3)).toHaveLength(3);
    expect(getRecentAuditEntries(20)).toHaveLength(10);
  });

  it('stores metadata, not full content', () => {
    const longPrompt = 'a'.repeat(500);
    auditLog({ type: 'test', mode: 'agent', prompt: longPrompt, response: longPrompt });
    const entries = getRecentAuditEntries(1);
    expect(entries[0].promptPreview.length).toBeLessThanOrEqual(100);
    expect(entries[0].promptLength).toBe(500);
    expect(entries[0].responseLength).toBe(500);
  });

  it('formatAuditEntries handles empty', () => {
    expect(formatAuditEntries([])).toBe('No activity logged yet.');
  });

  it('formatAuditEntries formats entries', () => {
    auditLog({ type: 'test', mode: 'ask', prompt: 'what is this?', durationMs: 5000, tools: ['read'] });
    const entries = getRecentAuditEntries(1);
    const formatted = formatAuditEntries(entries);
    expect(formatted).toContain('ask');
    expect(formatted).toContain('5s');
    expect(formatted).toContain('read');
  });
});
