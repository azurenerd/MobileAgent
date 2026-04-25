import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';

describe('config', () => {
  it('has telegram bot token', () => {
    expect(config.telegram.botToken).toBeTruthy();
  });

  it('has telegram chat ID', () => {
    expect(config.telegram.chatId).toBeTruthy();
  });

  it('has copilot model default', () => {
    expect(config.copilot.model).toBeTruthy();
  });

  it('has copilot timeoutMs as number', () => {
    expect(typeof config.copilot.timeoutMs).toBe('number');
    expect(config.copilot.timeoutMs).toBeGreaterThan(0);
  });

  it('has a state file path', () => {
    expect(config.stateFile).toBeTruthy();
    expect(config.stateFile).toContain('session-state');
  });

  it('has a temp directory path', () => {
    expect(config.tempDir).toBeTruthy();
  });
});
