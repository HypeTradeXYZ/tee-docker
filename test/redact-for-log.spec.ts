import { redactForLog } from '../src/common/error.filter';

/**
 * redact-for-log — a relay capability must not reach a log line.
 *
 * The relay URL carries bearer authority even though it only listens on
 * loopback, so it is stripped before an exception is logged. Nothing pinned
 * this, and the pattern was lower-case only while `URL` preserves whatever
 * scheme case it was given — a redactor narrower than its own input is worse
 * than none, because it is trusted.
 */
describe('redact-for-log', () => {
  const CAPABILITY = 'rpc/Zm9vYmFy_secret-token';

  it.each([
    ['lower-case scheme', `http://127.0.0.1:8080/${CAPABILITY}`],
    ['upper-case scheme', `HTTP://127.0.0.1:8080/${CAPABILITY}`],
    ['mixed-case scheme', `Http://127.0.0.1:8080/${CAPABILITY}`],
  ])('strips a capability written with a %s', (_name, url) => {
    const redacted = redactForLog(`connect ECONNREFUSED at ${url} while relaying`);
    expect(redacted).not.toContain('secret-token');
    expect(redacted).toContain('[rpc-relay]');
  });

  it('strips every occurrence, not just the first', () => {
    const line = `a http://127.0.0.1:1/${CAPABILITY} b HTTP://127.0.0.1:2/${CAPABILITY} c`;
    expect(redactForLog(line)).toBe('a [rpc-relay] b [rpc-relay] c');
  });

  it('leaves ordinary text alone', () => {
    expect(redactForLog('workspace desk-a is locked')).toBe('workspace desk-a is locked');
  });
});
