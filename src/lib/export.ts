import { zipSync, strToU8 } from "fflate";
import type { ImageAsset, Message, Session } from "../types/db";

function getImageExtension(mimeType: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "bin";
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

export async function exportSessionZip({
  session,
  messagesByModel,
  images,
}: {
  session: Session;
  messagesByModel: Record<string, Message[]>;
  images: Record<string, ImageAsset>;
}): Promise<Blob> {
  const markdownLines: string[] = [];
  markdownLines.push(`# Session ${session.id}`);
  markdownLines.push(`- Created: ${formatDate(session.createdAt)}`);
  markdownLines.push(`- Updated: ${formatDate(session.updatedAt)}`);
  markdownLines.push(`- Models: ${session.modelIds.join(", ")}`);
  markdownLines.push(`- Total tokens: ${session.totalTokens}`);
  markdownLines.push(
    `- Total cost: $${
      typeof session.totalCost === "number"
        ? session.totalCost.toFixed(4)
        : "0.0000"
    }`,
  );
  markdownLines.push("");
  for (const modelId of session.modelIds) {
    markdownLines.push(`## Model: ${modelId}`);
    const messages = messagesByModel[modelId] ?? [];
    for (const message of messages) {
      markdownLines.push(
        `### ${message.role.toUpperCase()} (${formatDate(message.createdAt)})`,
      );
      if (message.contentText) {
        markdownLines.push(message.contentText);
      }
      for (const imageId of message.imageIds) {
        const asset = images[imageId];
        if (!asset) continue;
        const ext = getImageExtension(asset.mimeType);
        markdownLines.push(`![${imageId}](images/${imageId}.${ext})`);
      }
      if (message.error) {
        markdownLines.push(`Error: ${message.error}`);
      }
      markdownLines.push("");
    }
  }

  const files: Record<string, Uint8Array> = {
    "session.md": strToU8(markdownLines.join("\n")),
  };

  for (const [imageId, asset] of Object.entries(images)) {
    const ext = getImageExtension(asset.mimeType);
    const buffer = await asset.blob.arrayBuffer();
    files[`images/${imageId}.${ext}`] = new Uint8Array(buffer);
  }

  const zipped = zipSync(files, { level: 9 });
  return new Blob([zipped as unknown as BlobPart], {
    type: "application/zip",
  });
}
