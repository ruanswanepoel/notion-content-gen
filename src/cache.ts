import fs from "fs";
import path from "path";

const CACHE_VERSION = 1;
const DEFAULT_CACHE_FILE = ".notion-content-gen-cache.json";

export type CacheEntry = {
  lastEditedTime: string;
  filePath: string;
};

export type CacheData = {
  version: number;
  pages: Record<string, CacheEntry>;
};

export function emptyCache(): CacheData {
  return { version: CACHE_VERSION, pages: {} };
}

export function resolveCachePath(
  cache: boolean | string | undefined,
  cwd: string = process.cwd(),
): string | null {
  if (cache === false) return null;
  if (typeof cache === "string") return path.resolve(cwd, cache);
  return path.resolve(cwd, DEFAULT_CACHE_FILE);
}

export function loadCache(cachePath: string | null): CacheData {
  if (!cachePath || !fs.existsSync(cachePath)) return emptyCache();
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (raw?.version !== CACHE_VERSION || typeof raw.pages !== "object") {
      return emptyCache();
    }
    return raw as CacheData;
  } catch {
    return emptyCache();
  }
}

export function saveCache(
  cachePath: string | null,
  cache: CacheData,
): void {
  if (!cachePath) return;
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}
