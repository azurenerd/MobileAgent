import { execSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

/**
 * Discover active Copilot CLI sessions by scanning running processes
 * and enriching with metadata from the session-store database.
 *
 * @param {number} [excludePid] - PID to exclude (SDK's own CLI process)
 * @returns {Array<{sessionId: string, projectPath: string|null, summary: string|null, repository: string|null, pid: number, lastActive: string|null}>}
 */
export function discoverSessions(excludePid = null) {
  const processEntries = scanCopilotProcesses(excludePid);
  if (processEntries.length === 0) return [];

  const dbMetadata = querySessionStore(processEntries.map(p => p.sessionId));

  // Merge process info with DB metadata
  const sessions = [];
  const seen = new Set();

  for (const proc of processEntries) {
    if (seen.has(proc.sessionId)) continue;
    seen.add(proc.sessionId);

    const meta = dbMetadata.get(proc.sessionId) || {};
    const sessionDir = join(config.paths.sessionStateDir, proc.sessionId);
    let lastActive = meta.updatedAt || null;

    // Fallback: use session directory mtime
    if (!lastActive && existsSync(sessionDir)) {
      try {
        const stat = statSync(sessionDir);
        lastActive = stat.mtime.toISOString();
      } catch {}
    }

    // Derive a display name from the project path
    const projectName = proc.projectPath
      ? proc.projectPath.replace(/\\/g, '/').split('/').pop()
      : null;

    sessions.push({
      sessionId: proc.sessionId,
      projectPath: proc.projectPath,
      projectName,
      summary: meta.summary || null,
      checkpointTitle: meta.checkpointTitle || null,
      checkpointOverview: meta.checkpointOverview || null,
      repository: meta.repository || null,
      pid: proc.pid,
      lastActive,
    });
  }

  // Sort: most recently active first
  sessions.sort((a, b) => {
    if (!a.lastActive && !b.lastActive) return 0;
    if (!a.lastActive) return 1;
    if (!b.lastActive) return -1;
    return new Date(b.lastActive) - new Date(a.lastActive);
  });

  return sessions;
}

/**
 * Scan running copilot.exe processes and extract session IDs and project paths.
 */
function scanCopilotProcesses(excludePid) {
  const entries = [];

  try {
    const raw = execSync(
      'Get-CimInstance Win32_Process -Filter "Name=\'copilot.exe\'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
      { shell: 'powershell.exe', encoding: 'utf-8', timeout: 10000 }
    );

    let processes = JSON.parse(raw || '[]');
    if (!Array.isArray(processes)) processes = [processes];

    for (const proc of processes) {
      if (!proc.CommandLine) continue;
      if (excludePid && proc.ProcessId === excludePid) continue;

      // Parse --resume <UUID>
      const resumeMatch = proc.CommandLine.match(/--resume\s+([0-9a-f-]{36})/i);
      if (!resumeMatch) continue;
      const sessionId = resumeMatch[1];

      // Parse --add-dir <PATH>
      const addDirMatch = proc.CommandLine.match(/--add-dir\s+"?([^"\s]+)"?/);
      const projectPath = addDirMatch ? addDirMatch[1].replace(/\//g, '\\') : null;

      entries.push({
        sessionId,
        projectPath,
        pid: proc.ProcessId,
      });
    }
  } catch (err) {
    console.error('[sessions] Process scan failed:', err.message);
  }

  return entries;
}

/**
 * Query the session-store.db for metadata about specific sessions.
 * Also pulls the latest checkpoint title+overview for a richer summary.
 */
function querySessionStore(sessionIds) {
  const metadata = new Map();
  if (!existsSync(config.paths.sessionStoreDb)) return metadata;

  try {
    const db = new DatabaseSync(config.paths.sessionStoreDb, { readOnly: true });

    const placeholders = sessionIds.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT id, cwd, repository, summary, updated_at FROM sessions WHERE id IN (${placeholders})`
    );
    const rows = stmt.all(...sessionIds);

    for (const row of rows) {
      metadata.set(row.id, {
        cwd: row.cwd,
        repository: row.repository,
        summary: row.summary,
        updatedAt: row.updated_at,
        checkpointTitle: null,
        checkpointOverview: null,
      });
    }

    // Enrich with latest checkpoint title + overview per session
    try {
      const cpStmt = db.prepare(
        `SELECT c.session_id, c.title, c.overview
         FROM checkpoints c
         INNER JOIN (
           SELECT session_id, MAX(checkpoint_number) as max_cp
           FROM checkpoints
           WHERE session_id IN (${placeholders})
           GROUP BY session_id
         ) latest ON c.session_id = latest.session_id AND c.checkpoint_number = latest.max_cp`
      );
      const cpRows = cpStmt.all(...sessionIds);
      for (const cp of cpRows) {
        const meta = metadata.get(cp.session_id);
        if (meta) {
          meta.checkpointTitle = cp.title || null;
          meta.checkpointOverview = cp.overview || null;
        }
      }
    } catch (cpErr) {
      // Checkpoint query is optional — don't fail the whole thing
      console.warn('[sessions] Checkpoint query failed:', cpErr.message);
    }

    db.close();
  } catch (err) {
    console.error('[sessions] DB query failed:', err.message);
  }

  return metadata;
}

/**
 * Format a relative time string.
 */
export function formatRelativeTime(isoDate) {
  if (!isoDate) return 'unknown';
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
