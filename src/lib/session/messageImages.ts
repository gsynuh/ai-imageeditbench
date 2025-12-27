import type { ImageAsset, Message } from "../../types/db";
import type { OpenRouterAttachment } from "../openrouter";
import { getImage, saveImage } from "../idb";
import { createId, createStableId } from "../utils";

const inFlightByUrl = new Map<string, Promise<string | null>>();

async function getImageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number }> {
  try {
    if ("createImageBitmap" in window) {
      const bitmap = await createImageBitmap(blob);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();
      return { width, height };
    }
  } catch {
    // ignore
  }
  try {
    const url = URL.createObjectURL(blob);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode image"));
      img.src = url;
    });
    URL.revokeObjectURL(url);
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return { width: 0, height: 0 };
  }
}

function isLikelyImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".gif")
  );
}

function attachmentToUrl(attachment: OpenRouterAttachment): string | null {
  if (attachment.url) return attachment.url;
  if (attachment.dataBase64) {
    if (attachment.dataBase64.startsWith("data:")) return attachment.dataBase64;
    const mime = attachment.mimeType || "application/octet-stream";
    return `data:${mime};base64,${attachment.dataBase64}`;
  }
  return null;
}

type MarkdownImageMatch = {
  full: string;
  alt: string;
  url: string;
};

function extractMarkdownImages(text: string): MarkdownImageMatch[] {
  const matches: MarkdownImageMatch[] = [];
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text))) {
    matches.push({
      full: match[0],
      alt: match[1] ?? "",
      url: match[2] ?? "",
    });
  }
  return matches;
}

function extractBase64Images(text: string): string[] {
  const base64Regex =
    /data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+/gi;
  return text.match(base64Regex) ?? [];
}

function resolveMarkdownImageUrl(
  rawUrl: string,
  attachmentByName: Map<string, OpenRouterAttachment>,
): string | null {
  const url = rawUrl.trim();
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:")
  ) {
    return url;
  }
  if (url.startsWith("attachment://")) {
    const name = url.replace("attachment://", "");
    const attachment = attachmentByName.get(name);
    if (!attachment) return null;
    return attachmentToUrl(attachment);
  }
  return null;
}

export async function storeRemoteImage(url: string): Promise<string | null> {
  const existing = inFlightByUrl.get(url);
  if (existing) return await existing;

  const promise = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();

      const id = await createStableId("image", url);
      const already = await getImage(id);
      if (already) return id;

      const dimensions = await getImageDimensions(blob);
      const asset: ImageAsset = {
        id,
        blob,
        mimeType: blob.type || "image/png",
        width: dimensions.width,
        height: dimensions.height,
        bytes: blob.size,
        createdAt: Date.now(),
      };
      await saveImage(asset);
      return asset.id;
    } catch {
      // Fallback to random ID (e.g. if WebCrypto isn't available)
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const blob = await response.blob();
        const dimensions = await getImageDimensions(blob);
        const asset: ImageAsset = {
          id: createId("image"),
          blob,
          mimeType: blob.type || "image/png",
          width: dimensions.width,
          height: dimensions.height,
          bytes: blob.size,
          createdAt: Date.now(),
        };
        await saveImage(asset);
        return asset.id;
      } catch {
        return null;
      }
    } finally {
      inFlightByUrl.delete(url);
    }
  })();

  inFlightByUrl.set(url, promise);
  return await promise;
}

export function collectImageUrlsFromAttachments(
  attachments: OpenRouterAttachment[],
): string[] {
  return attachments
    .filter((attachment) => {
      if (attachment.mimeType?.startsWith("image/")) return true;
      if (attachment.name && isLikelyImageName(attachment.name)) return true;
      if (attachment.url?.startsWith("data:image/")) return true;
      return false;
    })
    .map((attachment) => attachmentToUrl(attachment))
    .filter((url): url is string => Boolean(url));
}

export function collectImageUrlsFromMessageText(
  contentText: string,
  attachments: OpenRouterAttachment[],
): string[] {
  if (!contentText) return [];

  const attachmentByName = new Map<string, OpenRouterAttachment>();
  attachments.forEach((attachment) => {
    if (attachment.name) attachmentByName.set(attachment.name, attachment);
  });

  const urls: string[] = [];

  for (const base64Url of extractBase64Images(contentText)) {
    urls.push(base64Url);
  }

  for (const img of extractMarkdownImages(contentText)) {
    const resolved = resolveMarkdownImageUrl(img.url, attachmentByName);
    if (resolved) urls.push(resolved);
  }

  return urls;
}

export async function storeImagesFromUrls(urls: string[]): Promise<string[]> {
  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    uniqueUrls.push(url);
  }

  const storedIds: string[] = [];
  for (const url of uniqueUrls) {
    const imageId = await storeRemoteImage(url);
    if (imageId) storedIds.push(imageId);
  }
  return storedIds;
}

export async function resolveAndStoreMessageImages(options: {
  message: Message;
  imageUrls: string[];
  attachments: OpenRouterAttachment[];
  includeText?: boolean;
  keepOnlyLast?: boolean;
}): Promise<string[]> {
  const includeText = options.includeText ?? true;
  const urls = [
    ...options.imageUrls,
    ...collectImageUrlsFromAttachments(options.attachments),
    ...(includeText
      ? collectImageUrlsFromMessageText(
          options.message.contentText,
          options.attachments,
        )
      : []),
  ];

  const storedIds: string[] = [];
  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    uniqueUrls.push(url);
  }
  for (const url of uniqueUrls) {
    const imageId = await storeRemoteImage(url);
    if (!imageId) continue;
    storedIds.push(imageId);
  }

  if (storedIds.length > 0) {
    options.message.imageIds = [...options.message.imageIds, ...storedIds];
    options.message.updatedAt = Date.now();
  }

  return storedIds;
}
