// packages/lyricsync/web/dev.ts
// Editor server: Vite (with vite.config.ts) plus the local endpoints the editor's server features use.
//   GET  /api/config                      { songsDir }: the songs folder this server works on.
//   POST /api/realign { project, lines, snapToBeats? }   lyricsync's full solve around the pins in `lines` (server/realign.ts);
//                                          returns the lines with every unpinned syllable re-timed, and writes
//                                          <songs>/<project>/lyricsync/out/lyrics.json and review.json.
//   POST /api/wizard/check { text, language, pronunciations }   lints lyrics: every word problem (unknown words), or counts,
//                                          sections and automatic syllable splits. Always 200; `ok` says whether they are usable.
//   POST /api/wizard/pronounce { language, input }   phones for a hand-added pronunciation ("sounds like" words, or phones).
//   POST /api/wizard/create  (multipart: id, language, bpm, firstDownbeat, lyrics, pronunciations, mix, vocal)   new song + build.
//   POST /api/wizard/resume { id }        continues a failed build.
//   GET  /api/wizard/job                  the current or last build: state and log.
//   GET/PUT /api/project/<id>/file/<path> song folder files (server/project-files.ts), for songs opened without the folder picker.
//   GET  /api/lyrics/<id>/splits          the analysed syllables per editor line and word, and whether the evidence is current.
//   POST /api/lyrics/<id>/reanalyze { lines }   writes the editor's syllable splits (server/syllables.ts) and re-prepares.
//   GET  /api/lyrics/job                  the current or last re-analysis: state and log.
// Builds and re-analyses use the GPU, so only one of them runs at a time.
// `project` / `id` is a song folder name inside the songs folder.
// usage: bun dev.ts [--songs <dir>] [--port <n>]
//   --songs  the folder that holds the song folders (default: <repository>/songs, created when missing). Point it at another
//            folder of song folders (e.g. ~/Music/projects) to edit them in place.
//   --port   default 3000.
// Run with Bun (`bun run dev`): the routes and lyricsync are TypeScript and are imported here directly, outside Vite's
// config bundling, so lyricsync still resolves its models from its own source location.
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer, type Plugin } from "vite";
import { handleRealign } from "./server/realign.ts";
import { checkLyrics, createSong, currentJob, parsePronunciations, resumeSong } from "./server/wizard.ts";
import { ProjectFileError, readProjectFile, writeProjectFile } from "./server/project-files.ts";
import { analysedSplits, currentReanalyzeJob, parseSplitLines, reanalyze, updateLyrics } from "./server/syllables.ts";
import { findSongDir } from "./server/song-inputs.ts";
import { isRecord } from "../src/guards.ts";
import {
  approximateEnglishPhonemes,
  dictionaryG2P,
  EN_VOWEL_PHONES,
  formatPhonemeSuggestion,
  pronounceAs,
  resolveSyllables,
  syllabifyEnglish,
  type Pronunciations,
} from "../src/index.ts";

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(WEB_DIR, "../../..");

const { values: args } = parseArgs({ options: { songs: { type: "string" }, port: { type: "string" } } });

// Primary default songs folder
const DEFAULT_SONGS = path.resolve(REPO_ROOT, "songs");
fs.mkdirSync(DEFAULT_SONGS, { recursive: true });

// Persistent roots remembered across restarts
const KNOWN_ROOTS_FILE = path.join(REPO_ROOT, ".known-roots.json");
let persistentRoots: string[] = [];
try {
  if (fs.existsSync(KNOWN_ROOTS_FILE)) {
    const raw: unknown = JSON.parse(fs.readFileSync(KNOWN_ROOTS_FILE, "utf8"));
    if (Array.isArray(raw)) persistentRoots = raw.filter((r): r is string => typeof r === "string" && fs.existsSync(r));
  }
} catch {}


// CLI and ENV roots
const cliRoots: string[] = [];
const songsInput = args.songs ?? process.env.SONGS_DIR;
if (songsInput) {
  for (const part of songsInput.split(/[;,]/)) {
    const trimmed = part.trim();
    if (trimmed && fs.existsSync(trimmed)) cliRoots.push(path.resolve(trimmed));
  }
}

const ROOT_LIST = Array.from(new Set([...cliRoots, ...persistentRoots, DEFAULT_SONGS]));
const PRIMARY_SONGS = cliRoots[0] ?? DEFAULT_SONGS;
const PORT = args.port !== undefined ? Number(args.port) : 3000;
if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`--port must be a port number, got "${args.port}".`);

/** The Node request as a fetch Request, so `.json()` and `.formData()` (file uploads) parse it. The body is read fully first. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const chunks: Uint8Array[] = [];
  for await (const c of req) chunks.push(c);
  return new Request(`http://localhost${req.url ?? "/"}`, { method: req.method, headers, body: Buffer.concat(chunks) });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

const fail = (res: ServerResponse, status: number, e: unknown) =>
  send(res, status, { error: "FAILED", message: e instanceof Error ? e.message : String(e) });

const isLanguage = (v: unknown): v is "en" | "ja" => v === "en" || v === "ja";
const sortedDictCache: Partial<Record<"en" | "ja", string[]>> = {};
function getSortedWords(lang: "en" | "ja"): string[] {
  let list = sortedDictCache[lang];
  if (!list) {
    const g2p = dictionaryG2P(lang);
    const dictMap = (g2p as unknown as { dictionary: Map<string, string[]> }).dictionary;
    list = dictMap ? Array.from(dictMap.keys()).filter((w) => !w.includes("(")).sort() : [];
    sortedDictCache[lang] = list;
  }
  return list;
}

const localApi: Plugin = {
  name: "lyricsync-local-api",
  configureServer(server) {
    server.middlewares.use("/api/config", (req, res) => {
      if (req.method !== "GET") return send(res, 405, { error: "METHOD", message: "GET only" });
      send(res, 200, { songsDir: PRIMARY_SONGS, roots: ROOT_LIST });
    });

    server.middlewares.use("/api/realign", async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { error: "METHOD", message: "POST only" });
      try {
        const r = await handleRealign(ROOT_LIST, await (await toRequest(req)).json());
        send(res, r.status, r.body);
      } catch (e: unknown) {
        fail(res, 500, e);
      }
    });

    server.middlewares.use("/api/library/add", async (req, res) => {
      if (req.method !== "POST") return send(res, 405, { error: "METHOD", message: "POST only" });
      try {
        const body: unknown = await (await toRequest(req)).json();
        if (!isRecord(body) || typeof body.path !== "string") {
          return send(res, 400, { error: "BAD_REQUEST", message: "Needs path string." });
        }
        const resolved = path.resolve(body.path);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return send(res, 404, { error: "NOT_FOUND", message: `Folder not found: ${resolved}` });
        }
        if (!ROOT_LIST.includes(resolved)) {
          ROOT_LIST.unshift(resolved);
          persistentRoots = Array.from(new Set([resolved, ...persistentRoots]));
          try { fs.writeFileSync(KNOWN_ROOTS_FILE, JSON.stringify(persistentRoots, null, 2), "utf8"); } catch {}
        }
        return send(res, 200, { ok: true, path: resolved, roots: ROOT_LIST });
      } catch (e: unknown) {
        fail(res, 500, e);
      }
    });

    server.middlewares.use("/api/project/verify", async (req, res) => {
      try {
        const url = new URL(`http://localhost${req.url ?? "/"}`);
        const p = url.searchParams.get("path");
        if (!p) return send(res, 400, { error: "BAD_REQUEST", message: "Needs path query param." });
        const dir = findSongDir(ROOT_LIST, p);
        if (!dir) return send(res, 404, { error: "NOT_FOUND", message: `Song folder "${p}" not found.` });
        if (!ROOT_LIST.includes(dir)) {
          ROOT_LIST.unshift(dir);
          persistentRoots = Array.from(new Set([dir, ...persistentRoots]));
          try { fs.writeFileSync(KNOWN_ROOTS_FILE, JSON.stringify(persistentRoots, null, 2), "utf8"); } catch {}
        }
        return send(res, 200, { ok: true, dir, name: path.basename(dir) });
      } catch (e: unknown) {
        fail(res, 500, e);
      }
    });

    server.middlewares.use("/api/wizard", async (req, res) => {
      const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
      const reanalysis = currentReanalyzeJob();
      if ((route === "POST /create" || route === "POST /resume") && reanalysis?.state === "running") {
        return send(res, 409, { error: "BUSY", message: `Re-analysis of ${reanalysis.project} is running. Wait for it to finish.` });
      }

      try {
        if (route === "GET /job") return send(res, 200, { job: currentJob() });
        if (route === "POST /check") {
          try {
            const body: unknown = await (await toRequest(req)).json();
            if (!isRecord(body) || typeof body.text !== "string" || !isLanguage(body.language)) {
              return send(res, 400, { error: "BAD_REQUEST", message: "Needs text and language." });
            }
            let prons: Pronunciations = {};
            try {
              prons = parsePronunciations(body.pronunciations ?? {}, body.language);
            } catch {}
            return send(res, 200, checkLyrics(body.text, body.language, prons));
          } catch (e: unknown) {
            return send(res, 200, {
              ok: false,
              issues: [],
              lines: 0,
              syllables: 0,
              sections: [],
              autoSplit: [],
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (route === "POST /pronounce") {
          const body: unknown = await (await toRequest(req)).json();
          if (!isRecord(body) || typeof body.input !== "string" || !isLanguage(body.language)) return send(res, 400, { error: "BAD_REQUEST", message: "Needs input and language." });
          try {
            return send(res, 200, { ok: true, phones: pronounceAs(body.input, body.language) });
          } catch (e: unknown) {
            return send(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (route === "GET /suggest") {
          const url = new URL(`http://localhost${req.url ?? "/"}`);
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
          const lang = url.searchParams.get("lang") ?? "en";
          if (!q) return send(res, 200, { query: q, suggestions: [] });
          const suggestions: Array<{ word: string; split: string; detail?: string }> = [];
          if (isLanguage(lang)) {
            let isDictWord = false;
            try {
              const exact = resolveSyllables({ w: q }, null, lang);
              isDictWord = true;
              if (exact.length > 1) suggestions.push({ word: q, split: exact.join("|") });
            } catch {}

            // If word is not in the dictionary, suggest the phoneme syntax automatically!
            if (!isDictWord && lang === "en") {
              const approxPhones = approximateEnglishPhonemes(q);
              if (approxPhones && approxPhones.length > 0) {
                // 1. Unsplit suggestion: word{phones} (no pipes in phonemes!)
                const unsplit = formatPhonemeSuggestion(q, approxPhones);
                suggestions.unshift({ word: q, split: unsplit, detail: "add phonemes" });

                // 2. Syllabled suggestion with matching pipes: syl|la|ble{ph1 | ph2}
                const vowels = approxPhones.filter((p) => EN_VOWEL_PHONES[p]);
                if (vowels.length > 1) {
                  try {
                    const syls = syllabifyEnglish(q, vowels);
                    if (syls.length > 1) {
                      const piped = formatPhonemeSuggestion(syls.join("|"), approxPhones);
                      suggestions.push({ word: q, split: piped, detail: "add syllables & phonemes" });
                    }
                  } catch {}
                }
              }
            }
            // Fast binary search on pre-sorted dictionary words
            const sortedWords = getSortedWords(lang);
            let low = 0, high = sortedWords.length;
            while (low < high) {
              const mid = (low + high) >> 1;
              if (sortedWords[mid]! < q) low = mid + 1;
              else high = mid;
            }
            for (let i = low; i < sortedWords.length && sortedWords[i]!.startsWith(q) && suggestions.length < 30; i++) {
              const w = sortedWords[i]!;
              if (w !== q && w.length <= q.length + 14) {
                try {
                  const syl = resolveSyllables({ w }, null, lang);
                  if (syl.length > 1) suggestions.push({ word: w, split: syl.join("|") });
                } catch {}
              }
            }
          }
          return send(res, 200, { query: q, suggestions });
        }
        if (route === "POST /create") {
          const form = await (await toRequest(req)).formData();
          const id = form.get("id");
          const language = form.get("language");
          const lyrics = form.get("lyrics");
          const mix = form.get("mix");
          const vocal = form.get("vocal");
          const downbeat = form.get("firstDownbeat");
          const pronunciations = form.get("pronunciations");
          if (typeof id !== "string" || !isLanguage(language) || typeof lyrics !== "string" || typeof pronunciations !== "string" || !(mix instanceof File) || !(vocal instanceof File)) {
            return send(res, 400, { error: "BAD_REQUEST", message: "Needs id, language, lyrics, pronunciations, mix and vocal." });
          }
          try {
            await createSong(PRIMARY_SONGS, {
              id,
              language,
              bpm: Number(form.get("bpm")),
              firstDownbeat: typeof downbeat === "string" && downbeat.trim() !== "" ? Number(downbeat) : null,
              lyrics,
              pronunciations: parsePronunciations(JSON.parse(pronunciations), language),
              mix,
              vocal,
            });
          } catch (e: unknown) {
            return fail(res, 422, e);
          }
          return send(res, 202, { job: currentJob() });
        }
        if (route === "POST /resume") {
          const body: unknown = await (await toRequest(req)).json();
          if (!isRecord(body) || typeof body.id !== "string") return send(res, 400, { error: "BAD_REQUEST", message: "Needs id." });
          try {
            resumeSong(ROOT_LIST, body.id);
          } catch (e: unknown) {
            return fail(res, 422, e);
          }
          return send(res, 202, { job: currentJob() });
        }
        send(res, 404, { error: "NOT_FOUND", message: route });
      } catch (e: unknown) {
        fail(res, 500, e);
      }
    });

    server.middlewares.use("/api/project", async (req, res) => {
      const raw = (req.url ?? "/").split("?")[0]!;
      const m = /^\/([^/]+)\/file\/(.+)$/.exec(raw);
      if (!m) return send(res, 404, { error: "NOT_FOUND", message: req.url });
      const id = decodeURIComponent(m[1]!);
      const rel = decodeURIComponent(m[2]!);
      try {
        if (req.method === "GET" || req.method === "HEAD") {
          const { file, mtimeMs } = readProjectFile(ROOT_LIST, id, rel);
          res.statusCode = 200;
          res.setHeader("X-Mtime-Ms", String(mtimeMs));
          res.setHeader("Cache-Control", "no-store");
          res.end(req.method === "GET" ? Buffer.from(await Bun.file(file).arrayBuffer()) : undefined);
          return;
        }
        if (req.method === "PUT") {
          const body = new Uint8Array(await (await toRequest(req)).arrayBuffer());
          return send(res, 200, writeProjectFile(ROOT_LIST, id, rel, body));
        }
        send(res, 405, { error: "METHOD", message: "GET or PUT" });
      } catch (e: unknown) {
        if (e instanceof ProjectFileError) return send(res, e.status, { error: "FILE", message: e.message });
        fail(res, 500, e);
      }
    });

    server.middlewares.use("/api/lyrics", async (req, res) => {
      const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
      const m = /^(GET|POST) \/([^/]+)\/(splits|reanalyze|update)$/.exec(route);
      try {
        if (route === "GET /job") return send(res, 200, { job: currentReanalyzeJob() });
        if (m?.[1] === "GET" && m[3] === "splits") {
          try {
            return send(res, 200, analysedSplits(ROOT_LIST, decodeURIComponent(m[2]!)));
          } catch (e: unknown) {
            return send(res, 404, { error: "NOT_FOUND", message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (m?.[1] === "POST" && m[3] === "reanalyze") {
          const body: unknown = await (await toRequest(req)).json();
          if (!isRecord(body)) return send(res, 400, { error: "BAD_REQUEST", message: "Needs lines." });
          const build = currentJob();
          try {
            const job = reanalyze(ROOT_LIST, decodeURIComponent(m[2]!), parseSplitLines(body.lines), build?.state === "running" ? `The build of ${build.project} is running. Wait for it to finish.` : null);
            return send(res, 202, { job });
          } catch (e: unknown) {
            return fail(res, 422, e);
          }
        }
        if (m?.[1] === "POST" && m[3] === "update") {
          const body: unknown = await (await toRequest(req)).json();
          if (!isRecord(body) || typeof body.text !== "string") {
            return send(res, 400, { error: "BAD_REQUEST", message: "Needs text." });
          }
          const build = currentJob();
          try {
            const prons = isRecord(body.pronunciations) ? parsePronunciations(body.pronunciations, "en") : undefined;
            const job = updateLyrics(
              ROOT_LIST,
              decodeURIComponent(m[2]!),
              { text: body.text, pronunciations: prons },
              build?.state === "running" ? `The build of ${build.project} is running. Wait for it to finish.` : null
            );
            return send(res, 202, { job });
          } catch (e: unknown) {
            return fail(res, 422, e);
          }
        }
      } catch (e: unknown) {
        fail(res, 500, e);
      }
    });
  },
};

const server = await createServer({ root: WEB_DIR, configFile: path.join(WEB_DIR, "vite.config.ts"), plugins: [localApi], server: { port: PORT } });
await server.listen();
server.printUrls();
console.log(`  songs folders: ${ROOT_LIST.join(", ")}`);
