import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AllowAnyWorkspaceScope,
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
