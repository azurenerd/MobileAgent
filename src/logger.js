/**
 * Structured logger — JSON-formatted output with levels and request IDs.
 * Lightweight alternative to pino that doesn't require dependencies.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]));

const minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;

let _requestId = null;

export function setRequestId(id) {
  _requestId = id;
}

export function clearRequestId() {
  _requestId = null;
}

function emit(level, component, msg, extra = {}) {
  if (level < minLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level: LEVEL_NAMES[level],
    component,
    msg,
    ...((_requestId) ? { reqId: _requestId } : {}),
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level >= LEVELS.error) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

/**
 * Create a scoped logger for a specific component.
 * Usage: const log = createLogger('bridge');
 *        log.info('Session started', { sessionId: '...' });
 */
export function createLogger(component) {
  return {
    debug: (msg, extra) => emit(LEVELS.debug, component, msg, extra),
    info:  (msg, extra) => emit(LEVELS.info, component, msg, extra),
    warn:  (msg, extra) => emit(LEVELS.warn, component, msg, extra),
    error: (msg, extra) => emit(LEVELS.error, component, msg, extra),
    fatal: (msg, extra) => emit(LEVELS.fatal, component, msg, extra),
  };
}
