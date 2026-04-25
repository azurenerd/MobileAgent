import { describe, it, expect } from 'vitest';
import { createLogger, setRequestId, clearRequestId } from '../src/logger.js';

describe('createLogger', () => {
  it('creates a logger with all levels', () => {
    const log = createLogger('test');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.fatal).toBe('function');
  });

  it('logger functions do not throw', () => {
    const log = createLogger('test');
    expect(() => log.info('hello')).not.toThrow();
    expect(() => log.error('bad', { code: 500 })).not.toThrow();
    expect(() => log.debug('verbose', { detail: true })).not.toThrow();
  });
});

describe('request ID', () => {
  it('setRequestId and clearRequestId do not throw', () => {
    expect(() => setRequestId('req-123')).not.toThrow();
    expect(() => clearRequestId()).not.toThrow();
  });
});
