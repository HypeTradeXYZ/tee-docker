import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Env files, lowest precedence first. Later files override earlier ones.
 *
 * A real exported environment variable always wins over every file — a
 * container's injected config must not be silently overridden by a stray
 * `.env.local` left in the image.
 */
function candidates(nodeEnv: string): string[] {
  return ['.env', `.env.${nodeEnv}`, '.env.local'];
}

export interface LoadedEnv {
  readonly files: readonly string[];
  readonly keys: readonly string[];
}

/**
 * Populate `process.env` from env files. Call once, before anything reads
 * configuration — `WATIVE_DATA_ROOT` set here overrides HybridProvider's
 * default workspace location.
 */
export function loadEnvFiles(cwd: string = process.cwd()): LoadedEnv {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const files: string[] = [];
  const keys = new Set<string>();

  for (const name of candidates(nodeEnv)) {
    const path = resolve(cwd, name);

    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (err) {
      // Absent env files are the normal case; anything else is a real problem
      // and should not be swallowed.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw new Error(`cannot read env file ${name}`, { cause: err });
    }

    files.push(name);
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (typeof value !== 'string') continue;
      // Process env wins. Between files, later wins — tracked via `keys`.
      if (key in process.env && !keys.has(key)) continue;
      process.env[key] = value;
      keys.add(key);
    }
  }

  return { files, keys: [...keys] };
}
