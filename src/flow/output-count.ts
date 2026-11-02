import { FlowError } from '../lib/errors.js';

/** Stop as soon as Flow exposes more outputs than requested, before downloading or recording any of them. */
export function assertNoExcessOutputs(requested: number, returned: number, mediaIds: string[] = []): void {
  if (returned <= requested) return;
  throw new FlowError(
    'OUTPUT_COUNT_MISMATCH',
    `Flow returned ${returned} outputs for a request of ${requested}; stopping before downloads are registered`,
    { requested, returned, media_ids: mediaIds },
  );
}

export function isComposerActionText(text: string): boolean {
  return /prompt box|프롬프트 상자에 소재 추가|attach to prompt|arrow_forward|adicionar.{0,45}elementos.{0,30}caixa de comando|(?:add|adicionar)[^\n]{0,50}(?:media|mídia|image|imagem|material|prompt|solicitação)|(?:prompt|solicitação)[^\n]{0,50}(?:add|adicionar)/i.test(
    text,
  );
}
