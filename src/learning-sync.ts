/**
 * Learning Sync — Phase 1 of Claw-to-Claw collaboration.
 *
 * Synchronises OpenClaw workspace memory files (workspace/memory/YYYY-MM-DD.md)
 * between two gateway instances via A2A.
 *
 * Strategy:
 *  - Each side exposes a manifest (file list with hashes).
 *  - Sync compares manifests, fetches missing/updated files from the peer.
 *  - Same-day files are merged by appending new sections (append-only, never overwrite).
 *  - Conflicts on the same section header are kept with source tags.
 *  - After merge, each side can `openclaw memory index` to rebuild the search index.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { MemoryQueryMatch } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFileEntry {
  /** Relative path, e.g. "2026-03-13.md" */
  name: string;
  /** SHA-256 hex of file content */
  hash: string;
  /** File size in bytes */
  size: number;
  /** Last modified timestamp (epoch ms) */
  mtime: number;
}

export interface LearningSyncConfig {
  /** Absolute path to workspace/memory directory */
  memoryDir: string;
  /** Instance name used as source tag when merging */
  instanceName: string;
  /** Auto-sync interval in seconds (0 = disabled) */
  autoSyncIntervalSeconds: number;
  /** Exact filenames to exclude from learning sync (manifest, fetch, search) */
  excludeFiles?: string[];
}

/** A section parsed from a daily memory file. */
interface MemorySection {
  /** The full header line (e.g. "## 2026-03-13 00:38 UTC") */
  header: string;
  /** Lines below the header (excluding trailing blank lines) */
  body: string[];
  /** Normalised key for dedup: lowercase trimmed header text */
  key: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function isMemoryFile(name: string): boolean {
  // Match: 2026-03-13.md, 2026-03-13.summary.md, 2026-03-08-0744.md, 2026-03-08-greeting-check.md
  return /^\d{4}-\d{2}-\d{2}[\w.-]*\.md$/.test(name);
}

/** Parse a markdown memory file into sections (split on ## headers). */
function parseSections(content: string): MemorySection[] {
  const lines = content.split("\n");
  const sections: MemorySection[] = [];
  let current: MemorySection | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = {
        header: line,
        body: [],
        key: line.slice(3).trim().toLowerCase(),
      };
    } else if (current) {
      current.body.push(line);
    }
    // Lines before the first ## header are ignored (rare in memory files)
  }
  if (current) sections.push(current);

  // Trim trailing empty lines from each section body
  for (const sec of sections) {
    while (sec.body.length > 0 && sec.body[sec.body.length - 1].trim() === "") {
      sec.body.pop();
    }
  }

  return sections;
}

/**
 * Merge format version.  Both sides include this in their manifest response.
 * When both sides report the same version, block-level merge with source
 * attribution is used.  When versions differ (or the peer has no version),
 * we fall back to line-level dedup without source tags for safety.
 */
export const MERGE_VERSION = 3;

const SOURCE_TAG_RE = /^<!--\s*source:\s*(.+?)\s*-->$/;

/**
 * Strip all source tags from a body, returning only content lines.
 */
function stripSourceTags(body: string[]): string[] {
  return body.filter((line) => !SOURCE_TAG_RE.test(line));
}

/**
 * Normalise block content for dedup comparison.
 * Trims each line, collapses multiple blank lines, and trims the result.
 */
function normalizeContent(content: string): string {
  return content
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract content blocks from a section body, stripping source tags.
 * Consecutive source tags are collapsed (only the last one before actual
 * content becomes that block's source).  Empty blocks are discarded.
 *
 * Blocks without an explicit source tag are attributed to "shared" so that
 * both sides produce the same attribution for untagged content.
 */
function extractBlocks(
  body: string[],
  _defaultSource: string,
): Array<{ source: string; content: string }> {
  const blocks: Array<{ source: string; lines: string[] }> = [];
  let currentSource = "shared";
  let currentLines: string[] = [];

  for (const line of body) {
    const m = line.match(SOURCE_TAG_RE);
    if (m) {
      // Flush previous block only if it has content
      if (currentLines.length > 0) {
        blocks.push({ source: currentSource, lines: currentLines });
        currentLines = [];
      }
      currentSource = m[1].toLowerCase();
    } else if (line.trim() === "" && currentLines.length > 0) {
      // Blank line acts as a block boundary for untagged content.
      // This prevents entire section bodies from becoming a single giant
      // block that defeats normalizeContent-based dedup.
      blocks.push({ source: currentSource, lines: currentLines });
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    blocks.push({ source: currentSource, lines: currentLines });
  }

  return blocks
    .map((b) => ({ source: b.source, content: b.lines.join("\n").trim() }))
    .filter((b) => b.content.length > 0);
}

/**
 * Merge two sets of sections — block-level with source attribution.
 * Used when both sides run MERGE_VERSION >= 3.
 *
 * v3 changes vs v2:
 *  - Untagged blocks use source "shared" (not local instanceName) so both
 *    sides produce identical output.
 *  - Dedup uses normalizeContent() to collapse near-duplicates that differ
 *    only in whitespace or trailing test lines.
 *  - "shared" blocks are emitted without a source tag.
 */
function mergeSectionsV2(
  localSections: MemorySection[],
  remoteSections: MemorySection[],
  localName: string,
  remoteName: string,
): MemorySection[] {
  const merged: MemorySection[] = [];
  const usedRemote = new Set<number>();

  for (const local of localSections) {
    const remoteIdx = remoteSections.findIndex(
      (r, i) => !usedRemote.has(i) && r.key === local.key,
    );

    if (remoteIdx === -1) {
      merged.push(local);
    } else {
      usedRemote.add(remoteIdx);
      const remote = remoteSections[remoteIdx];

      // Extract blocks, stripping any pre-existing source tags
      const localBlocks = extractBlocks(local.body, localName.toLowerCase());
      const remoteBlocks = extractBlocks(remote.body, remoteName.toLowerCase());

      // Dedup by normalised content — near-duplicates collapse.
      // When the same content exists with different sources, pick the
      // alphabetically-first source so both sides converge deterministically.
      const seen = new Map<string, number>(); // normalised key → index
      const uniqueBlocks: Array<{ source: string; content: string }> = [];
      for (const block of [...localBlocks, ...remoteBlocks]) {
        const key = normalizeContent(block.content);
        const existingIdx = seen.get(key);
        if (existingIdx == null) {
          seen.set(key, uniqueBlocks.length);
          uniqueBlocks.push(block);
        } else {
          // Keep the alphabetically-first source for determinism
          const existing = uniqueBlocks[existingIdx];
          if (block.source.localeCompare(existing.source) < 0) {
            uniqueBlocks[existingIdx] = { source: block.source, content: existing.content };
          }
        }
      }

      // Sort by normalised content for deterministic output on both sides
      uniqueBlocks.sort((a, b) =>
        normalizeContent(a.content).localeCompare(normalizeContent(b.content)),
      );

      if (uniqueBlocks.length === 1) {
        merged.push({
          header: local.header,
          body: uniqueBlocks[0].content.split("\n"),
          key: local.key,
        });
      } else {
        const body: string[] = [];
        for (let i = 0; i < uniqueBlocks.length; i++) {
          if (i > 0) body.push("");
          // Only write source tags for blocks with real attribution
          if (uniqueBlocks[i].source !== "shared") {
            body.push(`<!-- source: ${uniqueBlocks[i].source} -->`);
          }
          body.push(...uniqueBlocks[i].content.split("\n"));
        }
        merged.push({ header: local.header, body, key: local.key });
      }
    }
  }

  for (let i = 0; i < remoteSections.length; i++) {
    if (!usedRemote.has(i)) merged.push(remoteSections[i]);
  }
  return merged;
}

/**
 * Merge two sets of sections — line-level dedup, no source tags.
 * Safe fallback when peer runs an older merge version.
 */
function mergeSectionsV1(
  localSections: MemorySection[],
  remoteSections: MemorySection[],
): MemorySection[] {
  const merged: MemorySection[] = [];
  const usedRemote = new Set<number>();

  for (const local of localSections) {
    const remoteIdx = remoteSections.findIndex(
      (r, i) => !usedRemote.has(i) && r.key === local.key,
    );

    if (remoteIdx === -1) {
      merged.push({
        header: local.header,
        body: stripSourceTags(local.body),
        key: local.key,
      });
    } else {
      usedRemote.add(remoteIdx);
      const remote = remoteSections[remoteIdx];

      const seen = new Set<string>();
      const unionLines: string[] = [];
      for (const line of [...stripSourceTags(local.body), ...stripSourceTags(remote.body)]) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && !seen.has(trimmed)) {
          seen.add(trimmed);
          unionLines.push(trimmed);
        }
      }
      unionLines.sort();
      merged.push({ header: local.header, body: unionLines, key: local.key });
    }
  }

  for (let i = 0; i < remoteSections.length; i++) {
    if (!usedRemote.has(i)) {
      const sec = remoteSections[i];
      merged.push({
        header: sec.header,
        body: stripSourceTags(sec.body),
        key: sec.key,
      });
    }
  }
  return merged;
}

/**
 * Dispatch to the appropriate merge strategy based on peer version.
 * v3+ → mergeSectionsV2 (block-level with normalised dedup)
 * v2  → mergeSectionsV2 (still compatible, just lacks normalised dedup on peer)
 * v1/unknown → mergeSectionsV1 (line-level)
 */
function mergeSections(
  localSections: MemorySection[],
  remoteSections: MemorySection[],
  localName: string,
  remoteName: string,
  peerMergeVersion?: number,
): MemorySection[] {
  if (peerMergeVersion != null && peerMergeVersion >= 2) {
    return mergeSectionsV2(localSections, remoteSections, localName, remoteName);
  }
  return mergeSectionsV1(localSections, remoteSections);
}

function sectionsToString(sections: MemorySection[]): string {
  // Sort sections chronologically by header to ensure deterministic output
  // regardless of which side initiates the merge.
  const sorted = [...sections].sort((a, b) => a.header.localeCompare(b.header));
  return sorted
    .map((s) => [s.header, ...s.body].join("\n"))
    .join("\n\n")
    + "\n";
}

// ---------------------------------------------------------------------------
// Recall filter — files that must NEVER appear in memory query results
// ---------------------------------------------------------------------------

const RECALL_FILTER_FILE_PATTERNS: RegExp[] = [
  /auth-profiles?\.json/i,
  /\.env$/i,
  /gateway\.env/i,
  /credentials?\.json/i,
  /secrets?\.json/i,
];

function isSafeForRecall(fileName: string): boolean {
  return !RECALL_FILTER_FILE_PATTERNS.some((re) => re.test(fileName));
}

// ---------------------------------------------------------------------------
// LearningSyncManager
// ---------------------------------------------------------------------------

export class LearningSyncManager {
  private readonly config: LearningSyncConfig;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

  constructor(
    config: LearningSyncConfig,
    logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
  ) {
    this.config = config;
    this.logger = logger || {
      info: (msg: string) => console.log(`[learning-sync] ${msg}`),
      warn: (msg: string) => console.warn(`[learning-sync] ${msg}`),
      error: (msg: string) => console.error(`[learning-sync] ${msg}`),
    };
  }

  private isExcluded(name: string): boolean {
    return Array.isArray(this.config.excludeFiles) && this.config.excludeFiles.includes(name);
  }

  /** Ensure memory directory exists. */
  private ensureDir(): void {
    if (!fs.existsSync(this.config.memoryDir)) {
      fs.mkdirSync(this.config.memoryDir, { recursive: true });
    }
  }

  /** Get manifest of all local memory files. */
  getManifest(): MemoryFileEntry[] {
    this.ensureDir();
    const entries: MemoryFileEntry[] = [];

    for (const name of fs.readdirSync(this.config.memoryDir)) {
      if (!isMemoryFile(name)) continue;
      if (this.isExcluded(name)) continue;
      const fullPath = path.join(this.config.memoryDir, name);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      entries.push({
        name,
        hash: hashContent(content),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read a specific memory file by name. Returns null if not found. */
  readFile(name: string): string | null {
    if (!isMemoryFile(name)) return null;
    if (this.isExcluded(name)) return null;
    const fullPath = path.join(this.config.memoryDir, name);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, "utf8");
  }

  /**
   * Receive a memory file from a peer and merge it with the local copy.
   * Returns { action: "created" | "merged" | "unchanged", conflicts: number }
   */
  receiveFile(
    name: string,
    content: string,
    remoteName: string,
    peerMergeVersion?: number,
  ): { action: "created" | "merged" | "unchanged"; conflicts: number } {
    if (!isMemoryFile(name)) {
      return { action: "unchanged", conflicts: 0 };
    }

    this.ensureDir();
    const fullPath = path.join(this.config.memoryDir, name);

    if (!fs.existsSync(fullPath)) {
      // New file — just write it
      fs.writeFileSync(fullPath, content, "utf8");
      this.logger.info(`created ${name} from ${remoteName}`);
      return { action: "created", conflicts: 0 };
    }

    const localContent = fs.readFileSync(fullPath, "utf8");
    if (hashContent(localContent) === hashContent(content)) {
      return { action: "unchanged", conflicts: 0 };
    }

    // Merge
    const localSections = parseSections(localContent);
    const remoteSections = parseSections(content);
    const merged = mergeSections(
      localSections,
      remoteSections,
      this.config.instanceName,
      remoteName,
      peerMergeVersion,
    );

    // Count conflicts (sections with both source tags)
    let conflicts = 0;
    for (const sec of merged) {
      const bodyText = sec.body.join("\n");
      if (
        bodyText.includes(`<!-- source: ${this.config.instanceName} -->`) &&
        bodyText.includes(`<!-- source: ${remoteName} -->`)
      ) {
        conflicts++;
      }
    }

    const mergedContent = sectionsToString(merged);

    // Only write if content actually changed
    if (hashContent(mergedContent) === hashContent(localContent)) {
      return { action: "unchanged", conflicts: 0 };
    }

    // Safety valve: reject merge if result is unreasonably larger than inputs
    const maxInputSize = Math.max(localContent.length, content.length);
    if (mergedContent.length > maxInputSize * 3 && mergedContent.length > 100_000) {
      this.logger.warn(
        `merge of ${name} rejected: result ${(mergedContent.length / 1024).toFixed(0)}KB ` +
        `exceeds 3x largest input ${(maxInputSize / 1024).toFixed(0)}KB — possible dedup failure`,
      );
      return { action: "unchanged", conflicts: 0 };
    }

    fs.writeFileSync(fullPath, mergedContent, "utf8");
    this.logger.info(
      `merged ${name} from ${remoteName} (${conflicts} conflict${conflicts !== 1 ? "s" : ""})`,
    );

    return { action: "merged", conflicts };
  }

  /**
   * Compare local manifest against a remote manifest.
   * Returns files that need to be fetched from the remote.
   */
  diffManifest(
    remoteManifest: MemoryFileEntry[],
  ): { toFetch: string[]; toSend: string[] } {
    const localManifest = this.getManifest();
    const localMap = new Map(localManifest.map((e) => [e.name, e]));
    const remoteMap = new Map(remoteManifest.map((e) => [e.name, e]));

    const toFetch: string[] = [];
    const toSend: string[] = [];

    // Files on remote but not local, or different hash
    for (const [name, remote] of remoteMap) {
      const local = localMap.get(name);
      if (!local || local.hash !== remote.hash) {
        toFetch.push(name);
      }
    }

    // Files on local but not remote, or different hash
    for (const [name, local] of localMap) {
      const remote = remoteMap.get(name);
      if (!remote || remote.hash !== local.hash) {
        toSend.push(name);
      }
    }

    return { toFetch, toSend };
  }

  /**
   * Search local memory files for content matching a query.
   * Returns matched sections ranked by relevance (simple term-frequency scoring).
   * For complex semantic queries, use Phase 2 delegation instead.
   */
  search(opts: {
    query: string;
    date?: string;
    filePattern?: string;
    maxResults?: number;
    maxTotalChars?: number;
    knownHashes?: string[];
  }): { matches: MemoryQueryMatch[]; totalFound: number; truncated: boolean } {
    this.ensureDir();
    const maxResults = opts.maxResults || 10;
    const maxTotalChars = opts.maxTotalChars || 8000;

    const queryTerms = opts.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);

    if (queryTerms.length === 0) {
      return { matches: [], totalFound: 0, truncated: false };
    }

    const knownHashSet = new Set(opts.knownHashes || []);
    const allMatches: MemoryQueryMatch[] = [];

    for (const name of fs.readdirSync(this.config.memoryDir)) {
      if (!isMemoryFile(name)) continue;
      if (!isSafeForRecall(name)) continue;
      if (this.isExcluded(name)) continue;

      // Date filter
      if (opts.date && !name.startsWith(opts.date)) continue;

      // File pattern filter (simple glob: * → .*)
      if (opts.filePattern) {
        const pattern = opts.filePattern.replace(/\*/g, ".*");
        if (!new RegExp(`^${pattern}$`).test(name)) continue;
      }

      const fullPath = path.join(this.config.memoryDir, name);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(fullPath, "utf8");

      // Skip files whose hash is already known to the caller
      if (knownHashSet.size > 0 && knownHashSet.has(hashContent(content))) continue;

      const sections = parseSections(content);

      for (const section of sections) {
        const bodyText = section.body.join("\n");
        const fullText = `${section.header}\n${bodyText}`.toLowerCase();

        // Score: fraction of query terms found in the section
        let matchCount = 0;
        for (const term of queryTerms) {
          if (fullText.includes(term)) matchCount++;
        }
        if (matchCount === 0) continue;

        const score = matchCount / queryTerms.length;

        const cleanBody = stripSourceTags(section.body).join("\n").trim();
        const snippet =
          cleanBody.length > 500
            ? cleanBody.substring(0, 497) + "..."
            : cleanBody;

        allMatches.push({
          fileName: name,
          sectionHeader: section.header,
          snippet,
          score,
        });
      }
    }

    // Sort by score desc, then by fileName desc (newer first)
    allMatches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.fileName.localeCompare(a.fileName);
    });

    // Apply limits
    const results: MemoryQueryMatch[] = [];
    let totalChars = 0;
    for (const match of allMatches) {
      if (results.length >= maxResults) break;
      if (totalChars + match.snippet.length > maxTotalChars && results.length > 0) break;
      results.push(match);
      totalChars += match.snippet.length;
    }

    return {
      matches: results,
      totalFound: allMatches.length,
      truncated: results.length < allMatches.length,
    };
  }

  /** Start periodic auto-sync timer. */
  startAutoSync(syncFn: () => Promise<void>): void {
    if (this.config.autoSyncIntervalSeconds <= 0) return;
    if (this.syncTimer) return;

    const intervalMs = this.config.autoSyncIntervalSeconds * 1000;
    this.syncTimer = setInterval(() => {
      syncFn().catch((err) => {
        this.logger.error(`auto-sync failed: ${err}`);
      });
    }, intervalMs);

    this.logger.info(
      `auto-sync started (every ${this.config.autoSyncIntervalSeconds}s)`,
    );
  }

  /** Stop periodic auto-sync. */
  stopAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      this.logger.info("auto-sync stopped");
    }
  }
}
