/**
 * The code in this repository is TypeScript that Node runs directly (type stripping, Node 22.18 or newer).
 * Some Node builds shipped by Linux distributions are compiled without it. Then this falls back to `tsx`
 * (a devDependency of the repository root) for this process and every process it starts.
 */
import { spawnSync } from 'node:child_process';

export function ensureTypeScript() {
  if (process.features.typescript || process.env.RRH_TSX === '1') return;
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, RRH_TSX: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx`.trim() },
  });
  if (result.status !== 0 && result.status !== null && !process.env.RRH_QUIET) {
    console.error('\nIf the error above says "Cannot find package \'tsx\'": this Node build cannot run TypeScript files by itself.\nRun `npm install` in the repository root (it installs tsx), or use Node 22.18+ from nodejs.org.');
  }
  process.exit(result.status ?? 1);
}
