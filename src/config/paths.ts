import { resolve } from 'node:path';

/**
 * Every filesystem location the service uses, resolved once from the
 * environment. Nothing else in the codebase builds a path from `process.env`.
 */
export interface Paths {
  readonly configDir: string;
  readonly stateDir: string;
  readonly dataRoot: string;
  readonly tenantsFile: string;
  readonly errorsFile: string;
  readonly stateFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configDir = resolve(env.TEE_CONFIG_DIR ?? './config');
  const stateDir = resolve(env.TEE_STATE_DIR ?? './state');
  const dataRoot = resolve(env.WATIVE_DATA_ROOT ?? './data');

  return {
    configDir,
    stateDir,
    dataRoot,
    tenantsFile: resolve(configDir, 'tenants.json'),
    errorsFile: resolve(configDir, 'errors.json'),
    stateFile: resolve(stateDir, 'state.json'),
  };
}

export const PATHS = Symbol('tee-docker:paths');
