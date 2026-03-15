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

const SOURCE_TAG_RE = /^<!--\s*source:\s*.+?\s*-->$/;

/**
 * Strip all source tags and blank lines from a body, returning only
 * meaningful content lines.  This normalises bodies that may have been
 * through different versions of the merge logic (nested tags, etc.).
 */
function stripSourceTags(body: string[]): string[] {
  return body.filter((line) => !SOURCE_TAG_RE.test(line));
}

/**
 * Collect unique non-empty content lines from a body (source tags removed).
 * Returns a sorted, deduplicated array of trimmed lines.
 */
function uniqueContentLines(body: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of stripSourceTags(body)) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  result.sort();
  return result;
}

/**
 * Merge two sets of sections from the same day.
 * - Sections with the same key (header text) are compared by body content.
 * - Source tags (<!-- source: ... -->) are stripped before comparison.
 * - If the unique content lines are identical, keep one copy (no tags).
 * - If different, union all unique lines, sort deterministically, and
 *   write them without source tags (source tracking caused unbounded
 *   growth when the two sides ran different merge logic versions).
 * - Sections that exist only on one side are kept as-is (tags stripped).
 *
 * This is idempotent: re-merging already-merged content produces the
 * exact same output because everything is deduped and sorted.
 */
function mergeSections(
  localSections: MemorySection[],
  remoteSections: MemorySection[],
  _localName: string,
  _remoteName: string,
): MemorySection[] {
  const merged: MemorySection[] = [];
  const usedRemote = new Set<number>();

  for (const local of localSections) {
    const remoteIdx = remoteSections.findIndex(
      (r, i) => !usedRemote.has(i) && r.key === local.key,
    );

    if (remoteIdx === -1) {
      // Only on local side — strip any leftover source tags
      merged.push({
        header: local.header,
        body: stripSourceTags(local.body),
        key: local.key,
      });
    } else {
      usedRemote.add(remoteIdx);
      const remote = remoteSections[remoteIdx];

      // Union all unique content lines from both sides
      const seen = new Set<string>();
      const unionLines: string[] = [];
      for (const line of [...stripSourceTags(local.body), ...stripSourceTags(remote.body)]) {
        const trimmed = line.trim();
        if (trimmed.length > 0 && !seen.has(trimmed)) {
          seen.add(trimmed);
          unionLines.push(trimmed);
        }
      }
      // Sort for deterministic output on both sides
      unionLines.sort();

      merged.push({
        header: local.header,
        body: unionLines,
        key: local.key,
      });
    }
  }

  // Append sections only on remote side (strip source tags)
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
