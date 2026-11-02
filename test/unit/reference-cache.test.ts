import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ReferenceCache,
  ensureReferenceRegistered,
  findExistingReference,
  findExistingReferenceId,
  referenceIdentity,
  uniqueReferenceIdentities,
} from '../../src/flow/reference-cache.js';
import { label } from '../../src/flow/labels.js';
import { FlowError } from '../../src/lib/errors.js';

describe('ReferenceCache', () => {
  it('reuses a remote project item for the same file across repeated scene preparations and process instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'rafa.png');
    const cacheFile = path.join(dir, 'references.json');
    fs.writeFileSync(file, 'image-bytes');
    const projectUrl = 'https://flow.google.com/project/11111111-1111-4111-8111-111111111111';
    const identity = referenceIdentity(projectUrl, file);
    const first = new ReferenceCache(cacheFile);
    first.set({ ...identity, remoteId: 'https://flow.google.com/asb/remote-item' });

    const restarted = new ReferenceCache(cacheFile);
    for (let scene = 0; scene < 30; scene++) {
      expect(restarted.get(referenceIdentity(projectUrl, file))?.remoteId).toBe(
        'https://flow.google.com/asb/remote-item',
      );
    }
  });

  it('scopes entries to project, resolved path and content hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'reference.png');
    fs.writeFileSync(file, 'first');
    const identity = referenceIdentity(
      'https://flow.google.com/project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa?hl=en',
      file,
    );
    const cache = new ReferenceCache(path.join(dir, 'references.json'));
    cache.set({ ...identity, remoteId: 'remote-a' });

    expect(
      cache.get(referenceIdentity('https://flow.google.com/project/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', file)),
    ).toBeUndefined();
    fs.writeFileSync(file, 'second');
    expect(
      cache.get(referenceIdentity('https://flow.google.com/project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', file)),
    ).toBeUndefined();
  });

  it('deduplicates repeated local paths before reference registration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    fs.writeFileSync(file, 'bytes');
    const relative = path.relative(process.cwd(), file);
    const identities = uniqueReferenceIdentities(
      'https://flow.google.com/project/abababab-abab-4bab-8bab-abababababab?hl=en',
      [file, file, relative],
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]).toEqual(
      referenceIdentity('https://flow.google.com/project/abababab-abab-4bab-8bab-abababababab', file),
    );
  });

  it('uses project ID as the cache identity and ignores locale query parameters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    fs.writeFileSync(file, 'bytes');
    const identityEnglish = referenceIdentity(
      'https://flow.google.com/project/cccccccc-cccc-4ccc-8ccc-cccccccccccc?hl=en',
      file,
    );
    const identityPortuguese = referenceIdentity(
      'https://flow.google.com/project/CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC?hl=pt-BR',
      file,
    );
    expect(identityEnglish).toEqual(identityPortuguese);
  });

  it('migrates legacy cache entries whose project URL contains a locale query', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    const cacheFile = path.join(dir, 'references.json');
    fs.writeFileSync(file, 'bytes');
    const { resolvedPath, contentHash } = referenceIdentity(
      'https://flow.google.com/project/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      file,
    );
    fs.writeFileSync(
      cacheFile,
      JSON.stringify([
        {
          projectUrl: 'https://flow.google.com/project/dddddddd-dddd-4ddd-8ddd-dddddddddddd?hl=en',
          resolvedPath,
          contentHash,
          remoteId: 'legacy-remote-id',
        },
      ]),
    );
    const cache = new ReferenceCache(cacheFile);
    expect(
      cache.get(referenceIdentity('https://flow.google.com/project/dddddddd-dddd-4ddd-8ddd-dddddddddddd', file))
        ?.remoteId,
    ).toBe('legacy-remote-id');
  });

  it('loads legacy cache files that end in a literal escaped newline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    const cacheFile = path.join(dir, 'references.json');
    fs.writeFileSync(file, 'bytes');
    const identity = referenceIdentity('https://flow.google.com/project/abababab-abab-4bab-8bab-abababababab', file);
    fs.writeFileSync(cacheFile, `${JSON.stringify([{ ...identity, remoteId: 'legacy-id' }])}\\n`);

    const cache = new ReferenceCache(cacheFile);
    expect(cache.get(identity)?.remoteId).toBe('legacy-id');
    cache.set({ ...identity, remoteId: 'new-id' });
    const rewritten: unknown = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(Array.isArray(rewritten)).toBe(true);
  });

  it('bootstraps the cache from a previously uploaded project item with the exact filename', () => {
    const tiles = [
      { kind: 'video', title: 'rafa.png', url: 'video-url' },
      { kind: 'image', title: 'rafa.png copy', url: 'wrong-image-url' },
      { kind: 'image', title: 'rafa.png', url: 'image-url', uuid: 'image-id' },
    ];
    expect(findExistingReferenceId(tiles, '/refs/rafa.png')).toBe('image-id');
    expect(findExistingReferenceId(tiles.slice(0, 2), '/refs/rafa.png')).toBeUndefined();
    expect(findExistingReference(tiles.slice(0, 2), '/refs/rafa.png')).toEqual({ status: 'missing' });
    expect(findExistingReference([{ kind: 'image', title: 'rafa.png', url: 'image-url' }], '/refs/rafa.png')).toEqual({
      status: 'unidentified',
    });
  });

  it('reuses an existing project item on a cache miss without invoking upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    fs.writeFileSync(file, 'bytes');
    const cache = new ReferenceCache(path.join(dir, 'references.json'));
    const identity = referenceIdentity('https://flow.google.com/project/34343434-3434-4434-8434-343434343434', file);
    let uploadCount = 0;

    const result = await ensureReferenceRegistered(
      cache,
      identity,
      () => Promise.resolve('existing-flow-uuid'),
      () => {
        uploadCount++;
        return Promise.resolve('unexpected-upload');
      },
    );

    expect(result).toEqual({ remoteId: 'existing-flow-uuid', uploaded: false });
    expect(uploadCount).toBe(0);
    expect(cache.get(identity)?.remoteId).toBe('existing-flow-uuid');
  });

  it('serializes registrations across server instances so concurrent cache misses upload once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    const cacheFile = path.join(dir, 'references.json');
    fs.writeFileSync(file, 'bytes');
    const identity = referenceIdentity('https://flow.google.com/project/56565656-5656-4565-8565-565656565656', file);
    const first = new ReferenceCache(cacheFile);
    const second = new ReferenceCache(cacheFile);
    let uploadCount = 0;
    let lookupCount = 0;
    const lookup = () => {
      lookupCount++;
      return Promise.resolve(undefined);
    };
    const upload = async (markPending: () => void) => {
      uploadCount++;
      markPending();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'one-remote-id';
    };

    const results = await Promise.all([
      ensureReferenceRegistered(first, identity, lookup, upload),
      ensureReferenceRegistered(second, identity, lookup, upload),
    ]);

    expect(results.map((result) => result.uploaded).sort()).toEqual([false, true]);
    expect(results.map((result) => result.remoteId)).toEqual(['one-remote-id', 'one-remote-id']);
    expect(uploadCount).toBe(1);
    expect(lookupCount).toBe(1);
  });

  it('keeps an uncertain upload pending and refuses to open the file chooser again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    const cache = new ReferenceCache(path.join(dir, 'references.json'));
    fs.writeFileSync(file, 'bytes');
    const identity = referenceIdentity('https://flow.google.com/project/12121212-1212-4212-8212-121212121212', file);
    let uploadCount = 0;
    const upload = (markPending: () => void) => {
      uploadCount++;
      markPending();
      return Promise.resolve(undefined);
    };
    const findNone = () => Promise.resolve(undefined);

    await expect(ensureReferenceRegistered(cache, identity, findNone, upload)).rejects.toMatchObject({
      code: 'REFERENCE_ASSET_NOT_REGISTERED',
    });
    await expect(ensureReferenceRegistered(cache, identity, findNone, upload)).rejects.toBeInstanceOf(FlowError);
    expect(uploadCount).toBe(1);
  });

  it('reconciles a pending upload to a project UUID before considering another upload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
    const file = path.join(dir, 'style.png');
    const cacheFile = path.join(dir, 'references.json');
    fs.writeFileSync(file, 'bytes');
    const identity = referenceIdentity('https://flow.google.com/project/34343434-3434-4434-8434-343434343434', file);
    const cache = new ReferenceCache(cacheFile);
    const markPending = () => cache.set({ ...identity, pending: true });
    markPending();
    let uploadCount = 0;

    const result = await ensureReferenceRegistered(
      cache,
      identity,
      () => Promise.resolve('reconciled-project-uuid'),
      () => {
        uploadCount++;
        return Promise.resolve('duplicate-upload');
      },
    );

    expect(result).toEqual({ remoteId: 'reconciled-project-uuid', uploaded: false });
    expect(uploadCount).toBe(0);
    expect(new ReferenceCache(cacheFile).get(identity)?.remoteId).toBe('reconciled-project-uuid');
  });

  it.each([
    [
      'https://flow.google.com/project/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'prompt box',
      'Add to prompt',
      'Adicionar mídia à caixa de prompt',
      'Adicionar ao prompt',
    ],
    [
      'https://flow.google.com/project/ffffffff-ffff-4fff-8fff-ffffffffffff',
      'Adicionar mídia à caixa de prompt',
      'Adicionar ao prompt',
      'prompt box',
      'Add to prompt',
    ],
  ])(
    'first preview uploads once and the next preview reuses the registered item across locales',
    async (projectUrl, firstAttachLabel, firstConfirmLabel, secondAttachLabel, secondConfirmLabel) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-cache-'));
      const file = path.join(dir, '1.png_f5c28716.jpg');
      const cacheFile = path.join(dir, 'references.json');
      fs.writeFileSync(file, 'reference-bytes');
      const cache = new ReferenceCache(cacheFile);
      const assets: { kind: string; title: string; uuid: string }[] = [];
      let uploadCount = 0;
      const preview = async (attachLabel: string, confirmLabel: string) => {
        expect(label('attachToPrompt').test(attachLabel)).toBe(true);
        expect(label('addToPrompt').test(confirmLabel)).toBe(true);
        const identity = referenceIdentity(projectUrl, file);
        return ensureReferenceRegistered(
          cache,
          identity,
          () =>
            Promise.resolve(
              findExistingReferenceId(
                assets.map((asset) => ({ ...asset, url: `https://flow.google.com/asb/${asset.uuid}` })),
                file,
              ),
            ),
          (markPending) => {
            markPending();
            uploadCount++;
            assets.push({ kind: 'image', title: path.basename(file), uuid: 'remote-image-id' });
            return Promise.resolve('remote-image-id');
          },
        );
      };

      const first = await preview(firstAttachLabel, firstConfirmLabel);
      const second = await preview(secondAttachLabel, secondConfirmLabel);
      expect(first).toEqual({ remoteId: 'remote-image-id', uploaded: true });
      expect(second).toEqual({ remoteId: 'remote-image-id', uploaded: false });
      expect(uploadCount).toBe(1);
      expect(assets).toHaveLength(1);
    },
  );
});
