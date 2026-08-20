import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AllowAnyWorkspaceScope,
  AuditScopeDenial,
  RequireScopes,
  ScopesGuard,
} from '../src/auth/scopes.guard';
import { TeeError } from '../src/common/tee-error';

class MissingMetadataController {
  handler(): void {}
}

class EmptyMetadataController {
  @RequireScopes()
  handler(): void {}
}

class ReadController {
  @RequireScopes('read')
  handler(): void {}
}

class ExemptController {
  @AllowAnyWorkspaceScope()
  handler(): void {}
}

class AuditedExportController {
  @RequireScopes('export')
  @AuditScopeDenial('key_export', 'mnemonic')
  handler(): void {}
}

const contextFor = (
  controller: new () => object,
  scopes: string[] = [],
): ExecutionContext => {
  const handler = controller.prototype.handler as () => void;
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ scopes }) }),
  } as unknown as ExecutionContext;
};

describe('ScopesGuard', () => {
  const guard = new ScopesGuard(new Reflector());

  it.each([MissingMetadataController, EmptyMetadataController])(
    'fails closed when %p has no non-empty scope declaration',
    (controller) => {
      expect(() => guard.canActivate(contextFor(controller))).toThrow(
        'ScopesGuard route must declare required scopes or an explicit exemption',
      );
    },
  );

  it('allows an explicitly scope-independent workspace lifecycle route', () => {
    expect(guard.canActivate(contextFor(ExemptController))).toBe(true);
  });

  it('allows a declared and granted scope', () => {
    expect(guard.canActivate(contextFor(ReadController, ['read']))).toBe(true);
  });

  it('denies a missing declared scope with useful details', () => {
    expect.assertions(3);
    try {
      guard.canActivate(contextFor(ReadController, ['write']));
    } catch (err) {
      expect(err).toBeInstanceOf(TeeError);
      expect((err as TeeError).code).toBe('TEE_SCOPE_DENIED');
      expect((err as TeeError).details).toEqual({ required: ['read'] });
    }
  });
});

const auditContextFor = (
  controller: new () => object,
  scopes: string[],
  req: Record<string, unknown> = {},
): ExecutionContext => {
  const handler = controller.prototype.handler as () => void;
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ scopes, ...req }) }),
  } as unknown as ExecutionContext;
};

describe('ScopesGuard denial auditing', () => {
  const request = {
    tenant: { id: 'acme' },
    session: { workspaceSlug: 'desk-a' },
    requestId: 'fixed-request-id',
  };

  function subject() {
    const guard = new ScopesGuard(new Reflector());
    const logger = { warn: jest.fn(), log: jest.fn() };
    Object.defineProperty(guard, 'logger', { value: logger });
    return { guard, logger };
  }

  it('records a DENIED line when a marked export route refuses', () => {
    const { guard, logger } = subject();
    expect(() =>
      guard.canActivate(auditContextFor(AuditedExportController, ['read'], request)),
    ).toThrow(TeeError);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'key_export',
      outcome: 'DENIED',
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      target: 'mnemonic',
      required: ['export'],
      requestId: 'fixed-request-id',
    });
  });

  it('records nothing when the declared scope is granted', () => {
    const { guard, logger } = subject();
    expect(
      guard.canActivate(auditContextFor(AuditedExportController, ['export'], request)),
    ).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves an unmarked route silent so ordinary denials stay noise-free', () => {
    const { guard, logger } = subject();
    expect(() => guard.canActivate(auditContextFor(ReadController, ['write'], request))).toThrow(
      TeeError,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reflects no caller-supplied value from the refused request', () => {
    const { guard, logger } = subject();
    expect(() =>
      guard.canActivate(
        auditContextFor(AuditedExportController, ['read'], {
          ...request,
          params: { slug: 'forged\ninjected', id: '1e2' },
          query: { vm: 'evm,svm' },
        }),
      ),
    ).toThrow(TeeError);
    expect(JSON.stringify(logger.warn.mock.calls[0]?.[0])).not.toMatch(
      /forged|injected|1e2|evm,svm/,
    );
  });
});
