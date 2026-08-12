'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      experimentalDecorators: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const paths = JSON.parse(process.argv[2]);
const source = path.resolve(__dirname, '../../src/config/service-state.service.ts');
const { ServiceStateService } = require(source);

try {
  const state = ServiceStateService.fromFile(paths);
  if (process.send) process.send({ status: 'locked' });
  process.on('message', async (message) => {
    if (message !== 'close') return;
    try {
      await state.close();
      if (process.send) process.send({ status: 'closed' });
      process.exit(0);
    } catch (error) {
      if (process.send) process.send({ status: 'error', message: String(error) });
      process.exit(1);
    }
  });
} catch (error) {
  if (process.send) process.send({ status: 'error', message: String(error) });
  process.exit(1);
}
