import { PasswordPolicy } from 'wative-core';
import { WorkspacesService } from '../src/workspaces/workspaces.service';
import { DEFAULT_TENANT } from './harness/boot';

describe('workspace password policy', () => {
  const policy = new PasswordPolicy();

  it('preserves the exact wative-core 2.4.4 default boundary', () => {
    expect(() => policy.enforce('Abcdef1!xyz')).toThrow(expect.objectContaining({
      code: 'WEAK_PASSWORD',
    }));
    expect(() => policy.enforce('Abcdef1!xyzw')).not.toThrow();
    expect(() => policy.enforce('Workspace-Passw0rd!x')).not.toThrow();
  });

  it('does not invent slug/tenant username context or normalize Unicode', () => {
    expect(() => policy.enforce('desk-a-Strong1!')).not.toThrow();
    expect(() => policy.enforce('éééééééééééé')).not.toThrow();
    expect(() => policy.enforce('e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301')).toThrow(
      expect.objectContaining({ code: 'WEAK_PASSWORD' }),
    );
  });

  it('rejects before provisioning even when the controller is bypassed', async () => {
    const provisionWorkspace = jest.fn();
    const service = new WorkspacesService(
      {} as never,
      {} as never,
      { provisionWorkspace } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.create(DEFAULT_TENANT as never, 'desk-a', 'weak'))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(provisionWorkspace).not.toHaveBeenCalled();
  });
});
