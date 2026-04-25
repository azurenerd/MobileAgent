/**
 * Platform abstraction — centralized PowerShell/OS helpers.
 * All platform-specific commands go through here.
 * Future: add a Linux/macOS implementation.
 */

import { execFile } from 'child_process';

const PWSH = 'pwsh.exe';

/**
 * Run a PowerShell one-liner and return stdout.
 * @param {string} command — The PowerShell command to run.
 * @param {number} timeoutMs — Timeout in ms (default 15s).
 * @returns {Promise<string>} stdout
 */
export function runPowershell(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(PWSH, ['-NoProfile', '-Command', command], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Capture a desktop screenshot using .NET APIs.
 * @param {string} outputPath — File path to save the PNG.
 * @returns {Promise<string>} The output path.
 */
export async function captureDesktopScreenshot(outputPath) {
  const psCommand = `
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
    $bmp = [System.Drawing.Bitmap]::new($b.Width, $b.Height);
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
    $bmp.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);
    $g.Dispose(); $bmp.Dispose();
  `.replace(/\n/g, ' ');
  await runPowershell(psCommand);
  return outputPath;
}

/**
 * List TCP connections in Listen state.
 * @returns {Promise<Array<{port: number, pid: number}>>}
 */
export async function listListeningPorts() {
  const stdout = await runPowershell(
    'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress'
  );
  if (!stdout) return [];
  const data = JSON.parse(stdout);
  const items = Array.isArray(data) ? data : [data];
  return items.map(i => ({ port: i.LocalPort, pid: i.OwningProcess }));
}

/**
 * Get the command line of a process by PID.
 * @param {number} pid
 * @returns {Promise<string|null>}
 */
export async function getProcessCommandLine(pid) {
  try {
    const stdout = await runPowershell(
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    );
    return stdout || null;
  } catch {
    return null;
  }
}

/**
 * Query running processes matching a name pattern.
 * @param {string} namePattern — e.g., 'copilot'
 * @returns {Promise<Array<{pid: number, name: string, commandLine: string}>>}
 */
export async function findProcessesByName(namePattern) {
  const stdout = await runPowershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*${namePattern}*' } | ` +
    `Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  );
  if (!stdout) return [];
  const data = JSON.parse(stdout);
  const items = Array.isArray(data) ? data : [data];
  return items.map(p => ({
    pid: p.ProcessId,
    name: p.Name,
    commandLine: p.CommandLine || '',
  }));
}
