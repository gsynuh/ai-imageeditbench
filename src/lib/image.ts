export interface LoadedImage {
  element: HTMLImageElement;
  width: number;
  height: number;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function computeCoverScale({
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
}: {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}) {
  return Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
}

/**
 * Normalize an image file to a supported format (PNG)
 * This ensures compatibility with canvas operations
 */
export async function normalizeImageFormat(file: File): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Image load timeout. File may be in an unsupported format (${file.name}). Try converting to PNG/JPEG first.`,
          ),
        );
      }, 30000); // 30 second timeout
      image.onload = () => {
        clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Browser cannot decode this image format (${file.name}). TIFF and some other formats may not be supported. Try converting to PNG or JPEG.`,
          ),
        );
      };
      image.src = url;
    });

    // Always convert to PNG via canvas for maximum compatibility
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to get canvas context");
    }
    ctx.drawImage(img, 0, 0);

    // Convert to PNG blob
    const blob = await canvasToBlob(canvas, "image/png");
    // Preserve original filename but change extension to .png
    const baseName = file.name.replace(/\.[^/.]+$/, "");
    return new File([blob], `${baseName}.png`, { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downscale an image to a maximum dimension while maintaining aspect ratio
 * Also normalizes the format to PNG for compatibility
 */
export async function downscaleImage(
  file: File,
  maxDimension: number,
): Promise<File> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Image load timeout. File may be in an unsupported format (${file.name}). Try converting to PNG/JPEG first.`,
          ),
        );
      }, 30000); // 30 second timeout
      image.onload = () => {
        clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Browser cannot decode this image format (${file.name}). TIFF and some other formats may not be supported. Try converting to PNG or JPEG.`,
          ),
        );
      };
      image.src = url;
    });

    // Check if downscaling is needed
    const maxSize = Math.max(img.naturalWidth, img.naturalHeight);
    const needsDownscale = maxSize > maxDimension;

    // Calculate new dimensions maintaining aspect ratio
    let newWidth = img.naturalWidth;
    let newHeight = img.naturalHeight;
    if (needsDownscale) {
      const scale = maxDimension / maxSize;
      newWidth = Math.round(img.naturalWidth * scale);
      newHeight = Math.round(img.naturalHeight * scale);
    }

    // Always convert via canvas to ensure format compatibility
    const canvas = document.createElement("canvas");
    canvas.width = newWidth;
    canvas.height = newHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Unable to get canvas context");
    }
    ctx.drawImage(img, 0, 0, newWidth, newHeight);

    // Always convert to PNG for maximum compatibility
    const blob = await canvasToBlob(canvas, "image/png");
    const baseName = file.name.replace(/\.[^/.]+$/, "");
    return new File([blob], `${baseName}.png`, { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadImageFromFile(file: File): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const timeout = setTimeout(() => {
        reject(new Error("Image load timeout"));
      }, 30000); // 30 second timeout
      img.onload = () => {
        clearTimeout(timeout);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Unable to load image. File type: ${file.type || "unknown"}, Size: ${file.size} bytes`,
          ),
        );
      };
      img.src = url;
    });
    return {
      element,
      width: element.naturalWidth,
      height: element.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function centerCropSquare(
  source: LoadedImage,
  size: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const minSide = Math.min(source.width, source.height);
  const sx = Math.floor((source.width - minSide) / 2);
  const sy = Math.floor((source.height - minSide) / 2);
  ctx.drawImage(source.element, sx, sy, minSide, minSide, 0, 0, size, size);
  return canvas;
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality = 0.92,
): Promise<Blob> {
  return await new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob ?? new Blob());
      },
      type,
      quality,
    );
  });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
