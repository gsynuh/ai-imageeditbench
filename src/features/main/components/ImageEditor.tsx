import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Slider } from "../../../components/ui/slider";
import styles from "../MainView.module.scss";
import {
  clamp,
  computeCoverScale,
  downscaleImage,
  loadImageFromFile,
} from "../../../lib/image";

const SIZE_OPTIONS = [256, 512, 1024] as const;
const PREVIEW_SIZE = 420;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
};

function drawCropped({
  ctx,
  image,
  targetSize,
  zoom,
  offsetX,
  offsetY,
}: {
  ctx: CanvasRenderingContext2D;
  image: HTMLImageElement;
  targetSize: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
}) {
  ctx.clearRect(0, 0, targetSize, targetSize);

  const baseScale = computeCoverScale({
    sourceWidth: image.naturalWidth,
    sourceHeight: image.naturalHeight,
    targetWidth: targetSize,
    targetHeight: targetSize,
  });
  const scale = baseScale * zoom;
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  const x = targetSize / 2 - drawW / 2 + offsetX;
  const y = targetSize / 2 - drawH / 2 + offsetY;
  ctx.drawImage(image, x, y, drawW, drawH);
}

function clampOffsets({
  image,
  targetSize,
  zoom,
  offsetX,
  offsetY,
}: {
  image: HTMLImageElement;
  targetSize: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
}) {
  const baseScale = computeCoverScale({
    sourceWidth: image.naturalWidth,
    sourceHeight: image.naturalHeight,
    targetWidth: targetSize,
    targetHeight: targetSize,
  });
  const scale = baseScale * zoom;
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  const maxX = Math.max(0, (drawW - targetSize) / 2);
  const maxY = Math.max(0, (drawH - targetSize) / 2);
  return {
    offsetX: clamp(offsetX, -maxX, maxX),
    offsetY: clamp(offsetY, -maxY, maxY),
  };
}

export default function ImageEditor({
  file,
  open,
  onConfirm,
  onCancel,
}: {
  file: File;
  open: boolean;
  onConfirm: (blob: Blob, size: number) => void;
  onCancel: () => void;
}) {
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<(typeof SIZE_OPTIONS)[number]>(512);
  const [zoom, setZoom] = useState(1.2);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const setOffsetsClamped = (nextX: number, nextY: number) => {
    if (!image) {
      setOffsetX(nextX);
      setOffsetY(nextY);
      return;
    }
    const clamped = clampOffsets({
      image,
      targetSize: PREVIEW_SIZE,
      zoom,
      offsetX: nextX,
      offsetY: nextY,
    });
    setOffsetX(clamped.offsetX);
    setOffsetY(clamped.offsetY);
  };

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        // Downscale image to max 2048x2048 and normalize format to PNG
        // This ensures compatibility with all image formats
        const processedFile = await downscaleImage(file, 2048);
        const loaded = await loadImageFromFile(processedFile);
        if (!active) return;
        setImage(loaded.element);
        setZoom(1.2);
        setOffsetX(0);
        setOffsetY(0);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error("[ImageEditor] Error processing image:", error);
        }
        // Fallback: try to normalize format without downscaling
        try {
          const { normalizeImageFormat } = await import("../../../lib/image");
          const normalizedFile = await normalizeImageFormat(file);
          const loaded = await loadImageFromFile(normalizedFile);
          if (!active) return;
          setImage(loaded.element);
          setZoom(1.2);
          setOffsetX(0);
          setOffsetY(0);
        } catch (normalizeError) {
          if (import.meta.env.DEV) {
            console.error(
              "[ImageEditor] Format normalization failed:",
              normalizeError,
            );
          }
          // Last resort: try loading original file directly
          try {
            const loaded = await loadImageFromFile(file);
            if (!active) return;
            setImage(loaded.element);
            setZoom(1.2);
            setOffsetX(0);
            setOffsetY(0);
          } catch (finalError) {
            if (import.meta.env.DEV) {
              console.error(
                "[ImageEditor] All load attempts failed:",
                finalError,
              );
            }
          }
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [file]);

  useEffect(() => {
    if (!image || !previewCanvasRef.current) return;
    const canvas = previewCanvasRef.current;
    canvas.width = PREVIEW_SIZE;
    canvas.height = PREVIEW_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawCropped({
      ctx,
      image,
      targetSize: PREVIEW_SIZE,
      zoom,
      offsetX,
      offsetY,
    });
  }, [image, zoom, offsetX, offsetY]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setOffsetsClamped(drag.startOffsetX + dx, drag.startOffsetY + dy);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
  };

  const handleConfirm = async () => {
    if (!image) return;
    const outCanvas = document.createElement("canvas");
    outCanvas.width = size;
    outCanvas.height = size;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) return;
    const scaleFactor = size / PREVIEW_SIZE;
    drawCropped({
      ctx,
      image,
      targetSize: size,
      zoom,
      offsetX: offsetX * scaleFactor,
      offsetY: offsetY * scaleFactor,
    });
    const blob = await new Promise<Blob>((resolve) =>
      outCanvas.toBlob((result) => resolve(result ?? new Blob()), "image/png"),
    );
    onConfirm(blob, size);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : null)}>
      <DialogContent className={styles.imageEditor}>
        <DialogHeader>
          <DialogTitle>Quick Edit</DialogTitle>
          <DialogDescription>
            Drag to pan. Use the slider to zoom. Output is square.
          </DialogDescription>
        </DialogHeader>

        <div className={styles.imageEditorLayout}>
          <div>
            <canvas
              ref={previewCanvasRef}
              className={styles.imageEditorCanvas}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              style={{ touchAction: "none", cursor: "grab" }}
            />
            <div className="mt-2 text-xs text-[var(--muted)]">
              Tip: zoom first, then drag to frame the subject.
            </div>
          </div>

          <div className={styles.imageEditorSidebar}>
            <div className={styles.imageEditorControl}>
              <label className="text-xs text-[var(--muted)]">Zoom</label>
              <Slider
                value={[zoom]}
                min={1}
                max={3}
                step={0.01}
                onValueChange={(value) => {
                  const nextZoom = value[0] ?? 1;
                  setZoom(nextZoom);
                  if (!image) return;
                  const clamped = clampOffsets({
                    image,
                    targetSize: PREVIEW_SIZE,
                    zoom: nextZoom,
                    offsetX,
                    offsetY,
                  });
                  setOffsetX(clamped.offsetX);
                  setOffsetY(clamped.offsetY);
                }}
              />
              <div className={styles.imageEditorHint}>
                {Math.round(zoom * 100)}%
              </div>
            </div>

            <div className={styles.imageEditorControl}>
              <label className="text-xs text-[var(--muted)]">Output size</label>
              <div className="flex flex-wrap gap-2">
                {SIZE_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    variant={size === option ? "default" : "outline"}
                    size="sm"
                    type="button"
                    onClick={() => setSize(option)}
                  >
                    {option}px
                  </Button>
                ))}
              </div>
              <div className={styles.imageEditorHint}>
                Output: {size} × {size}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.imageEditorActions}>
          <span className="text-xs text-[var(--muted)]">
            Pan on the image area to reposition.
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={handleConfirm}
              disabled={!image}
            >
              Add Image
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
