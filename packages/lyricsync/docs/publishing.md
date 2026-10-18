# Publishing

Two packages, published in this order: **`beatsync`** (beat tracking, a dependency) then **`lyricsync`**.

## Before you publish

1. **Names.** `beatsync` and `lyricsync` are working names. Check that they are free on your registry, or move both under a scope (`@you/beatsync`, `@you/lyricsync`; update the `beatsync` import in `src/workspace/session.ts` and the dependency in `package.json`).
2. **License.** `package.json` says `"license": "UNLICENSED"`. Choose one for your own code. The bundled models and dictionary keep their upstream licenses (Beat This!, the HuBERT-based forced aligners, RMVPE, HarmoF0, Swift-F0, the CMU pronouncing dictionary): review each before redistributing and add a `THIRD_PARTY.md` if required.
3. **Size.** The model weights (`*.onnx`) are not in git; they are assets of the GitHub release listed in the repository's `models.json` (`bun run fetch-models` puts them in place, `bun scripts/models.ts pack <dir>` stages a new set and rewrites the hashes). An npm tarball made from a checkout with the models fetched includes them. Measured with `npm pack --dry-run` (lyricsync: estimated from the gzip size of the same files after the models moved to reduced-precision weights; re-run `npm pack --dry-run` before a release):

   | Package | Files | Unpacked | Tarball |
   |---|---|---|---|
   | `beatsync` | 21 | 79 MB | 72 MB |
   | `lyricsync` | about 94 | about 725 MB | about 665 MB |

   Most public registries will not accept a tarball of 665 MB; check the limits of your target registry (npm, a private registry, GitHub Packages) before planning the release. Quantized weights barely compress further, so the tarball is close to the unpacked size.
4. **Dependency spec.** During development `lyricsync` depends on `"beatsync": "file:../beatsync"`. Publish `beatsync` first, then replace that line with its version range (`"^0.1.0"`). `npm publish` runs `prepublishOnly` (`npm run build && node scripts/prepublish-check.mjs`), which **refuses** to publish while any dependency is a `file:`/`link:`/`workspace:` spec or while `dist/`, the models or `weights/index.json` are missing.

## Checklist

```bash
# at the repository root
bun install && bun run fetch-models && bun run verify-models && bun run typecheck && bun run test
# beatsync
cd packages/beatsync && npm pack --dry-run
# lyricsync
cd packages/lyricsync && bun test tests/e2e && npm pack --dry-run
```

`npm pack --dry-run` must list `dist/`, `models/`, `weights/`, `docs/`, `README.md`, `AGENTS.md` and nothing from `src/`, `tests/` or `scripts/`.

## Releasing a new version

- Bump `version` in `package.json` (semver). Weights (`weights/`) and the evidence layout are part of the behaviour: change `EVIDENCE_FORMAT` in `src/workspace/manifest.ts` whenever the evidence changes, so existing workspaces are re-prepared instead of silently reused.
- Retrain weights only with the trainer (`docs/training.md`); commit `weights/index.json` with the files it describes.
- Re-run the e2e test.
