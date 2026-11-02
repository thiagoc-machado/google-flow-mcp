export interface ReferencePickerOption {
  label: string;
  mediaIds: string[];
  mediaUrls?: string[];
}

/** Prefer the stable Flow ID; a filename fallback is safe only when exactly one option matches. */
export function referencePickerOptionIndex(
  options: ReferencePickerOption[],
  remoteId: string,
  filename: string,
  mediaUrl?: string,
): number | undefined {
  const byId = options.findIndex((option) => option.mediaIds.some((id) => id === remoteId || id.includes(remoteId)));
  if (byId >= 0) return byId;

  const token = mediaUrl?.match(/\/asb\/([^?=]+)/)?.[1];
  if (token) {
    const byUrl = options.findIndex((option) => option.mediaUrls?.some((url) => url.includes(token)));
    if (byUrl >= 0) return byUrl;
  }

  const normalizedName = filename.trim().toLocaleLowerCase();
  const byName = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => {
      const label = option.label.trim().toLocaleLowerCase();
      return label === normalizedName || label.startsWith(`${normalizedName} `);
    });
  return byName.length === 1 ? byName[0]?.index : undefined;
}
