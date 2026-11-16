import path from 'node:path';

/**
 * Resolve the port the bridge HTTP server binds to.
 *
 * The systemd units load a shared `/opt/geminirouter/.env` via
 * `EnvironmentFile=`, which (per systemd) overrides `Environment=` in the unit
 * file. Historically that file carried `PORT=8045` for the core, which silently
 * moved the bridge onto the core's port. `WEB_PORT` is therefore the bridge's
 * own, unambiguous name; `PORT` remains a fallback for PM2 and ad-hoc runs.
 */
export function resolveWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEB_PORT || env.PORT || '3000';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
}

/**
 * Candidate paths for the built desktop-helper binary, in priority order.
 * `helper/build.ps1` writes into `helper/dist/`, so that is checked before the
 * older hand-placed location in `helper/`.
 *
 * The helper app is not part of the supported surface; this only keeps the
 * existing download route pointing at where builds actually land.
 */
export function resolveHelperBinaryCandidates(
  cwd: string,
  configuredPath?: string,
): string[] {
  const name = 'framecall-helper-windows-amd64.exe';
  const candidates = [
    configuredPath,
    path.resolve(cwd, '../helper/dist', name),
    path.resolve(cwd, '../helper', name),
    path.resolve(cwd, 'helper/dist', name),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}
