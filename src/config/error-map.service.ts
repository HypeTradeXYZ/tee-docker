import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { ErrorsConfigSchema, type ErrorMapping, type ErrorsConfig } from './schemas';
import type { Paths } from './paths';
import { WATIVE_ERROR_CODES } from '../common/wative-error-codes';
import { TEE_ERROR_CODES } from '../common/tee-error';

export interface ResolvedError {
  readonly status: number;
  readonly code: string;
  readonly exposeDetails: boolean;
  readonly exposeMessage: boolean;
  /** True when the library code had no entry in the table. */
  readonly unmapped: boolean;
}

/**
 * Error-code → HTTP status, driven entirely by config. Nothing hardcoded.
 *
 * wative-core can add error codes in a minor release, so an unknown code must
 * degrade to the default status rather than crash the filter or leak a stack.
 * Fixing coverage is a config line, not a redeploy.
 */
@Injectable()
export class ErrorMapService {
  readonly #logger = new Logger(ErrorMapService.name);
  readonly #config: ErrorsConfig;
  readonly #warned = new Set<string>();

  constructor(config: ErrorsConfig) {
    const reviewed = [...WATIVE_ERROR_CODES, ...TEE_ERROR_CODES];
    const missing = reviewed.filter(
      (code) => config.mappings[code] === undefined,
    );
    if (missing.length > 0) {
      throw new Error(`error map is missing reviewed codes: ${missing.join(', ')}`);
    }
    const extras = Object.keys(config.mappings).filter(
      (code) => !(reviewed as readonly string[]).includes(code),
    );
    if (extras.length > 0) {
      throw new Error(`error map has unreviewed codes: ${extras.join(', ')}`);
    }
    this.#config = config;
  }

  static fromFile(paths: Paths): ErrorMapService {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(paths.errorsFile, 'utf8'));
    } catch (cause) {
      throw new Error(`cannot read error map at ${paths.errorsFile}`, { cause });
    }
    return new ErrorMapService(ErrorsConfigSchema.parse(raw));
  }

  /** Fallback status for anything with no mapping at all. */
  get defaultStatus(): number {
    return this.#config.defaultStatus;
  }

  /** Codes the table covers. Used by tests to assert full coverage. */
  get mappedCodes(): readonly string[] {
    return Object.keys(this.#config.mappings);
  }

  resolve(code: string): ResolvedError {
    const mapping: ErrorMapping | undefined = this.#config.mappings[code];

    if (!mapping) {
      // Warn once per unknown code — a new library error code shouldn't
      // produce a log line on every request that triggers it.
      if (!this.#warned.has(code)) {
        this.#warned.add(code);
        this.#logger.warn(`unmapped error code "${code}" — add it to the error map`);
      }
      return {
        status: this.#config.defaultStatus,
        code: 'internal_error',
        exposeDetails: false,
        exposeMessage: false,
        unmapped: true,
      };
    }

    return {
      status: mapping.status,
      code: mapping.code,
      exposeDetails: mapping.exposeDetails ?? this.#config.defaultExposeDetails,
      exposeMessage: mapping.exposeMessage ?? false,
      unmapped: false,
    };
  }
}
