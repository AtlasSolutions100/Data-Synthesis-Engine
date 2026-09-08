/**
 * Load a repo-root `.env` into process.env for local / non-Replit hosting.
 *
 * - Uses Node's built-in `process.loadEnvFile` (Node ≥ 21.7), so there is no
 *   dotenv dependency.
 * - Variables already in the environment win: `loadEnvFile` never overrides
 *   an existing key, which is exactly what keeps Replit Secrets (or a hosting
 *   dashboard) authoritative when both exist.
 * - Walks up from the working directory AND from this file's location, so it
 *   works whether the server is started from the repo root, from
 *   `artifacts/api-server`, or from the bundled `dist/index.mjs`.
 * - Silent when no `.env` exists — production hosts inject env directly.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function candidates(): string[] {
  const starts = [process.cwd()];
  try {
    starts.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // Not an ES module context (e.g. CJS test bundle) — cwd alone is fine.
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, ".env");
      if (!seen.has(file)) {
        seen.add(file);
        out.push(file);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return out;
}

export function loadRootEnvFile(): string | null {
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void })
    .loadEnvFile;
  if (typeof loader !== "function") return null;
  for (const file of candidates()) {
    if (!existsSync(file)) continue;
    try {
      loader.call(process, file);
      return file;
    } catch {
      // Unreadable or malformed file: fall through and keep looking.
    }
  }
  return null;
}

loadRootEnvFile();
