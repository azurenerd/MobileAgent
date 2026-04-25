/**
 * Mode Strategy — single source of truth for permission modes.
 * Adding a new mode = one entry here. No more 5-location changes.
 */

export const MODES = {
  agent: {
    label: '🤖 Agent',
    description: 'Full autonomy — runs commands, writes files',
    excludedTools: [],
    permission: (request) => {
      return { kind: 'approve-once' };
    },
    systemSuffix: '',
    resetOnEnter: false,
  },
  ask: {
    label: '💬 Ask',
    description: 'Read-only — answers questions, no writes',
    excludedTools: ['shell', 'write', 'custom-tool'],
    permission: (request) => {
      if (request.kind === 'read' || request.kind === 'url') {
        return { kind: 'approve-once' };
      }
      return { kind: 'reject' };
    },
    systemSuffix: '\n\nIMPORTANT: You are in ASK mode. You may read files and browse URLs but must NOT execute shell commands, write files, or make any changes. If the user asks you to do something that requires those actions, explain what you would do but do not execute it.',
    resetOnEnter: false,
  },
  plan: {
    label: '📋 Plan',
    description: 'Suggest-only — describes actions, never executes',
    excludedTools: ['shell', 'write', 'read', 'custom-tool', 'mcp'],
    permission: (_request) => {
      return { kind: 'reject' };
    },
    systemSuffix: '\n\nIMPORTANT: You are in PLAN mode. Describe what you would do in detail, but do NOT execute any tools, read files, run commands, or make changes. Respond only with your analysis and proposed plan.',
    resetOnEnter: false,
  },
};

/** Get mode config, falling back to agent for unknown modes. */
export function getMode(name) {
  return MODES[name] || MODES.agent;
}

/** Get all mode names. */
export function getModeNames() {
  return Object.keys(MODES);
}

/** Get mode label for display. */
export function getModeLabel(name) {
  return getMode(name).label;
}

/** Validate mode name. */
export function isValidMode(name) {
  return name in MODES;
}
