import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertComposerClear, composerMedia } from '../../src/flow/composer.js';
import { assertNoExcessOutputs, isComposerActionText } from '../../src/flow/output-count.js';
import { referencePickerOptionIndex } from '../../src/flow/reference-picker.js';
import { FlowError } from '../../src/lib/errors.js';

afterEach(() => vi.unstubAllGlobals());

describe('composer safety regressions', () => {
  it('stops before adding references when a chip from an earlier request survives cleanup', () => {
    expect(() => assertComposerClear([])).not.toThrow();
    expect(() => assertComposerClear(['https://flow-content.google/image/stale-reference-id'])).toThrow(
      expect.objectContaining({
        code: 'REFERENCE_NOT_ATTACHED',
        details: { composer_media_count: 1 },
      }),
    );
  });

  it('recognizes the composer by stable localized control text, independent of panel geometry', () => {
    // Layout changes (panel height, window size, expanded settings) do not enter this selector decision.
    expect(isComposerActionText('prompt box')).toBe(true);
    expect(isComposerActionText('프롬프트 상자에 소재 추가')).toBe(true);
    expect(isComposerActionText('Adicionar mídia à caixa de prompt')).toBe(true);
    expect(isComposerActionText('Adicionar elementos à caixa de comando')).toBe(true);
    expect(isComposerActionText('Add media to prompt')).toBe(true);
    expect(isComposerActionText('arrow_forward')).toBe(true);
    expect(isComposerActionText('Upload media')).toBe(false);
  });

  it('selects a duplicate-filename picker item by Flow ID and rejects ambiguous filename-only matches', () => {
    const options = [
      { label: '1.png_f5c28716.jpg Imagem', mediaIds: ['older-uuid'] },
      { label: '1.png_f5c28716.jpg Imagem', mediaIds: ['newer-uuid'] },
    ];
    expect(referencePickerOptionIndex(options, 'newer-uuid', '1.png_f5c28716.jpg')).toBe(1);
    expect(
      referencePickerOptionIndex(
        options.map((option) => ({ ...option, mediaIds: [], mediaUrls: ['https://flow.google.com/asb/image-token'] })),
        'missing-uuid',
        '1.png_f5c28716.jpg',
        'https://flow.google.com/asb/image-token=mm',
      ),
    ).toBe(0);
    expect(
      referencePickerOptionIndex(
        options.map((option) => ({ ...option, mediaIds: [] })),
        'missing-uuid',
        '1.png_f5c28716.jpg',
      ),
    ).toBeUndefined();
    expect(
      referencePickerOptionIndex(
        [{ label: '1.png_f5c28716.jpg Imagem', mediaIds: ['older-uuid'] }],
        'missing-uuid',
        '1.png_f5c28716.jpg',
      ),
    ).toBe(0);
  });

  it('matches only the actual asset row when the UI also exposes project dropdown options', () => {
    const assetRows = [
      { label: 'Square in residential neighborho… Image', mediaIds: ['generated-id'] },
      { label: '1.png_f5c28716.jpg Imagem', mediaIds: [] },
    ];
    expect(referencePickerOptionIndex(assetRows, 'project-id', '1.png_f5c28716.jpg')).toBe(1);
  });

  it.each([
    ['Português', 1200],
    ['English', 720],
    ['Korean', 480],
  ])('finds composer chips by semantic DOM selector in %s at viewport height %i', async (_locale, height) => {
    const image = {
      currentSrc: 'https://flow-content.google/image/reference-id',
      src: 'https://flow-content.google/image/reference-id',
      getBoundingClientRect: () => ({ width: 50, height: 50, x: 5, y: height / 2 }),
    };
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => (selector === 'flow-base-prompt-box img.chip-image' ? [image] : []),
    });
    vi.stubGlobal('getComputedStyle', () => ({ display: 'inline', visibility: 'visible' }));
    const page = { evaluate: (fn: () => unknown) => Promise.resolve(fn()) };

    await expect(composerMedia(page as never)).resolves.toEqual(['https://flow-content.google/image/reference-id']);
  });

  it('does not mistake project-grid images for composer chips', async () => {
    const gridImage = {
      currentSrc: 'https://flow.google.com/asb/project-media',
      src: 'https://flow.google.com/asb/project-media',
      getBoundingClientRect: () => ({ width: 140, height: 250, x: 5, y: 10 }),
    };
    vi.stubGlobal('document', {
      querySelectorAll: (selector: string) => (selector === 'img' ? [gridImage] : []),
    });
    vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible' }));
    const page = { evaluate: (fn: () => unknown) => Promise.resolve(fn()) };

    await expect(composerMedia(page as never)).resolves.toEqual([]);
  });

  it('selects chips only inside Flow base prompt box', async () => {
    let selector = '';
    vi.stubGlobal('document', {
      querySelectorAll: (value: string) => {
        selector = value;
        return [];
      },
    });
    const page = { evaluate: (fn: () => unknown) => Promise.resolve(fn()) };

    await composerMedia(page as never);
    expect(selector).toBe('flow-base-prompt-box img.chip-image');
  });

  it('allows an exact count and stops before registering a four-file response to count=1', () => {
    expect(() => assertNoExcessOutputs(1, 1, ['one'])).not.toThrow();
    try {
      assertNoExcessOutputs(1, 4, ['a', 'b', 'c', 'd']);
      throw new Error('expected a count mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(FlowError);
      expect(error).toMatchObject({
        code: 'OUTPUT_COUNT_MISMATCH',
        details: { requested: 1, returned: 4, media_ids: ['a', 'b', 'c', 'd'] },
      });
    }
  });
});
