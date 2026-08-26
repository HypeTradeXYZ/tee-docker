import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { describeBodyIssues, invalidBodyMessage } from '../src/common/invalid-body';
import { MAX_PUBLIC_MESSAGE } from '../src/common/reviewed-message';

/**
 * invalid-body-message — naming the field that failed without reflecting input.
 *
 * The expected-shape text a route carries says what the body should look like;
 * it cannot say what arrived. These names close that half, under the constraint
 * that a zod path is not automatically safe to render: record keys and
 * unrecognized keys are both caller-authored.
 */
describe('invalid-body-message', () => {
  const Body = z
    .object({
      count: z.number().int().positive(),
      label: z.string().min(1).optional(),
    })
    .strict();

  const failure = (value: unknown) => {
    const parsed = Body.safeParse(value);
    if (parsed.success) throw new Error('expected the fixture body to fail');
    return parsed.error;
  };

  it('separates a missing field from one that is present and wrong', () => {
    expect(describeBodyIssues(failure({}), {})).toBe('"count" is required');
    expect(describeBodyIssues(failure({ count: 'x' }), { count: 'x' })).toBe(
      '"count" is not valid',
    );
    expect(describeBodyIssues(failure({ count: -1 }), { count: -1 })).toBe(
      '"count" is not valid',
    );
  });

  it('names an unexpected field, which is usually a typo', () => {
    expect(describeBodyIssues(failure({ count: 1, labell: 'x' }), { count: 1, labell: 'x' })).toBe(
      'unexpected field "labell"',
    );
  });

  it('appends the detail to the expected shape', () => {
    expect(invalidBodyMessage('body must be { count }', failure({}), {})).toBe(
      'body must be { count } — "count" is required',
    );
  });

  describe('nothing caller-authored is reflected unchecked', () => {
    // A record key is caller-supplied and lands in the issue path verbatim.
    it('drops a path segment that is not a plain identifier', () => {
      const Record = z.object({ types: z.record(z.string(), z.array(z.string())) });
      const parsed = Record.safeParse({ types: { '<script>alert(1)</script>': 'nope' } });
      if (parsed.success) throw new Error('expected failure');
      // The root field is still named; the caller-authored key never appears.
      const text = describeBodyIssues(parsed.error, { types: {} });
      expect(text).toBe('"types" is not valid');
      expect(text).not.toContain('script');
    });

    it('drops an unrecognized key that is not a plain identifier', () => {
      const hostile = { count: 1, '<img src=x>': 1 };
      expect(describeBodyIssues(failure(hostile), hostile)).toBeUndefined();
    });

    it('drops an unrecognized key longer than the bound', () => {
      const hostile = { count: 1, ['k'.repeat(41)]: 1 };
      expect(describeBodyIssues(failure(hostile), hostile)).toBeUndefined();
    });

    it('never reflects a field value, only its name', () => {
      const body = { count: 'SECRET-value-do-not-echo' };
      const text = invalidBodyMessage('body must be { count }', failure(body), body);
      expect(text).not.toContain('SECRET');
    });
  });

  describe('the message stays inside the reviewed-message budget', () => {
    // Over-long messages are dropped wholesale by the error filter, so an
    // unbounded detail would cost the caller the expected shape as well.
    it('names at most three fields', () => {
      const Wide = z
        .object(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((k) => [k, z.number()])))
        .strict();
      const parsed = Wide.safeParse({});
      if (parsed.success) throw new Error('expected failure');
      const text = describeBodyIssues(parsed.error, {}) ?? '';
      expect(text.match(/is required/g)).toHaveLength(3);
    });

    it('falls back to the expected shape when the detail would overflow', () => {
      const expected = 'body must be { '.padEnd(MAX_PUBLIC_MESSAGE - 20, 'x') + ' }';
      const result = invalidBodyMessage(expected, failure({}), {});
      expect(result).toBe(expected);
    });

    // Derived from the controllers rather than transcribed, so a route whose
    // expected-shape text grows past the budget fails here instead of silently
    // losing its field detail in production. The previous version of this test
    // hand-copied one literal while claiming to check them all.
    it('keeps every real route message renderable', () => {
      const controllers = join(__dirname, '..', 'src');
      const sources = readdirSync(controllers, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts'))
        .map((f) => readFileSync(join(controllers, f), 'utf8'));
      const expectedShapes = sources
        .flatMap((src) => [...src.matchAll(/invalidBodyMessage\(\s*\n?\s*'([^']+)'/g)])
        .map((m) => m[1]);

      // If this ever reads zero, the regex has drifted and the test is vacuous.
      expect(expectedShapes.length).toBeGreaterThanOrEqual(8);

      for (const expected of expectedShapes) {
        const result = invalidBodyMessage(expected, failure({}), {});
        expect(result.length).toBeLessThanOrEqual(MAX_PUBLIC_MESSAGE);
        expect(result).toContain('is required');
      }
    });
  });
});
