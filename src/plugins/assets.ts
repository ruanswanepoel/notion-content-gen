import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type {
  AudioBlockObjectResponse,
  FileBlockObjectResponse,
  ImageBlockObjectResponse,
  PdfBlockObjectResponse,
  RichTextItemResponse,
  VideoBlockObjectResponse,
} from "@notionhq/client";
import type { Logger } from "../logger.js";
import type { Plugin } from "../types.js";
import type { PageNode } from "../page_node.js";
import { slugify } from "../util.js";
import { withRetry } from "../retry.js";

/** Notion block types whose content is a downloadable media asset. */
export type AssetBlockType = "image" | "file" | "pdf" | "video" | "audio";

/** How the on-disk filename for a downloaded asset is derived. */
export type AssetNaming = "blockId" | "urlHash" | "original";

export type AssetsPluginOptions = {
  /**
   * Directory (relative to cwd) where downloaded bytes land. Created on
   * demand. Defaults to `"public/notion-assets"`.
   */
  outputDir?: string;
  /**
   * What the rewritten markdown reference points at. When set, references
   * become `${publicPath}/<file>` (use a leading-slash absolute path or a full
   * CDN base URL). When omitted, a path relative to each page's output file is
   * computed instead, keeping the output tree portable.
   */
  publicPath?: string;
  /**
   * Also download `external` (permanent, non-Notion) URLs. When `false`
   * (default), external references are left inline and untouched.
   */
  includeExternal?: boolean;
  /**
   * Which block types to handle. Defaults to all of
   * `["image", "file", "pdf", "video", "audio"]`.
   */
  blockTypes?: AssetBlockType[];
  /**
   * Maximum concurrent downloads. Independent of the tree-build concurrency.
   * Defaults to 4.
   */
  concurrency?: number;
  /**
   * Filename strategy. Defaults to `"blockId"` (stable across runs, so re-runs
   * skip re-downloading and the incremental cache stays warm).
   *
   * - `"blockId"` — `<block-id><ext>`; stable regardless of the expiring URL.
   * - `"urlHash"` — hash of the URL *path* (query string dropped) + `<ext>`.
   * - `"original"` — the Notion filename, de-duped with a short block-id
   *   fragment on collision.
   */
  naming?: AssetNaming;
  /** Override the plugin name (used in stack traces and logging). */
  name?: string;
};

// Sentinel wrapping a resolved asset filename, emitted by the block
// transformers when running in relative-path mode. The `transform` hook
// rewrites each occurrence to a path relative to the owning page's output
// file — the transformer itself can't see the node, only the block.
const REL_MARKER_RE = /%%NCG_ASSET:([^%]+)%%/g;
const relMarker = (filename: string) => `%%NCG_ASSET:${filename}%%`;

const DEFAULT_BLOCK_TYPES: AssetBlockType[] = [
  "image",
  "file",
  "pdf",
  "video",
  "audio",
];

type MediaBlock =
  | ImageBlockObjectResponse
  | FileBlockObjectResponse
  | PdfBlockObjectResponse
  | VideoBlockObjectResponse
  | AudioBlockObjectResponse;

/**
 * Downloads Notion-hosted images and files (served behind signed, expiring S3
 * URLs) to disk and rewrites the markdown references to durable local paths —
 * or to a user-supplied CDN base — so generated output is self-contained and
 * safe to host statically.
 *
 * Block rewriting is done with `notion-to-md` custom transformers registered
 * in `setup` (the same pattern `mdx-blocks` uses): the transformer sees the
 * fully-typed block with its unescaped URL, downloads the bytes, and returns
 * the replacement markdown. No new core hook is required.
 *
 * ## Known limitations
 * - **Icons & covers** live on the page object, not in the block stream, so
 *   they are out of scope for this plugin and left untouched.
 * - **Orphaned assets**: core cleanup only tracks page output files, so assets
 *   for deleted/renamed pages accumulate in `outputDir`. Periodically wipe
 *   `outputDir` for a clean rebuild.
 * - **Unchanged pages** skip markdown conversion (and therefore this
 *   transformer), so a hand-deleted asset won't be re-fetched until the page's
 *   `last_edited_time` changes. This mirrors how core skips unchanged writes.
 * - **Extensions** are inferred from the URL path; a URL with no extension in
 *   its path yields an extension-less filename.
 */
export function assetsPlugin(options: AssetsPluginOptions = {}): Plugin {
  const outputDir = options.outputDir ?? "public/notion-assets";
  const publicPath = options.publicPath;
  const includeExternal = options.includeExternal ?? false;
  const blockTypes = options.blockTypes ?? DEFAULT_BLOCK_TYPES;
  const naming: AssetNaming = options.naming ?? "blockId";

  const downloader = new AssetDownloader({
    outputDir,
    concurrency: options.concurrency ?? 4,
    naming,
  });

  const setup: NonNullable<Plugin["hooks"]>["setup"] = ({
    notion,
    dryRun,
    logger,
  }) => {
    downloader.dryRun = dryRun;
    downloader.logger = logger;
    for (const type of blockTypes) {
      notion.n2m.setCustomTransformer(type, async (block) => {
        const media = block as MediaBlock;
        if (media.type !== type) return false;
        return renderAsset(media, {
          type,
          includeExternal,
          publicPath,
          downloader,
        });
      });
    }
  };

  const hooks: NonNullable<Plugin["hooks"]> = { setup };
  // Resolve relative-path markers against each page's output file. Only needed
  // when `publicPath` is unset (relative mode) — otherwise the transformer
  // already emitted final references and no marker exists.
  if (!publicPath) {
    hooks.transform = (content, node) =>
      resolveRelativeMarkers(content, node, outputDir);
  }

  return { name: options.name ?? "assets", hooks };
}

type RenderContext = {
  type: AssetBlockType;
  includeExternal: boolean;
  publicPath: string | undefined;
  downloader: AssetDownloader;
};

async function renderAsset(
  media: MediaBlock,
  ctx: RenderContext,
): Promise<string | false> {
  const source = mediaSource(media);
  // External (permanent) URLs are left to n2m's default rendering unless the
  // caller opted in.
  if (source.external && !ctx.includeExternal) return false;

  const filename = await ctx.downloader.fetch(media.id, source.url);
  const ref = ctx.publicPath
    ? joinPublic(ctx.publicPath, filename)
    : relMarker(filename);

  const label = assetLabel(media);
  if (ctx.type === "image") return `![${label}](${ref})`;
  return `[${label || ctx.type}](${ref})`;
}

type MediaInner =
  | ImageBlockObjectResponse["image"]
  | FileBlockObjectResponse["file"];

/** The inner media object (`block.image`, `block.file`, …), typed as a union. */
function innerMedia(media: MediaBlock): MediaInner {
  switch (media.type) {
    case "image":
      return media.image;
    case "file":
      return media.file;
    case "pdf":
      return media.pdf;
    case "video":
      return media.video;
    case "audio":
      return media.audio;
  }
}

/** Extracts the URL and whether it's an external (non-Notion) reference. */
function mediaSource(media: MediaBlock): { url: string; external: boolean } {
  const inner = innerMedia(media);
  if (inner.type === "external") {
    return { url: inner.external.url, external: true };
  }
  return { url: inner.file.url, external: false };
}

/** Caption plain text, falling back to a file block's `name`. */
function assetLabel(media: MediaBlock): string {
  const inner = innerMedia(media);
  const caption = inner.caption
    .map((r: RichTextItemResponse) => r.plain_text)
    .join("")
    .trim();
  if (caption) return caption;
  return "name" in inner ? inner.name.trim() : "";
}

function resolveRelativeMarkers(
  content: string,
  node: PageNode,
  outputDir: string,
): string {
  if (!node.filePath) return content;
  const fromDir = path.dirname(path.resolve(node.filePath));
  return content.replace(REL_MARKER_RE, (_m, filename: string) => {
    const assetAbs = path.resolve(outputDir, filename);
    let rel = path.relative(fromDir, assetAbs).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  });
}

function joinPublic(base: string, filename: string): string {
  return `${base.replace(/\/+$/, "")}/${filename}`;
}

type DownloaderConfig = {
  outputDir: string;
  concurrency: number;
  naming: AssetNaming;
};

/**
 * Shared download queue: bounds concurrent fetches with its own semaphore,
 * de-dupes by resolved filename (an asset referenced from two pages downloads
 * once), and skips fetches whose target file is already on disk. In dry-run it
 * resolves filenames without touching the network or disk so `--dry-run`
 * previews the rewritten references correctly.
 */
class AssetDownloader {
  dryRun = false;
  logger: Logger | undefined;
  private readonly config: DownloaderConfig;
  private readonly semaphore: Semaphore;
  /** Resolved filename → in-flight/completed download promise. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Claimed filename → owning block id (for `"original"` collision de-dupe). */
  private readonly claimed = new Map<string, string>();

  constructor(config: DownloaderConfig) {
    this.config = config;
    this.semaphore = new Semaphore(Math.max(1, config.concurrency));
  }

  /**
   * Resolves the stable filename for `url`, ensures the bytes are on disk
   * (unless in dry-run or already present), and returns the filename.
   */
  async fetch(blockId: string, url: string): Promise<string> {
    const filename = this.resolveFilename(blockId, url);
    if (this.dryRun) return filename;

    let job = this.inFlight.get(filename);
    if (!job) {
      job = this.download(url, filename);
      this.inFlight.set(filename, job);
    }
    await job;
    return filename;
  }

  private resolveFilename(blockId: string, url: string): string {
    const ext = extensionFromUrl(url);
    if (this.config.naming === "blockId") {
      return `${blockId.replace(/-/g, "")}${ext}`;
    }
    if (this.config.naming === "urlHash") {
      const hash = createHash("sha256")
        .update(urlPath(url))
        .digest("hex")
        .slice(0, 16);
      return `${hash}${ext}`;
    }
    return this.reserveOriginalName(blockId, url, ext);
  }

  /**
   * `"original"` naming keeps the Notion filename but must stay unique: two
   * different assets both named `diagram.png` can't share a file. The first
   * block to claim a name wins; a later block with a *different* id gets a
   * short id fragment appended. The same block re-claiming its own name is a
   * no-op (so repeated references de-dupe to one download).
   */
  private reserveOriginalName(blockId: string, url: string, ext: string): string {
    const raw = path.basename(urlPath(url));
    const dot = raw.lastIndexOf(".");
    const base = dot > 0 ? raw.slice(0, dot) : raw;
    const slug = slugify(base) || "asset";
    const frag = blockId.replace(/-/g, "").slice(0, 8);

    let candidate = `${slug}${ext}`;
    let attempt = 0;
    while (true) {
      const owner = this.claimed.get(candidate);
      if (!owner || owner === blockId) {
        this.claimed.set(candidate, blockId);
        return candidate;
      }
      attempt++;
      candidate = `${slug}-${frag}${attempt > 1 ? `-${attempt}` : ""}${ext}`;
    }
  }

  private async download(url: string, filename: string): Promise<void> {
    const dest = path.join(this.config.outputDir, filename);
    if (fs.existsSync(dest)) {
      this.logger?.debug(`asset exists, skipping download: ${dest}`);
      return;
    }
    await this.semaphore.run(async () => {
      // Re-check inside the critical section: a concurrent job for the same
      // filename may have written it while we were queued.
      if (fs.existsSync(dest)) return;
      const bytes = await downloadBytes(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      this.logger?.debug(`asset downloaded: ${dest}`);
    });
  }
}

/** Retry-classified HTTP failure so `withRetry` knows the download is worth a retry. */
class HttpRetryError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`Retryable HTTP status ${status}`);
    this.name = "HttpRetryError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function downloadBytes(url: string): Promise<Buffer> {
  const res = await withRetry(
    async () => {
      const response = await fetch(url);
      if (response.status === 429 || response.status >= 500) {
        throw new HttpRetryError(
          response.status,
          parseHeaderRetryAfter(response.headers.get("retry-after")),
        );
      }
      if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
      }
      return response;
    },
    { isRetryable: isRetryableFetch, retryAfterMs: fetchRetryAfterMs },
  );
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function isRetryableFetch(err: unknown): boolean {
  if (err instanceof HttpRetryError) return true;
  const code =
    (err as { code?: string } | null)?.code ??
    (err as { cause?: { code?: string } } | null)?.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

function fetchRetryAfterMs(err: unknown): number | null {
  return err instanceof HttpRetryError ? err.retryAfterMs : null;
}

function parseHeaderRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber * 1000;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/** Path portion of a URL, query string and hash stripped. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
  }
}

/** Lowercased extension (with leading dot) from a URL's path, or "" if none. */
function extensionFromUrl(url: string): string {
  const ext = path.extname(urlPath(url)).toLowerCase();
  // Guard against a "." with no alnum extension or an absurdly long match.
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** Minimal counting semaphore for bounding concurrent downloads. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
