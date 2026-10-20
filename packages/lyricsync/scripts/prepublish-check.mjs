// scripts/prepublish-check.mjs
// Runs before `npm publish` (prepublishOnly). Refuses to publish a manifest that cannot work from the registry, or a package without its assets.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];

for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
  if (/^(file|link|workspace):/.test(spec)) {
    problems.push(`dependency "${name}" is "${spec}": publish it first and replace the spec with its version range (docs/publishing.md).`);
  }
}
for (const required of ['dist/cli.js', 'dist/index.js', 'models/hubert-base/model.onnx', 'models/hubert-combined/model.onnx', 'models/rmvpe/rmvpe.encoder.onnx', 'models/rmvpe/rmvpe.recurrent.onnx', 'models/boundary/frames.encoder.onnx', 'models/boundary/frames.recurrent.onnx', 'models/boundary/queries.onnx', 'models/boundary/config.json', 'weights/index.json']) {
  if (!fs.existsSync(path.join(root, required))) problems.push(`missing ${required}${required.startsWith('dist') ? ' (run "npm run build")' : ''}`);
}

if (problems.length > 0) {
  console.error(`prepublish check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('prepublish check ok');
