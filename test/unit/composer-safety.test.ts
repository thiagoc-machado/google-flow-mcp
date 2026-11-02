import { afterEach, describe, expect, it, vi } from 'vitest';
import { composerMedia } from '../../src/flow/composer.js';
import { assertNoExcessOutputs, isComposerActionText } from '../../src/flow/output-count.js';
import { referencePickerOptionIndex } from '../../src/flow/reference-picker.js';
import { FlowError } from '../../src/lib/errors.js';

afterEach(() => vi.unstubAllGlobals());

describe('composer safety regressions', () => {
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

  it.each([
    ['prompt box', 1200],
    ['프롬프트 상자에 소재 추가', 720],
    ['arrow_forward', 480],
  ])('finds composer thumbnails for locale/control %s at viewport height %i', async (controlText, height) => {
    const body = {};
    const image = {
      currentSrc: 'https://flow.google.com/asb/reference-image',
      src: 'https://flow.google.com/asb/reference-image',
      getBoundingClientRect: () => ({ width: 80, height: 80, x: 5, y: height / 2 }),
    };
    const input: { parentElement: unknown; querySelectorAll: () => never[] } = {
      parentElement: null,
      querySelectorAll: () => [],
    };
    const button = { getAttribute: () => null, textContent: controlText };
    const composer = {
      parentElement: body,
      querySelectorAll: (selector: string) => (selector === 'img' ? [image] : [button]),
    };
    input.parentElement = composer;
    vi.stubGlobal('document', {
      body,
      querySelector: () => input,
    });
    vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible' }));
    const page = {
      evaluate: (fn: () => unknown) => Promise.resolve(fn()),
    };

    await expect(composerMedia(page as never)).resolves.toEqual(['https://flow.google.com/asb/reference-image']);
  });

  it('does not mistake project-grid media for composer attachments when no composer action is in the subtree', async () => {
    const body = {};
    const input: { parentElement: unknown; querySelectorAll: () => never[] } = {
      parentElement: null,
      querySelectorAll: () => [],
    };
    const projectGrid = {
      parentElement: body,
      querySelectorAll: (selector: string) =>
        selector === 'img' ? [{}] : [{ getAttribute: () => null, textContent: 'Upload media' }],
    };
    input.parentElement = projectGrid;
    vi.stubGlobal('document', { body, querySelector: () => input });
    vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible' }));
    const page = { evaluate: (fn: () => unknown) => Promise.resolve(fn()) };

    await expect(composerMedia(page as never)).resolves.toEqual([]);
  });

  it('queries the semantic textbox used by current Portuguese Flow UI', async () => {
    const body = {};
    const textbox = { parentElement: body, querySelectorAll: () => [] };
    let selector = '';
    vi.stubGlobal('document', {
      body,
      querySelector: (value: string) => {
        selector = value;
        return textbox;
      },
    });
    const page = { evaluate: (fn: () => unknown) => Promise.resolve(fn()) };

    await composerMedia(page as never);
    expect(selector).toContain('[role="textbox"]');
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
