import { RESERVABLE_BY_GRAMMAR, RESERVED_SLUGS, TenantSchema } from '../src/config/schemas';
import { assertValidSlug } from '../src/workspaces/workspace-paths';

/**
 * reserved-slugs — a name the grammar allows but the filesystem should not.
 *
 * Two failures used to sit behind this list. A caller who picked a reserved
 * workspace slug got an error whose `expected` described the grammar their input
 * already satisfied, so there was nothing to act on. And an operator who picked
 * one as a TENANT id booted cleanly and then had every workspace create and
 * every token mint refused — with a message naming the workspace slug, pointing
 * at a caller's correct input rather than at their own configuration.
 */
describe('reserved-slugs', () => {
  const BASE = {
    id: 'acme',
    apiKey: 'k'.repeat(16),
    secretHash: 'a'.repeat(64),
    limits: { maxWorkspaces: 1, maxWallets: 1 },
  };

  it('only lists names the grammar would otherwise admit as reachable', () => {
    // `.`, `..` and `node_modules` cannot reach the check — the grammar stops
    // them first. Stating that keeps the two sets from drifting apart silently.
    expect([...RESERVABLE_BY_GRAMMAR].sort()).toEqual(['aux', 'con', 'nul', 'prn']);
    expect(RESERVED_SLUGS.has('node_modules')).toBe(true);
  });

  describe('a reserved workspace slug is refused with a reason the caller can act on', () => {
    it.each(RESERVABLE_BY_GRAMMAR)('refuses %p', (slug) => {
      expect(() => assertValidSlug(slug)).toThrow(
        expect.objectContaining({ code: 'TEE_INVALID_SLUG' }),
      );
    });

    it('does not answer with the grammar the input already satisfies', () => {
      let details: Record<string, unknown> | undefined;
      try {
        assertValidSlug('aux');
      } catch (err) {
        details = (err as { details?: Record<string, unknown> }).details;
      }
      // The old message described only the charset rule, which `aux` meets —
      // an error the caller could read all day without learning anything.
      expect(String(details?.expected)).toContain('aux');
    });

    it('still refuses a malformed slug on the grammar alone', () => {
      let details: Record<string, unknown> | undefined;
      try {
        assertValidSlug('Not A Slug');
      } catch (err) {
        details = (err as { details?: Record<string, unknown> }).details;
      }
      expect(String(details?.expected)).toContain('lowercase letters');
      expect(String(details?.expected)).not.toContain('reserved');
    });
  });

  describe('a reserved tenant id is refused at config load', () => {
    it.each(RESERVABLE_BY_GRAMMAR)('refuses a tenant id of %p', (id) => {
      const parsed = TenantSchema.safeParse({ ...BASE, id });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('reserved');
    });

    it('still accepts an ordinary tenant id', () => {
      expect(TenantSchema.safeParse(BASE).success).toBe(true);
    });

    // The grammar check must still run first, so a malformed id reports the
    // charset rule rather than the reserved list.
    it('still refuses a malformed tenant id on the grammar', () => {
      const parsed = TenantSchema.safeParse({ ...BASE, id: 'Acme Corp' });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('lowercase slug');
    });

    // A reserved name the GRAMMAR also rejects must report the grammar only.
    // Reporting both would hand the operator a reserved list that does not
    // contain what they wrote — the same unactionable error this batch set out
    // to remove, just relocated to boot.
    it.each(['node_modules', '.', '..'])('reports one reason for %p', (id) => {
      const parsed = TenantSchema.safeParse({ ...BASE, id });
      expect(parsed.success).toBe(false);
      const messages = (parsed.error?.issues ?? []).map((issue) => issue.message);
      expect(messages).toEqual(['tenant id must be a lowercase slug']);
    });
  });
});
