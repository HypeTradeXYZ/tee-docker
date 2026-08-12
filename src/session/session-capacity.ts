import { z } from 'zod';

export const SESSION_CAPACITY = Symbol('SESSION_CAPACITY');

export interface SessionCapacity {
  readonly process: number;
  readonly leasesPerWorkspace: number;
}

const PositiveSafeInteger = z.coerce.number().int().positive().safe();

export function sessionCapacityFromEnv(): SessionCapacity {
  return {
    process: parse('TEE_MAX_UNLOCKED_WORKSPACES', 32),
    leasesPerWorkspace: parse('TEE_MAX_TOKEN_LEASES_PER_WORKSPACE', 64),
  };
}

function parse(name: string, fallback: number): number {
  const value = process.env[name];
  const parsed = PositiveSafeInteger.safeParse(value === undefined ? fallback : value);
  if (!parsed.success) throw new Error(`${name} must be a positive safe integer`);
  return parsed.data;
}
