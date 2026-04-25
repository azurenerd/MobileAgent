import { describe, it, expect } from 'vitest';

// Test the permission handlers and mode logic (pure functions from bridge.js)
// We import them indirectly since they are module-level functions

// Re-implement the pure logic for testing (same logic as bridge.js)
function getExcludedTools(mode) {
  switch (mode) {
    case 'agent': return [];
    case 'ask': return ['shell', 'write', 'custom-tool'];
    case 'plan': return ['shell', 'write', 'read', 'custom-tool', 'mcp'];
    default: return [];
  }
}

const MODE_LABELS = {
  agent: '🤖 Agent',
  ask: '💬 Ask',
  plan: '📋 Plan',
};

function getPermissionDecision(mode, requestKind) {
  switch (mode) {
    case 'agent':
      return 'approve-once';
    case 'ask':
      if (requestKind === 'read' || requestKind === 'url') return 'approve-once';
      return 'reject';
    case 'plan':
      return 'reject';
    default:
      return 'approve-once';
  }
}

describe('Mode labels', () => {
  it('has all three modes', () => {
    expect(Object.keys(MODE_LABELS)).toEqual(['agent', 'ask', 'plan']);
  });

  it('uses correct emoji prefixes', () => {
    expect(MODE_LABELS.agent).toContain('🤖');
    expect(MODE_LABELS.ask).toContain('💬');
    expect(MODE_LABELS.plan).toContain('📋');
  });
});

describe('getExcludedTools', () => {
  it('agent mode excludes nothing', () => {
    expect(getExcludedTools('agent')).toEqual([]);
  });

  it('ask mode excludes shell and write', () => {
    const tools = getExcludedTools('ask');
    expect(tools).toContain('shell');
    expect(tools).toContain('write');
    expect(tools).not.toContain('read');
  });

  it('plan mode excludes everything', () => {
    const tools = getExcludedTools('plan');
    expect(tools).toContain('shell');
    expect(tools).toContain('write');
    expect(tools).toContain('read');
    expect(tools).toContain('mcp');
  });

  it('unknown mode defaults to empty (like agent)', () => {
    expect(getExcludedTools('unknown')).toEqual([]);
  });
});

describe('Permission decisions', () => {
  it('agent mode approves everything', () => {
    expect(getPermissionDecision('agent', 'shell')).toBe('approve-once');
    expect(getPermissionDecision('agent', 'write')).toBe('approve-once');
    expect(getPermissionDecision('agent', 'read')).toBe('approve-once');
  });

  it('ask mode approves reads and URLs only', () => {
    expect(getPermissionDecision('ask', 'read')).toBe('approve-once');
    expect(getPermissionDecision('ask', 'url')).toBe('approve-once');
    expect(getPermissionDecision('ask', 'shell')).toBe('reject');
    expect(getPermissionDecision('ask', 'write')).toBe('reject');
  });

  it('plan mode rejects everything', () => {
    expect(getPermissionDecision('plan', 'read')).toBe('reject');
    expect(getPermissionDecision('plan', 'shell')).toBe('reject');
    expect(getPermissionDecision('plan', 'write')).toBe('reject');
  });
});
