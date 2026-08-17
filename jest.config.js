/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
    // wative-core's crypto dependencies (@noble/*, @scure/*, uuid, ...) are
    // ESM-only with no CJS build. Jest runs CJS, so those have to be
    // transformed rather than skipped.
    '^.+\\.js$': [
      'babel-jest',
      { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] },
    ],
  },
  // Everything under node_modules is skipped EXCEPT the ESM-only packages
  // listed here. Keep this list tight — transforming all of node_modules
  // (ethers, @solana/web3.js) is very slow.
  transformIgnorePatterns: [
    'node_modules/\\.pnpm/(?!uuid|@noble\\+|@scure\\+|micro-ed25519-hdkey|bs58|base-x)',
  ],
  testEnvironment: 'node',
  // Flows boot a real Nest app and touch the filesystem — never run them
  // concurrently against a shared data root.
  maxWorkers: 1,
  // One long-lived worker runs all 51 suites, so leaked module state and
  // retained fixtures accumulate until the default heap aborts the run.
  // Recycle the worker when it gets heavy; see AUDIT-FINDINGS R-04.
  workerIdleMemoryLimit: '1GB',
  // Restore spies between tests: without this a failing test leaks its mock
  // into the next file and the collateral is blamed on an unrelated suite.
  restoreMocks: true,
  testTimeout: 30_000,
};
