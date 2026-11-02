import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { takeScreenshot } from '../browser/screenshot.js';
import type { AppContext } from '../context.js';
import { FlowError } from '../lib/errors.js';
import type { Job } from './jobs.js';
import { IMAGE_MODELS, type ModelId, label, modelLabel } from './labels.js';
import { type MediaKind, downloadedPrefixes, mediaTiles, tileUrl, tryDownload } from './media.js';
import { ensureOnProject } from './project.js';
import {
  ReferenceCache,
  ensureReferenceRegistered,
  findExistingReference,
  referenceAction,
  uniqueReferenceIdentities,
} from './reference-cache.js';
import { referencePickerOptionIndex } from './reference-picker.js';
import { assertNoExcessOutputs, isComposerActionText } from './output-count.js';
import {
  bodyText,
  clickSettingsTrigger,
  firstInRegion,
  iconButton,
  isVisible,
  labelButton,
  namedButton,
  pressEscape,
  sleep,
  waitStable,
} from './ui.js';

// Flow's agent chat composer (right-hand panel): settings popover (tune), attach menu (add_2), send (arrow_forward),
// an optional approval card, and the media grid where outputs appear. This module owns that whole flow.

export interface GenerateArgs {
  kind: MediaKind;
  prompt: string;
  model: ModelId;
  ratio: string;
  duration: number | undefined;
  count: number;
  referenceImages: string[];
  projectUrl: string;
  outputDir: string;
  autoConfirm: boolean;
  resume: boolean;
  jobId: string | undefined;
  editMode: boolean;
}

// Type alias so the result can be stored as a job record (Record<string, unknown>)
export type GenerateResult = {
  status: 'ready_for_confirmation' | 'completed';
  job_id: string;
  files: string[];
  media_ids: string[];
  references_attached: number;
  references_registered: number;
  approval_text: string;
  model: string;
  ratio: string;
  duration?: number;
  elapsed_ms: number;
  prompt: string;
  screenshot?: string;
};

const APPROVAL_TIMEOUT_MS = 120_000;
const RESUME_APPROVAL_TIMEOUT_MS = 30_000;
const SEND_ATTEMPTS = 30;

export async function generateMedia(ctx: AppContext, args: GenerateArgs): Promise<GenerateResult> {
  const started = Date.now();
  const page = await ctx.session.ensureConnected();
  const shots = path.join(ctx.config.stateDir, 'screenshots');
  const modelName = modelLabel(args.model);
  const projectId = await ensureOnProject(page, args.projectUrl, ctx.log);
  ctx.log.info('project opened for generation', { project_id: projectId, url: page.url() });

  if (args.resume) return resumeGeneration(ctx, page, args, started);

  await ensureComposer(ctx, page, args.editMode);
  ctx.log.info('composer ready', {
    project_id: projectId,
    kind: args.kind,
    attached_before: (await composerMedia(page)).length,
  });
  await applyDefaults(ctx, page, args.projectUrl, args.kind, args.ratio, modelName, args.count);
  await ensureComposer(ctx, page, args.editMode);

  // auto_confirm=false prepares the prompt, including references. Cache the existing Flow asset so that
  // preparing the same scene again reuses it instead of uploading a duplicate into the project.
  const origin = (await composerMedia(page)).length;
  let attached = 0;
  let registered = 0;
  const referenceCache = new ReferenceCache(path.join(ctx.config.stateDir, 'references.json'));
  const referenceIdentities = uniqueReferenceIdentities(args.projectUrl, args.referenceImages);
  const requestedReferences = referenceIdentities.length;
  if (args.referenceImages.length > 0) {
    await waitStable(async () => (await mediaTiles(page)).length, 3, 1000, 15);
    ctx.log.info('reference inventory baseline', {
      project_id: projectId,
      project_media_count: (await mediaTiles(page)).length,
    });
  }
  for (const identity of referenceIdentities) {
    const ref = identity.resolvedPath;
    const want = origin + attached + 1;
    let uploadedAttachment: ReferenceAttachmentResult | undefined;
    const registration = await ensureReferenceRegistered(
      referenceCache,
      identity,
      async () => {
        const match = findExistingReference(await mediaTiles(page), ref);
        if (match.status === 'unidentified') {
          throw new FlowError(
            'REFERENCE_ASSET_NOT_REGISTERED',
            'a project image has the reference filename but Flow exposed no stable media ID; refusing to upload another copy',
            { project_id: identity.projectId, path: identity.resolvedPath, pending: false },
          );
        }
        return match.status === 'identified' ? match.remoteId : undefined;
      },
      async (markPending) => {
        const beforeTiles = await mediaTiles(page);
        uploadedAttachment = await uploadAndAttachReference(ctx, page, ref, want, beforeTiles, markPending);
        if (!uploadedAttachment.remoteId) {
          const current = await composerMedia(page);
          throw new FlowError(
            'REFERENCE_ASSET_NOT_REGISTERED',
            current.length >= want
              ? 'Flow shows the reference attached to the composer, but project media enumeration returned zero matching assets'
              : 'reference upload was initiated, but project media enumeration returned no stable media ID',
            {
              project_id: identity.projectId,
              path: identity.resolvedPath,
              composer_attached: current.length >= want,
              project_media_count: (await mediaTiles(page)).length,
              pending: true,
            },
            await takeScreenshot(page, shots, 'reference-asset-not-registered'),
          );
        }
        return uploadedAttachment.remoteId;
      },
    );
    ctx.log.info(registration.uploaded ? 'reference registered after upload' : 'reference registration reused', {
      project_id: projectId,
      remote_id: registration.remoteId,
      uploaded: registration.uploaded,
    });
    registered++;
    const result = uploadedAttachment ?? (await attachExistingReference(ctx, page, ref, want, registration.remoteId));
    if (result.attached) {
      attached++;
    }
  }
  // Sending without the reference makes the agent pick an arbitrary project image as the first frame: stop before credits
  if (requestedReferences > 0 && attached < requestedReferences) {
    await clearComposer(ctx, page);
    throw new FlowError(
      'REFERENCE_NOT_ATTACHED',
      `${attached}/${requestedReferences} reference images attached; nothing was sent`,
      { attached, requested: requestedReferences },
      await takeScreenshot(page, shots, 'reference-not-attached'),
    );
  }

  const instruction = buildInstruction(args, modelName, attached);
  const input = composerInput(page);
  await input.click();
  await input.fill('');
  await input.fill(instruction);
  await sleep(400);

  const base = {
    references_attached: attached,
    references_registered: registered,
    model: modelName,
    ratio: args.ratio,
    prompt: instruction,
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
  };

  ctx.log.info('reference preparation complete', {
    project_id: projectId,
    references_attached: attached,
    references_registered: registered,
    project_media_count: (await mediaTiles(page)).length,
    auto_confirm: args.autoConfirm,
  });

  if (!args.autoConfirm) {
    const screenshot = await takeScreenshot(page, shots, `${args.kind}-ready`);
    return {
      status: 'ready_for_confirmation',
      job_id: '',
      files: [],
      media_ids: [],
      approval_text: '',
      elapsed_ms: Date.now() - started,
      ...base,
      ...(screenshot ? { screenshot } : {}),
    };
  }

  // The baseline has to describe the grid as it was before sending, and the grid is still rendering right
  // after navigation — so wait for a stable count, then take it once. Re-reading it later would swallow a
  // fast generation into the baseline and leave the job waiting for an output it already had.
  await waitStable(async () => (await mediaTiles(page)).length);
  const job = ctx.jobs.create({
    kind: args.kind,
    phase: 'sending',
    project_url: args.projectUrl,
    output_dir: args.outputDir,
    prompt: instruction,
    model: modelName,
    baseline_tiles: await tileCount(page, args.kind),
  });
  const bodyBefore = await bodyText(page);
  await send(ctx, page, input, shots);
  ctx.jobs.update(job.job_id, { phase: 'sent' });

  const approvalText = await awaitApproval(
    ctx,
    page,
    bodyBefore,
    args.kind,
    job.baseline_tiles,
    APPROVAL_TIMEOUT_MS,
    true,
  );
  let files: { path: string; media_id: string; title: string }[];
  try {
    files = await awaitOutputs(ctx, page, args, job.job_id, job.baseline_tiles, bodyBefore, shots);
  } catch (error) {
    const details = error instanceof FlowError ? error.details : undefined;
    ctx.jobs.update(job.job_id, {
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
      ...(details ? { discrepancy: details } : {}),
    });
    throw error;
  }
  ctx.jobs.update(job.job_id, { outputs: files.map((f) => ({ media_id: f.media_id, title: f.title })) });
  const result: GenerateResult = {
    status: 'completed',
    job_id: job.job_id,
    files: files.map((f) => f.path),
    media_ids: files.map((f) => f.media_id),
    approval_text: approvalText,
    elapsed_ms: Date.now() - started,
    ...base,
  };
  ctx.jobs.update(job.job_id, { phase: 'done', result });
  return result;
}

async function resumeGeneration(
  ctx: AppContext,
  page: Page,
  args: GenerateArgs,
  started: number,
): Promise<GenerateResult> {
  const shots = path.join(ctx.config.stateDir, 'screenshots');
  const job = args.jobId
    ? ctx.jobs.get(args.jobId)
    : ctx.jobs.findLatest(
        (j) =>
          j.kind === args.kind &&
          j.project_url === args.projectUrl &&
          j.output_dir === args.outputDir &&
          j.phase !== 'failed',
      );
  if (!job) {
    throw new FlowError('GENERATION_TIMEOUT', 'no in-flight generation to resume for this project/output_dir', {
      reason: 'no_job',
      project_url: args.projectUrl,
      output_dir: args.outputDir,
    });
  }
  if (job.phase === 'done' && job.result) {
    ctx.log.info('resume: job already completed', { job_id: job.job_id });
    const previous = job.result as unknown as GenerateResult;
    return {
      ...previous,
      references_registered: previous.references_registered ?? 0,
      elapsed_ms: Date.now() - started,
    };
  }
  await pressEscape(page);
  const bodyBefore = await bodyText(page);
  const approvalText = await awaitApproval(
    ctx,
    page,
    bodyBefore,
    args.kind,
    job.baseline_tiles,
    RESUME_APPROVAL_TIMEOUT_MS,
    false,
  );
  let files: { path: string; media_id: string; title: string }[];
  try {
    files = await awaitOutputs(ctx, page, args, job.job_id, job.baseline_tiles, bodyBefore, shots);
  } catch (error) {
    const details = error instanceof FlowError ? error.details : undefined;
    ctx.jobs.update(job.job_id, {
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
      ...(details ? { discrepancy: details } : {}),
    });
    throw error;
  }
  ctx.jobs.update(job.job_id, { outputs: files.map((f) => ({ media_id: f.media_id, title: f.title })) });
  const result: GenerateResult = {
    status: 'completed',
    job_id: job.job_id,
    files: files.map((f) => f.path),
    media_ids: files.map((f) => f.media_id),
    references_attached: 0,
    references_registered: 0,
    approval_text: approvalText,
    model: job.model,
    ratio: args.ratio,
    ...(args.duration !== undefined ? { duration: args.duration } : {}),
    elapsed_ms: Date.now() - started,
    prompt: job.prompt,
  };
  ctx.jobs.update(job.job_id, { phase: 'done', result });
  return result;
}

function composerInput(page: Page): Locator {
  return page.locator('[role="textbox"]:visible, [contenteditable="true"]:visible, textarea:visible').first();
}

function buildInstruction(args: GenerateArgs, modelName: string, attached: number): string {
  if (args.editMode) {
    return `Edit the last generated video (keep the same ${args.duration ?? 8}-second length and ${args.ratio} ratio): ${args.prompt}`;
  }
  if (args.kind === 'image') {
    const n = args.count === 1 ? 'one image' : `${args.count} images`;
    return (
      `Generate ${n} in ${args.ratio} aspect ratio with ${modelName}` +
      (attached ? ', using the attached image as the visual reference' : '') +
      `. Do not add text or captions unless the description asks for it. Image: ${args.prompt}`
    );
  }
  return (
    `Generate one ${args.duration ?? 8}-second ${args.ratio} video with ${modelName}` +
    (attached ? ', using the attached image as the first frame and keeping its composition, palette and subject' : '') +
    `. Do not add text, captions, music or narration. Scene: ${args.prompt}`
  );
}

async function closeSidePanels(page: Page): Promise<void> {
  // The settings popover closes via Save; the X next to it would close the whole chat panel
  if (await isVisible(page.getByText(label('agentSettings')).first())) {
    await labelButton(page, 'save', 'exact')
      .first()
      .click()
      .catch(() => undefined);
    await sleep(800);
  }
  await pressEscape(page);
}

// Read thumbnails from the DOM subtree shared by the composer input and attach control. This survives
// panel resizing, viewport changes, and Flow locale changes.
export async function composerMedia(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      // Flow currently exposes this as DIV[role=textbox] in Portuguese. Older English
      // layouts used contenteditable/textarea, so keep those fallbacks as well.
      const input = document.querySelector<HTMLElement>('[role="textbox"], [contenteditable="true"], textarea');
      if (!input) return [];
      const visible = (el: Element): boolean => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const isComposerAction = (el: Element): boolean => {
        const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
        return isComposerActionText(text);
      };
      let root: HTMLElement | null = null;
      let candidate: HTMLElement | null = input;
      while (candidate && candidate !== document.body) {
        if (
          candidate.querySelectorAll('img').length &&
          Array.from(candidate.querySelectorAll('button,[role="button"]')).some(isComposerAction)
        ) {
          root = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
      if (!root) return [];
      return Array.from(root.querySelectorAll('img'))
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          const src = img.currentSrc || img.src;
          return (
            visible(img) &&
            rect.width > 24 &&
            rect.height > 24 &&
            !/zero_states|\/website\/flow\/|\.svg(\?|$)/.test(src)
          );
        })
        .map((img) => img.currentSrc || img.src);
    })
    .catch(() => []);
}

async function clearComposer(ctx: AppContext, page: Page): Promise<void> {
  const clear = labelButton(page, 'clearPrompt').first();
  if (await isVisible(clear)) {
    await clear.click().catch(() => undefined);
    await sleep(500);
  }
  for (let i = 0; i < 4 && (await composerMedia(page)).length > 0; i++) {
    const cancel = page
      .locator('button')
      .filter({ hasText: /^\s*cancel\s*$/ })
      .last();
    if (!(await isVisible(cancel))) break;
    await cancel.click().catch(() => undefined);
    await sleep(400);
  }
  if ((await composerMedia(page)).length > 0) ctx.log.warn('composer still has attachments after clear');
}

// A fresh chat session per request stops the agent from reusing the previous request's attachment as first frame
async function newSession(ctx: AppContext, page: Page): Promise<void> {
  const b = page
    .locator('button')
    .filter({ hasText: /edit_square|새로운 세션|New session/ })
    .first();
  if (await isVisible(b)) {
    await b.click().catch(() => undefined);
    await sleep(1500);
    ctx.log.info('started a new agent session');
  }
}

async function ensureComposer(ctx: AppContext, page: Page, keepSession: boolean): Promise<void> {
  await closeSidePanels(page);
  if (!(await isVisible(iconButton(page, 'send').first()))) {
    ctx.log.info('composer not visible, reloading project page');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(5000);
    await closeSidePanels(page);
    if (!(await isVisible(iconButton(page, 'send').first()))) {
      throw new FlowError(
        'UI_NOT_FOUND',
        'agent composer (arrow_forward button) not found on the project page',
        {},
        await takeScreenshot(page, path.join(ctx.config.stateDir, 'screenshots'), 'no-composer'),
      );
    }
  }
  await clearComposer(ctx, page);
  if (!keepSession) await newSession(ctx, page);
}

// Agent settings popover: "confirm before generating" = Never, then the ratio / count / model for the media kind.
// The popover lists the image section first and the video section last, so same-label buttons are picked by position.
const appliedDefaults = new Map<string, string>();
async function applyDefaults(
  ctx: AppContext,
  page: Page,
  projectUrl: string,
  kind: MediaKind,
  ratio: string,
  modelName: string,
  count: number,
): Promise<void> {
  const key = `${projectUrl}|${kind}|${ratio}|${modelName}|${count}`;
  if (appliedDefaults.get(`${projectUrl}|${kind}`) === key) return;
  const pick = (loc: Locator): Locator => (kind === 'video' ? loc.last() : loc.first());
  await clickSettingsTrigger(page);
  await page.getByText(label('agentSettings')).first().waitFor({ timeout: 10_000 });
  await sleep(500);
  const never = page.getByText(label('never', 'exact')).first();
  if (await isVisible(never)) {
    await never.click().catch(() => undefined);
    await sleep(300);
  }
  const ratioBtn = pick(page.locator('button').filter({ hasText: new RegExp(`${ratio.replace(':', '\\:')}\\s*$`) }));
  await ratioBtn.click().catch(() => ctx.log.warn('ratio button not found', { ratio }));
  const countBtn = pick(page.locator('button').filter({ hasText: new RegExp(`x${count}\\s*$`) }));
  await countBtn.click().catch(() => ctx.log.warn('count button not found', { count }));
  const modelRe =
    kind === 'video' ? /Omni|Veo/ : new RegExp(Object.values(IMAGE_MODELS).join('|').replace(/ /g, '\\s'));
  const modelBtn = pick(page.locator('button').filter({ hasText: modelRe }));
  const current = await modelBtn.innerText().catch(() => '');
  if (!current.includes(modelName)) {
    await modelBtn.click();
    await sleep(700);
    const opt = page.getByText(modelName, { exact: false }).last();
    if (await isVisible(opt)) await opt.click();
    else {
      ctx.log.warn('model option not visible', { model: modelName });
      await pressEscape(page);
    }
    await sleep(400);
  }
  await takeScreenshot(page, path.join(ctx.config.stateDir, 'screenshots'), `${kind}-defaults`);
  await labelButton(page, 'save', 'exact').first().click();
  await sleep(800);
  appliedDefaults.set(`${projectUrl}|${kind}`, key);
  ctx.log.info('agent defaults applied', { kind, ratio, model: modelName, count });
}

type ReferenceAttachmentResult = { attached: boolean; remoteId: string };

async function composerAttachButton(page: Page): Promise<Locator> {
  const localized = namedButton(page, 'attachToPrompt').first();
  if (await isVisible(localized)) return localized;
  // The material icon is language independent; .last() scopes to the composer control after the top-bar plus.
  const byIcon = iconButton(page, 'add').last();
  if (await isVisible(byIcon)) return byIcon;
  throw new FlowError('UI_NOT_FOUND', 'composer attach control not found by localized label or add icon');
}

async function attachExistingReference(
  ctx: AppContext,
  page: Page,
  filePath: string,
  expected: number,
  cachedRemoteId: string,
): Promise<ReferenceAttachmentResult> {
  if (!fs.existsSync(filePath)) {
    throw new FlowError('REFERENCE_NOT_ATTACHED', `reference image not found: ${filePath}`, { path: filePath });
  }
  const shots = path.join(ctx.config.stateDir, 'screenshots');
  const before = await composerMedia(page);
  if (before.length >= expected) return { attached: true, remoteId: cachedRemoteId };
  const attach = await composerAttachButton(page);
  if ((await attach.getAttribute('aria-expanded').catch(() => null)) === 'true') {
    await pressEscape(page, 500);
  }
  await attach.click();
  const reused = await selectCachedReference(page, cachedRemoteId, path.basename(filePath));
  if (referenceAction(cachedRemoteId, reused) === 'refuse_duplicate') {
    throw new FlowError(
      'REFERENCE_NOT_ATTACHED',
      'cached Flow reference is not available in the asset picker; refusing to upload a duplicate',
      { path: filePath, remote_id: cachedRemoteId },
      await takeScreenshot(page, shots, 'cached-reference-not-found'),
    );
  }
  const confirmCached = labelButton(page, 'addToPrompt', 'exact').first();
  try {
    await confirmCached.waitFor({ timeout: 10_000 });
  } catch {
    throw new FlowError(
      'REFERENCE_NOT_ATTACHED',
      'Flow selected the cached asset but did not expose a recognized confirm-to-prompt control; refusing any upload retry',
      { path: filePath, remote_id: cachedRemoteId, confirm_labels: 'Add to prompt / Incluir no comando' },
      await takeScreenshot(page, shots, 'cached-reference-confirm-not-found'),
    );
  }
  try {
    await confirmCached.click({ timeout: 10_000 });
  } catch {
    const attachedAfterClick = await waitForComposerMedia(page, expected);
    if (attachedAfterClick.length >= expected) return { attached: true, remoteId: cachedRemoteId };
    throw new FlowError(
      'REFERENCE_NOT_ATTACHED',
      'Flow closed the asset picker but the cached reference did not appear in the composer; refusing to upload again',
      { path: filePath, remote_id: cachedRemoteId, composer_attached: false },
      await takeScreenshot(page, shots, 'cached-reference-attach-timeout'),
    );
  }
  await sleep(800);
  const attachedCached = await waitForComposerMedia(page, expected);
  return { attached: attachedCached.length >= expected, remoteId: cachedRemoteId };
}

// Upload to Flow, confirm the picker action, then wait for both independent results:
// a composer thumbnail and the registered project-media UUID.
async function uploadAndAttachReference(
  ctx: AppContext,
  page: Page,
  filePath: string,
  expected: number,
  projectMediaBefore: Awaited<ReturnType<typeof mediaTiles>>,
  markPending: () => void,
): Promise<ReferenceAttachmentResult> {
  if (!fs.existsSync(filePath)) {
    throw new FlowError('REFERENCE_NOT_ATTACHED', `reference image not found: ${filePath}`, { path: filePath });
  }
  const shots = path.join(ctx.config.stateDir, 'screenshots');
  const attach = await composerAttachButton(page);
  if ((await attach.getAttribute('aria-expanded').catch(() => null)) === 'true') {
    await pressEscape(page, 500);
  }
  await attach.click();
  const upload = labelButton(page, 'uploadMedia').last();
  await upload.waitFor({ timeout: 10_000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), upload.click()]);
  markPending();
  await chooser.setFiles(filePath);
  ctx.log.info('reference file chosen', { filePath });
  const confirm = labelButton(page, 'addToPrompt', 'exact').first();
  try {
    await confirm.waitFor({ timeout: 60_000 });
  } catch {
    await takeScreenshot(page, shots, 'ref-not-in-picker');
    const projectId = await waitForNewProjectReference(page, filePath, projectMediaBefore, 15_000);
    if (!projectId) {
      throw await referenceAssetNotRegistered(ctx, page, filePath, expected, 'add-to-prompt control did not appear');
    }
    return { attached: (await composerMedia(page)).length >= expected, remoteId: projectId };
  }
  await confirm.click();
  await sleep(800);
  const [media, projectId] = await Promise.all([
    waitForComposerMedia(page, expected),
    waitForNewProjectReference(page, filePath, projectMediaBefore, 60_000),
  ]);
  if (!projectId) {
    throw await referenceAssetNotRegistered(
      ctx,
      page,
      filePath,
      expected,
      media.length >= expected
        ? 'composer attachment is visible but project enumeration returned zero matching assets'
        : 'upload was initiated but no project media ID appeared',
    );
  }
  if ((await page.locator('[role="dialog"]').count()) > 0) await pressEscape(page, 500);
  return { attached: media.length >= expected, remoteId: projectId };
}

async function waitForNewProjectReference(
  page: Page,
  filePath: string,
  before: Awaited<ReturnType<typeof mediaTiles>>,
  timeoutMs: number,
): Promise<string | undefined> {
  const oldIds = new Set(before.map((tile) => tile.uuid).filter((id): id is string => Boolean(id)));
  const filename = path.basename(filePath).trim().toLocaleLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tile = (await mediaTiles(page)).find(
      (item) =>
        item.kind === 'image' &&
        item.title.trim().toLocaleLowerCase() === filename &&
        item.uuid &&
        !oldIds.has(item.uuid),
    );
    if (tile?.uuid) return tile.uuid;
    await sleep(1000);
  }
  return undefined;
}

async function referenceAssetNotRegistered(
  ctx: AppContext,
  page: Page,
  filePath: string,
  expected: number,
  reason: string,
): Promise<FlowError> {
  const attached = (await composerMedia(page)).length >= expected;
  const currentTiles = await mediaTiles(page);
  const shots = path.join(ctx.config.stateDir, 'screenshots');
  return new FlowError(
    'REFERENCE_ASSET_NOT_REGISTERED',
    attached
      ? 'Flow shows the reference attached in the composer, but project media enumeration returned zero matching assets'
      : 'Flow did not expose a stable project media ID for the uploaded reference; refusing any retry upload',
    {
      path: filePath,
      composer_attached: attached,
      project_media_count: currentTiles.length,
      reason,
      pending: true,
    },
    await takeScreenshot(page, shots, 'reference-asset-not-registered'),
  );
}

async function waitForComposerMedia(page: Page, expected: number): Promise<string[]> {
  const t0 = Date.now();
  let media: string[] = [];
  while (Date.now() - t0 < 15_000) {
    await sleep(1000);
    media = await composerMedia(page);
    if (media.length >= expected) return media;
  }
  return media;
}

async function selectCachedReference(page: Page, remoteId: string, filename: string): Promise<boolean> {
  const options = page.locator('[role="option"]:visible');
  const targetUrl = (await mediaTiles(page)).find((tile) => tile.uuid === remoteId)?.url;
  const inventory = await options
    .evaluateAll((elements) =>
      elements.map((element) => {
        const el = element as HTMLElement;
        const mediaIds: string[] = [];
        const mediaUrls: string[] = [];
        for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
          if (node.id) mediaIds.push(node.id);
          for (const attribute of Array.from(node.attributes)) {
            if (attribute.name.startsWith('data-') && attribute.value) mediaIds.push(attribute.value);
          }
          if (node instanceof HTMLImageElement) {
            const url = node.currentSrc || node.src;
            if (url) mediaUrls.push(url);
          }
        }
        return {
          label: `${el.getAttribute('aria-label') ?? ''} ${el.innerText ?? ''}`.trim(),
          mediaIds: mediaIds.filter(Boolean),
          mediaUrls,
        };
      }),
    )
    .catch(() => []);
  const index = referencePickerOptionIndex(inventory, remoteId, filename, targetUrl);
  if (index === undefined) return false;
  try {
    await options.nth(index).click();
    return true;
  } catch {
    return false;
  }
}

// While an upload is still processing the composer silently ignores send; retry until the input empties
async function send(ctx: AppContext, page: Page, input: Locator, shots: string): Promise<void> {
  for (let i = 0; i < SEND_ATTEMPTS; i++) {
    if (i % 2 === 0) {
      await input.click().catch(() => undefined);
      await page.keyboard.press('End').catch(() => undefined);
      await page.keyboard.press('Enter').catch(() => undefined);
    } else {
      const sendBtn = iconButton(page, 'send').last();
      if (await sendBtn.isEnabled().catch(() => false)) await sendBtn.click().catch(() => undefined);
    }
    await sleep(5000);
    const remaining = (await input.innerText().catch(() => '')).trim();
    if (remaining.length < 20) {
      ctx.log.info('generation request sent');
      return;
    }
    if (i % 6 === 5) ctx.log.info('send not accepted yet, retrying', { elapsed_s: (i + 1) * 5 });
  }
  throw new FlowError(
    'SEND_FAILED',
    `composer still holds the prompt after ${(SEND_ATTEMPTS * 5).toString()}s; send did not go through`,
    {},
    await takeScreenshot(page, shots, 'send-failed'),
  );
}

function freshText(now: string, before: string): string {
  return now.length > before.length ? now.slice(Math.max(0, before.length - 200)) : '';
}

async function failIfPolicyBlocked(ctx: AppContext, page: Page, bodyBefore: string): Promise<void> {
  const fresh = freshText(await bodyText(page), bodyBefore);
  if (label('policyBlocked').test(fresh)) {
    throw new FlowError(
      'POLICY_BLOCKED',
      'generator refused the prompt as a possible policy violation; nothing generated',
      {},
      await takeScreenshot(page, path.join(ctx.config.stateDir, 'screenshots'), 'policy-blocked'),
    );
  }
}

// Card items are text nodes in the right-hand chat panel (below the top bar), not <button>s
async function findApproveButton(page: Page): Promise<Locator | null> {
  return firstInRegion(page, page.getByText(label('approve', 'exact')), 'right', 100);
}

async function awaitApproval(
  ctx: AppContext,
  page: Page,
  bodyBefore: string,
  kind: MediaKind,
  baselineTiles: number,
  timeoutMs: number,
  nudgeAllowed: boolean,
): Promise<string> {
  const shots = path.join(ctx.config.stateDir, 'screenshots');
  const t0 = Date.now();
  let nudges = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    const approve = await findApproveButton(page);
    if (approve) {
      const approvalText = (await bodyText(page)).slice(-1200);
      await takeScreenshot(page, shots, 'approval-card');
      await approve.click();
      ctx.log.info('approval clicked', { card: /크레딧[^\n]*|credits?[^\n]*/i.exec(approvalText)?.[0] });
      return approvalText;
    }
    await failIfPolicyBlocked(ctx, page, bodyBefore);
    const fresh = freshText(await bodyText(page), bodyBefore);
    if (label('generating').test(fresh)) {
      ctx.log.info('generation already running (no approval card)');
      return '';
    }
    if ((await tileCount(page, kind)) > baselineTiles) {
      ctx.log.info('new media tile appeared; generation started');
      return '';
    }
    // The agent often only announces what it will do and stops; a short follow-up gets it moving
    if (nudgeAllowed && nudges < 2 && Date.now() - t0 > 45_000 * (nudges + 1)) {
      const input = composerInput(page);
      await input.click().catch(() => undefined);
      await input
        .fill('Yes, proceed and generate it now, using the image I attached in my previous message as the reference.')
        .catch(() => undefined);
      await page.keyboard.press('Enter').catch(() => undefined);
      nudges++;
      ctx.log.info('nudged agent to proceed', { nudges });
    }
  }
  // With "confirm before generating: Never" there is usually no card at all; media polling decides
  return '';
}

// Flow's grid is newest-first and its tile addresses are re-signed over time, so outputs are identified by
// position: whatever grew the count of tiles of this kind since the baseline is what this job produced.
async function tileCount(page: Page, kind: MediaKind): Promise<number> {
  return (await mediaTiles(page)).filter((t) => t.kind === kind).length;
}

async function awaitOutputs(
  ctx: AppContext,
  page: Page,
  args: GenerateArgs,
  jobId: string,
  baselineTiles: number,
  bodyBefore: string,
  shots: string,
): Promise<{ path: string; media_id: string; title: string }[]> {
  fs.mkdirSync(args.outputDir, { recursive: true });
  const onDisk = downloadedPrefixes(args.outputDir);
  const tried = new Set<string>();
  const files: { path: string; media_id: string; title: string }[] = [];
  const t0 = Date.now();
  let exactCountSince = 0;
  let exactTileCount = -1;
  let lastShot = 0;
  let lastReload = Date.now();
  while (Date.now() - t0 < ctx.config.generationTimeoutMs) {
    await sleep(ctx.config.pollIntervalMs);
    await failIfPolicyBlocked(ctx, page, bodyBefore);
    // Flow's SPA does not push finished generations into the grid — polling the DOM alone shows the
    // baseline count forever, so every job timed out while the videos were in fact ready (byblos-book
    // 2026-09-05: 6 tiles reported for 30 min while the project grew from 5 to 8). Reload to pull them in.
    if (Date.now() - lastReload > 60_000) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await sleep(4000);
      lastReload = Date.now();
    }
    const tiles = (await mediaTiles(page)).filter((t) => t.kind === args.kind);
    const newlyCreated = tiles.slice(0, Math.max(0, tiles.length - baselineTiles));
    try {
      assertNoExcessOutputs(
        args.count,
        newlyCreated.length,
        newlyCreated.flatMap((tile) => (tile.uuid ? [tile.uuid] : [])),
      );
    } catch {
      const discrepancy = {
        requested: args.count,
        returned: newlyCreated.length,
        media: newlyCreated.map((tile) => ({ uuid: tile.uuid, title: tile.title, kind: tile.kind })),
      };
      ctx.log.error('Flow output count mismatch', { job_id: jobId, ...discrepancy });
      throw new FlowError(
        'OUTPUT_COUNT_MISMATCH',
        `Flow returned ${newlyCreated.length} output tiles for a request of ${args.count}; stopping without another generation`,
        discrepancy,
        await takeScreenshot(page, shots, 'output-count-mismatch'),
      );
    }
    if (newlyCreated.length === args.count) {
      if (exactTileCount !== newlyCreated.length) {
        exactTileCount = newlyCreated.length;
        exactCountSince = Date.now();
      }
    } else {
      exactTileCount = newlyCreated.length;
      exactCountSince = 0;
    }
    const fresh = newlyCreated.filter((t) => !tried.has(t.url));
    if (fresh.length > 0) {
      await sleep(3000); // the thumbnail appears before encoding finishes
      for (const tile of fresh) {
        const attempt = await tryDownload(ctx.session.getContext(), tileUrl(tile), args.kind, args.outputDir, jobId);
        if (attempt.outcome !== 'ok') {
          ctx.log.warn('download retry later', { title: tile.title, reason: attempt.reason });
          continue;
        }
        tried.add(tile.url);
        const { media_id, path: file, bytes } = attempt.file;
        // A re-signed address makes the same clip look like a new tile; the digest is what says otherwise
        if (files.some((f) => f.media_id === media_id)) continue;
        if (files.length >= args.count) {
          throw new FlowError(
            'OUTPUT_COUNT_MISMATCH',
            `Flow returned more than the requested ${args.count} ${args.kind} files; stopping before registering extras`,
            { requested: args.count, returned_at_least: files.length + 1, media_id },
            await takeScreenshot(page, shots, 'output-count-mismatch'),
          );
        }
        ctx.log.info(onDisk.has(media_id) ? 'output already downloaded' : 'output downloaded', {
          id: media_id,
          path: file,
          bytes,
        });
        onDisk.add(media_id);
        files.push({ path: file, media_id, title: tile.title });
      }
    }
    // Wait for the project grid to settle after the requested number is downloaded. Some Flow calls
    // briefly expose one tile before the remaining outputs from the same request arrive.
    if (files.length === args.count && exactCountSince > 0 && Date.now() - exactCountSince >= 15_000) return files;
    const minute = Math.floor((Date.now() - t0) / 60_000);
    if (minute > lastShot) {
      lastShot = minute;
      await takeScreenshot(page, shots, `wait-${minute}m`);
    }
  }
  if (files.length !== args.count) {
    if (files.length > 0) {
      throw new FlowError(
        'OUTPUT_COUNT_MISMATCH',
        `Flow produced ${files.length} downloadable ${args.kind} files for a request of ${args.count}`,
        { requested: args.count, returned: files.length, media_ids: files.map((file) => file.media_id) },
        await takeScreenshot(page, shots, 'output-count-mismatch'),
      );
    }
    throw new FlowError(
      'GENERATION_TIMEOUT',
      `no ${args.kind}/* media appeared within ${Math.round(ctx.config.generationTimeoutMs / 1000)}s`,
      { baseline_tiles: baselineTiles, tiles_now: await tileCount(page, args.kind) },
      await takeScreenshot(page, shots, 'generation-timeout'),
    );
  }
  return files;
}

export function describeJob(job: Job): Record<string, unknown> {
  return { job_id: job.job_id, kind: job.kind, phase: job.phase, created_at: job.created_at, model: job.model };
}
