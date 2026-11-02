import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FlowError } from '../lib/errors.js';
import { requireProjectUrl } from './project.js';

export interface ReferenceIdentity {
  projectId: string;
  resolvedPath: string;
  contentHash: string;
}

export interface CachedReference extends ReferenceIdentity {
  remoteId?: string;
  pending?: boolean;
}

export interface ExistingReferenceTile {
  kind: string;
  title: string;
  uuid?: string;
  url: string;
}

export type ExistingReferenceMatch =
  { status: 'missing' } | { status: 'identified'; remoteId: string } | { status: 'unidentified' };

export type ReferenceAction = 'upload' | 'reuse' | 'refuse_duplicate';

export function referenceAction(cachedRemoteId: string | undefined, remoteItemSelectable: boolean): ReferenceAction {
  if (!cachedRemoteId) return 'upload';
  return remoteItemSelectable ? 'reuse' : 'refuse_duplicate';
}

/** Exact image filename matches are eligible for cache-miss recovery; the project view must provide an ID. */
export function findExistingReferenceId(tiles: ExistingReferenceTile[], filePath: string): string | undefined {
  const result = findExistingReference(tiles, filePath);
  return result.status === 'identified' ? result.remoteId : undefined;
}

export function findExistingReference(tiles: ExistingReferenceTile[], filePath: string): ExistingReferenceMatch {
  const filename = path.basename(filePath).trim().toLocaleLowerCase();
  const matches = tiles.filter((tile) => tile.kind === 'image' && tile.title.trim().toLocaleLowerCase() === filename);
  const identified = matches.find((tile) => tile.uuid);
  if (identified?.uuid) return { status: 'identified', remoteId: identified.uuid };
  return matches.length > 0 ? { status: 'unidentified' } : { status: 'missing' };
}

export function referenceIdentity(projectUrl: string, filePath: string): ReferenceIdentity {
  if (!fs.existsSync(filePath)) {
    throw new FlowError('REFERENCE_NOT_ATTACHED', `reference image not found: ${filePath}`, { path: filePath });
  }
  const resolvedPath = path.resolve(filePath);
  const contentHash = crypto.createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex');
  return { projectId: requireProjectUrl(projectUrl).toLocaleLowerCase(), resolvedPath, contentHash };
}

export function uniqueReferenceIdentities(projectUrl: string, filePaths: string[]): ReferenceIdentity[] {
  const seen = new Set<string>();
  return filePaths
    .map((filePath) => referenceIdentity(projectUrl, filePath))
    .filter((identity) => {
      const key = cacheKey(identity);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Resolve a cache hit, reconcile a pending upload, or upload once and persist its project media ID. */
export async function ensureReferenceRegistered(
  cache: ReferenceCache,
  identity: ReferenceIdentity,
  findExisting: () => Promise<string | undefined>,
  uploadAndWaitForProjectId: (markPending: () => void) => Promise<string | undefined>,
): Promise<{ remoteId: string; uploaded: boolean }> {
  return cache.withLock(async () => {
    const cached = cache.get(identity);
    if (cached?.remoteId) return { remoteId: cached.remoteId, uploaded: false };

    const existingId = await findExisting();
    if (existingId) {
      cache.set({ ...identity, remoteId: existingId });
      return { remoteId: existingId, uploaded: false };
    }

    if (cached?.pending) {
      throw new FlowError(
        'REFERENCE_ASSET_NOT_REGISTERED',
        'a previous reference upload may have succeeded, but Flow still exposes no project media ID; refusing to upload again',
        { project_id: identity.projectId, path: identity.resolvedPath, pending: true },
      );
    }

    const remoteId = await uploadAndWaitForProjectId(() => cache.set({ ...identity, pending: true }));
    if (!remoteId) {
      throw new FlowError(
        'REFERENCE_ASSET_NOT_REGISTERED',
        'Flow accepted or displayed the reference, but project media enumeration returned no stable media ID; refusing to retry the upload',
        { project_id: identity.projectId, path: identity.resolvedPath, pending: true },
      );
    }

    cache.set({ ...identity, remoteId });
    return { remoteId, uploaded: true };
  });
}

/** Persistent project-local cache. Missing/corrupt files are empty; no Flow media is ever removed. */
export class ReferenceCache {
  private readonly entries = new Map<string, CachedReference>();

  constructor(private readonly filePath: string) {
    this.reload();
  }

  /** Serialize registrations across multiple MCP processes sharing the same state directory. */
  async withLock<T>(action: () => Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.registration.lock`;
    const deadline = Date.now() + 120_000;
    let lockFd: number | undefined;
    while (lockFd === undefined) {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stat = fs.statSync(lockPath);
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
          const ownerAlive =
            typeof lock.pid === 'number' &&
            (() => {
              try {
                process.kill(lock.pid, 0);
                return true;
              } catch {
                return false;
              }
            })();
          if (!ownerAlive && Date.now() - stat.mtimeMs > 5_000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // A concurrent process may be replacing the lock while it is read; keep waiting.
        }
        if (Date.now() >= deadline) {
          throw new FlowError(
            'REFERENCE_REGISTRATION_BUSY',
            'another Flow MCP process is still reconciling a reference registration; refusing to upload concurrently',
            { lock_path: lockPath },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    try {
      this.reload();
      return await action();
    } finally {
      fs.closeSync(lockFd);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Lock cleanup must not hide the registration result or failure.
      }
    }
  }

  private reload(): void {
    this.entries.clear();
    try {
      // Older builds appended the two literal characters `\\n` instead of a newline. Accept
      // that tail so existing remote IDs survive upgrades; the next set() rewrites valid JSON.
      const source = fs.readFileSync(this.filePath, 'utf8').replace(/(?:\\n)+\s*$/, '');
      const loaded: unknown = JSON.parse(source);
      if (Array.isArray(loaded)) {
        for (const item of loaded) {
          const entry = parseCachedReference(item);
          if (entry) this.entries.set(cacheKey(entry), entry);
        }
      }
    } catch {
      // First run or unreadable cache: populate it on the next successful registration.
    }
  }

  get(identity: ReferenceIdentity): CachedReference | undefined {
    return this.entries.get(cacheKey(identity));
  }

  set(entry: CachedReference): void {
    this.entries.set(cacheKey(entry), entry);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify([...this.entries.values()], null, 2)}\n`);
    fs.renameSync(temporaryPath, this.filePath);
  }
}

function cacheKey(entry: ReferenceIdentity): string {
  return JSON.stringify([entry.projectId, entry.resolvedPath, entry.contentHash]);
}

function parseCachedReference(value: unknown): CachedReference | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.resolvedPath !== 'string' || typeof v.contentHash !== 'string') return undefined;
  let projectId: string | undefined;
  if (typeof v.projectId === 'string') projectId = v.projectId.toLocaleLowerCase();
  else if (typeof v.projectUrl === 'string') {
    try {
      projectId = requireProjectUrl(v.projectUrl).toLocaleLowerCase();
    } catch {
      return undefined;
    }
  }
  if (!projectId || (v.remoteId !== undefined && typeof v.remoteId !== 'string')) return undefined;
  if (v.pending !== undefined && typeof v.pending !== 'boolean') return undefined;
  return {
    projectId,
    resolvedPath: v.resolvedPath,
    contentHash: v.contentHash,
    ...(typeof v.remoteId === 'string' ? { remoteId: v.remoteId } : {}),
    ...(typeof v.pending === 'boolean' ? { pending: v.pending } : {}),
  };
}
