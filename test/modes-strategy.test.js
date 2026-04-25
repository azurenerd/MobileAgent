import { describe, it, expect } from 'vitest';
import { MODES, getMode, getModeNames, getModeLabel, isValidMode } from '../src/modes.js';

describe('MODES constant', () => {
  it('has agent, ask, plan modes', () => {
    expect(Object.keys(MODES)).toEqual(['agent', 'ask', 'plan']);
  });

  it('each mode has required fields', () => {
    for (const [name, mode] of Object.entries(MODES)) {
      expect(mode.label).toBeTruthy();
      expect(mode.description).toBeTruthy();
      expect(Array.isArray(mode.excludedTools)).toBe(true);
      expect(typeof mode.permission).toBe('function');
      expect(typeof mode.systemSuffix).toBe('string');
      expect(typeof mode.resetOnEnter).toBe('boolean');
    }
  });
});

describe('getMode', () => {
  it('returns correct mode for valid names', () => {
    expect(getMode('agent')).toBe(MODES.agent);
    expect(getMode('ask')).toBe(MODES.ask);
    expect(getMode('plan')).toBe(MODES.plan);
  });

  it('falls back to agent for unknown modes', () => {
    expect(getMode('unknown')).toBe(MODES.agent);
    expect(getMode('')).toBe(MODES.agent);
  });
});

describe('getModeNames', () => {
  it('returns all mode names', () => {
    expect(getModeNames()).toEqual(['agent', 'ask', 'plan']);
  });
});

describe('getModeLabel', () => {
  it('returns emoji labels', () => {
    expect(getModeLabel('agent')).toContain('🤖');
    expect(getModeLabel('ask')).toContain('💬');
    expect(getModeLabel('plan')).toContain('📋');
  });
});

describe('isValidMode', () => {
  it('returns true for valid modes', () => {
    expect(isValidMode('agent')).toBe(true);
    expect(isValidMode('ask')).toBe(true);
    expect(isValidMode('plan')).toBe(true);
  });

  it('returns false for invalid modes', () => {
    expect(isValidMode('unknown')).toBe(false);
    expect(isValidMode('')).toBe(false);
  });
});

describe('Permission logic', () => {
  it('agent approves everything', () => {
    expect(MODES.agent.permission({ kind: 'shell' }).kind).toBe('approve-once');
    expect(MODES.agent.permission({ kind: 'write' }).kind).toBe('approve-once');
    expect(MODES.agent.permission({ kind: 'read' }).kind).toBe('approve-once');
  });

  it('ask approves reads and URLs, rejects writes', () => {
    expect(MODES.ask.permission({ kind: 'read' }).kind).toBe('approve-once');
    expect(MODES.ask.permission({ kind: 'url' }).kind).toBe('approve-once');
    expect(MODES.ask.permission({ kind: 'shell' }).kind).toBe('reject');
    expect(MODES.ask.permission({ kind: 'write' }).kind).toBe('reject');
  });

  it('plan rejects everything', () => {
    expect(MODES.plan.permission({ kind: 'read' }).kind).toBe('reject');
    expect(MODES.plan.permission({ kind: 'shell' }).kind).toBe('reject');
    expect(MODES.plan.permission({ kind: 'write' }).kind).toBe('reject');
  });
});

describe('Excluded tools', () => {
  it('agent excludes nothing', () => {
    expect(MODES.agent.excludedTools).toEqual([]);
  });

  it('ask excludes write tools but not read', () => {
    expect(MODES.ask.excludedTools).toContain('shell');
    expect(MODES.ask.excludedTools).toContain('write');
    expect(MODES.ask.excludedTools).not.toContain('read');
  });

  it('plan excludes all tools', () => {
    expect(MODES.plan.excludedTools).toContain('shell');
    expect(MODES.plan.excludedTools).toContain('write');
    expect(MODES.plan.excludedTools).toContain('read');
    expect(MODES.plan.excludedTools).toContain('mcp');
  });
});

describe('System suffix', () => {
  it('agent has no system suffix', () => {
    expect(MODES.agent.systemSuffix).toBe('');
  });

  it('ask and plan have restrictive suffixes', () => {
    expect(MODES.ask.systemSuffix).toContain('ASK mode');
    expect(MODES.plan.systemSuffix).toContain('PLAN mode');
  });
});
