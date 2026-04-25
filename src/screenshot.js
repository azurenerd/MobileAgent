import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve as pathResolve } from 'path';
import { config } from './config.js';

// ─── Browser singleton ───────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  console.log('[screenshot] Launching Chromium…');
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

/**
 * Detect a running HTTP server whose process cwd matches the project directory.
 * Scans TCP listeners on common dev-server ports (3000-9999) via PowerShell.
 *
 * @param {string} projectDir — The project directory to match against.
 * @returns {Promise<{port: number, pid: number, cwd: string}|null>}
 */
export async function detectProjectServer(projectDir) {
  if (!projectDir) return null;

  const normalizedProject = pathResolve(projectDir).toLowerCase().replace(/\\/g, '/');
  console.log(`[screenshot] Detecting server for project: ${normalizedProject}`);

  // Use pwsh (PS7) to get TCP listeners with WMI process info in one pipeline
  const psScript = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 9999 -and $_.LocalAddress -match '(0\\.0\\.0\\.0|127\\.0\\.0\\.1|::1|::)' } | Select-Object LocalPort, OwningProcess -Unique | ForEach-Object { $w = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue; if($w){ [PSCustomObject]@{ Port=$_.LocalPort; ProcId=$_.OwningProcess; Name=$w.Name; Cmd=$w.CommandLine } } } | ConvertTo-Json -Compress`;

  return new Promise((resolve) => {
    execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      timeout: 10000,
    }, (err, stdout, stderr) => {
      if (err) {
        console.warn(`[screenshot] Port scan failed: ${err.message}`);
        resolve(null);
        return;
      }

      try {
        let entries = JSON.parse(stdout.trim());
        if (!Array.isArray(entries)) entries = [entries];

        console.log(`[screenshot] Found ${entries.length} listener(s) on ports 3000–9999`);

        // Try to match by known dev-server process names first
        const devProcesses = ['node', 'node.exe', 'python', 'python.exe', 'dotnet', 'dotnet.exe', 'ruby', 'ruby.exe', 'java', 'java.exe'];

        for (const entry of entries) {
          const name = (entry.Name || '').toLowerCase();
          const cmd = (entry.Cmd || '').toLowerCase().replace(/\\/g, '/');

          // Check if this is a dev-server process AND its command references the project dir
          if (devProcesses.some(p => name.includes(p)) && cmd.includes(normalizedProject)) {
            console.log(`[screenshot] Matched: port ${entry.Port}, PID ${entry.ProcId}, cmd matches project`);
            return resolve({ port: entry.Port, pid: entry.ProcId, cwd: projectDir });
          }
        }

        // Fallback: try WMI to get actual cwd of each process, match to project
        // For now, try matching command line args (e.g., "C:\Git\ProjectDashboard" in cmd)
        for (const entry of entries) {
          const cmd = (entry.Cmd || '').toLowerCase().replace(/\\/g, '/');
          if (cmd.includes(normalizedProject)) {
            console.log(`[screenshot] Fallback match: port ${entry.Port}, PID ${entry.ProcId}`);
            return resolve({ port: entry.Port, pid: entry.ProcId, cwd: projectDir });
          }
        }

        // No match — check if there's exactly one dev-server on common ports
        const commonPorts = [3000, 3001, 4200, 5000, 5173, 5174, 8000, 8080, 8888];
        const commonEntry = entries.find(e => commonPorts.includes(e.Port));
        if (entries.length === 1 || commonEntry) {
          const pick = commonEntry || entries[0];
          console.log(`[screenshot] No project match but found single/common server: port ${pick.Port}`);
          return resolve({ port: pick.Port, pid: pick.ProcId, cwd: '' });
        }

        console.log('[screenshot] No matching server found');
        resolve(null);
      } catch (parseErr) {
        console.warn(`[screenshot] Parse error: ${parseErr.message}, stdout: ${stdout.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

/**
 * Capture a screenshot of a web page using Playwright headless Chromium.
 *
 * @param {string} url — The URL to navigate to.
 * @param {string} [outputPath] — Where to save the PNG. Auto-generated if omitted.
 * @returns {Promise<string>} — Path to the saved screenshot PNG.
 */
export async function captureWebPage(url, outputPath = null) {
  if (!outputPath) {
    const tempDir = config.tempDir;
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
    outputPath = join(tempDir, `web-screenshot-${Date.now()}.png`);
  }

  console.log(`[screenshot] Capturing: ${url} → ${outputPath}`);

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });

    // Settle time: let JS frameworks render after load event
    await page.waitForTimeout(2000);

    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(`[screenshot] Captured: ${outputPath}`);
    return outputPath;
  } catch (err) {
    console.error(`[screenshot] Playwright error: ${err.message}`);
    throw new Error(`Failed to capture ${url}: ${err.message}`);
  } finally {
    await context.close();
  }
}

/**
 * Cleanup: close the shared browser instance.
 */
export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}
