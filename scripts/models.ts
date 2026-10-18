// The ONNX model files are not in git: they are assets of a GitHub release, listed in models.json with their SHA-256.
//   bun scripts/models.ts fetch [--from <dir>]   puts every listed model in place: skips files that already match, downloads the rest
//                                                from the release (or copies them from <dir>, a folder of release assets), checks
//                                                each SHA-256 before writing it.
//   bun scripts/models.ts verify                 checks that every listed model is present and matches.
//   bun scripts/models.ts pack <out dir>         (maintainers) copies the current models into <out dir> under their asset names and
//                                                rewrites models.json's hashes and sizes; upload <out dir>/* to the release `tag`.
// models.json: { repo: "owner/name" | null, tag, files: [{ path, asset, sha256, size }] }; `repo` is the GitHub repository hosting
// the release (null until it exists: then only --from works).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const MANIFEST = path.join(ROOT, 'models.json');

interface ModelFile {
  path: string;
  asset: string;
  sha256: string;
  size: number;
}
interface Manifest {
  repo: string | null;
  tag: string;
  files: ModelFile[];
}

function readManifest(): Manifest {
  const raw: unknown = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('tag' in raw) || !('files' in raw) || !('repo' in raw)) throw new Error(`${MANIFEST} needs repo, tag and files.`);
  const { repo, tag, files } = raw;
  if ((repo !== null && typeof repo !== 'string') || typeof tag !== 'string' || !Array.isArray(files)) throw new Error(`${MANIFEST}: repo must be "owner/name" or null, tag a string, files an array.`);
  for (const f of files) {
    if (typeof f !== 'object' || f === null || typeof f.path !== 'string' || typeof f.asset !== 'string' || typeof f.sha256 !== 'string' || typeof f.size !== 'number') {
      throw new Error(`${MANIFEST}: every file needs path, asset, sha256 and size.`);
    }
  }
  return { repo, tag, files };
}

const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
const matches = (file: string, f: ModelFile): boolean => fs.existsSync(file) && fs.statSync(file).size === f.size && sha256(fs.readFileSync(file)) === f.sha256;

async function fetchModels(from: string | undefined): Promise<void> {
  const m = readManifest();
  if (from === undefined && m.repo === null) {
    throw new Error('models.json has no "repo" yet (the GitHub owner/name hosting the model release). Set it, or install from a folder of release assets: bun scripts/models.ts fetch --from <dir>');
  }
  for (const f of m.files) {
    const target = path.join(ROOT, f.path);
    if (matches(target, f)) {
      console.log(`ok       ${f.path}`);
      continue;
    }
    let bytes: Uint8Array;
    if (from !== undefined) {
      bytes = fs.readFileSync(path.join(path.resolve(from), f.asset));
    } else {
      const url = `https://github.com/${m.repo}/releases/download/${m.tag}/${f.asset}`;
      console.log(`download ${url} (${(f.size / 1e6).toFixed(0)} MB)`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (bytes.length !== f.size || sha256(bytes) !== f.sha256) throw new Error(`${f.asset} does not match models.json (size or SHA-256); not written.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    console.log(`wrote    ${f.path}`);
  }
}

function verify(): void {
  const bad = readManifest().files.filter((f) => !matches(path.join(ROOT, f.path), f));
  for (const f of bad) console.log(`missing or different: ${f.path}`);
  if (bad.length > 0) throw new Error(`${bad.length} model file(s) missing or different. Run: bun run fetch-models`);
  console.log('all models present and matching');
}

function pack(outDir: string): void {
  const m = readManifest();
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });
  m.files = m.files.map((f) => {
    const bytes = fs.readFileSync(path.join(ROOT, f.path));
    fs.copyFileSync(path.join(ROOT, f.path), path.join(out, f.asset));
    return { ...f, sha256: sha256(bytes), size: bytes.length };
  });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`${m.files.length} assets in ${out}; models.json updated. Upload them to the release "${m.tag}".`);
}

const [command, ...rest] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i < 0 ? undefined : rest[i + 1];
};
if (command === 'fetch') await fetchModels(option('--from'));
else if (command === 'verify') verify();
else if (command === 'pack' && rest[0] !== undefined) pack(rest[0]);
else throw new Error('usage: bun scripts/models.ts fetch [--from <dir>] | verify | pack <out dir>');
