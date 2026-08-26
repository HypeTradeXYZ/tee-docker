import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/**
 * shipped-file-references — a tracked file must not send a reader somewhere the
 * repository does not go.
 *
 * The `docs` tree is deliberately gitignored, so a comment pointing a reader at
 * a markdown file inside it is an instruction nobody working from the clone can
 * follow — which is everyone. This was fixed once in the state-lock refusal
 * message and reintroduced a week later in the compose file, so the rule needs a
 * guard rather than a habit.
 *
 * Note this file is itself scanned, so the pattern is described here rather than
 * written out; a guard with an exemption for itself is a guard with a hole.
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
        // Both forms point at a file the clone does not contain. Matching only
        // the `docs/` prefix missed every citation that wrote the bare
        // filename, which is most of them — the guard asserted the problem
        // could not exist while instances of it sat in `src/`.
        if (/docs\/[A-Za-z0-9._-]+\.md/.test(line) || /\b[A-Z][A-Za-z0-9_-]*\.md\b/.test(line)) {
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
