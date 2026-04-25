/**
 * Platform index — re-exports the current platform implementation.
 * Currently Windows-only. Add platform detection here when expanding.
 */
export {
  runPowershell,
  captureDesktopScreenshot,
  listListeningPorts,
  getProcessCommandLine,
  findProcessesByName,
} from './windows.js';
