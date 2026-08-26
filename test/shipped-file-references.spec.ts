import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/**
 * shipped-file-references — a tracked file must not send a reader somewhere the
 * repository does not go.
 *
 * `docs/` is deliberately gitignored, so a comment reading "see docs/DEPLOY.md"
 * is an instruction that cannot be followed by anyone who only has the clone —
 * which is everyone. This has been fixed once before, in the state-lock refusal
 * message, and then reintroduced a week later in the compose file, so the rule
 * needs a guard rather than a habit.
 *
 * `.gitignore` is the file that does the ignoring, so it is allowed to name the
 * path it excludes.
 */
describe('shipped-file-references', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.length > 0 && path !== '.gitignore');

  it('tracks nothing that points at the unshipped docs tree', () => {
    const offenders: string[] = [];

    for (const path of tracked) {
      let contents: string;
      try {
        contents = readFileSync(join(ROOT, path), 'utf8');
      } catch {
        continue; // binary or unreadable; nothing to reference
      }
      for (const [index, line] of contents.split('\n').entries()) {
        if (/docs\/[A-Za-z0-9._-]+\.md/.test(line)) {
          offenders.push(`${path}:${index + 1} ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // A cheap check that the list above is real: if `git ls-files` ever returns
  // nothing the assertion passes vacuously and the guard is silently gone.
  it('read a non-trivial set of tracked files', () => {
    expect(tracked.length).toBeGreaterThan(50);
  });
});
