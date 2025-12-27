import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Slider } from "../../../components/ui/slider";
import { getImage } from "../../../lib/idb";
import { clamp } from "../../../lib/image";
import { Download } from "lucide-react";

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
};

export default function ImageViewer({
  imageId,
  open,
  onClose,
}: {
  imageId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  type ImageViewerMeta = {
    width: number;
    height: number;
    mime: string;
    bytes: number;
    source?: {
      dataType: "data-url" | "url";
      value?: string;
      preview?: string;
      previewStart?: string;
      previewEnd?: string;
      length?: number;
      traces?: Array<{ source: string; chunkId?: number; location?: string }>;
    };
    blobSha256?: string;
    aHash?: string;
    dHash?: string;
    pixelSha256?: {
      hash: string;
      width: number;
      height: number;
      scaled?: boolean;
    };
  };
  const [meta, setMeta] = useState<ImageViewerMeta | null>(null);

  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!open || !imageId) return;
    let active = true;
    const load = async () => {
      const asset = await getImage(imageId);
      if (!asset || !active) return;
      const url = URL.createObjectURL(asset.blob);
      setObjectUrl(url);
      setMeta({
        width: asset.width,
        height: asset.height,
        mime: asset.mimeType,
        bytes: asset.blob.size,
      });
      // Reset zoom and pan when loading new image
      setZoom(1);
      setOffsetX(0);
      setOffsetY(0);
    };
    void load();
    return () => {
      active = false;
    };
  }, [open, imageId]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  // Calculate the scale needed to fit the image in the preview area
  const fitScale = useMemo(() => {
    if (!containerRef.current || !natural) return 1;
    const rect = containerRef.current.getBoundingClientRect();
    const maxW = rect.width;
    const maxH = rect.height;
    return Math.min(maxW / natural.width, maxH / natural.height);
  }, [natural]);

  // Calculate minimum zoom: use fitScale if smaller than 0.5, otherwise use 0.5 as minimum
  const minZoom = useMemo(() => {
    if (!fitScale) return 0.5;
    return Math.min(fitScale, 0.5);
  }, [fitScale]);

  // Set initial zoom to fit when natural dimensions are first available
  useEffect(() => {
    if (natural && containerRef.current && zoom === 1) {
      setZoom(fitScale);
      setOffsetX(0);
      setOffsetY(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural]);

  const clampPan = (nextX: number, nextY: number): { x: number; y: number } => {
    if (!containerRef.current || !natural) return { x: nextX, y: nextY };
    const rect = containerRef.current.getBoundingClientRect();
    const viewW = rect.width;
    const viewH = rect.height;
    const scaledW = natural.width * zoom;
    const scaledH = natural.height * zoom;

    // Only allow panning if the scaled image is larger than the viewport
    if (scaledW <= viewW && scaledH <= viewH) {
      return { x: 0, y: 0 };
    }

    // Calculate maximum pan distance (half the difference between scaled size and viewport)
    const maxX = Math.max(0, (scaledW - viewW) / 2);
    const maxY = Math.max(0, (scaledH - viewH) / 2);
    return { x: clamp(nextX, -maxX, maxX), y: clamp(nextY, -maxY, maxY) };
  };

  useEffect(() => {
    const clamped = clampPan(offsetX, offsetY);
    if (clamped.x !== offsetX) setOffsetX(clamped.x);
    if (clamped.y !== offsetY) setOffsetY(clamped.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, natural, open]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!natural) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const clamped = clampPan(drag.startOffsetX + dx, drag.startOffsetY + dy);
    setOffsetX(clamped.x);
    setOffsetY(clamped.y);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!natural || !containerRef.current) return;
    event.preventDefault();

    const delta = event.deltaY;
    const zoomFactor = delta > 0 ? 0.9 : 1.1;
    const newZoom = clamp(zoom * zoomFactor, minZoom, 5);

    // Get mouse position relative to container
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Calculate the point in image coordinates before zoom
    const containerCenterX = rect.width / 2;
    const containerCenterY = rect.height / 2;
    const imageX = (mouseX - containerCenterX - offsetX) / zoom;
    const imageY = (mouseY - containerCenterY - offsetY) / zoom;

    // Calculate new offset to keep the same point under the mouse
    const newOffsetX = mouseX - containerCenterX - imageX * newZoom;
    const newOffsetY = mouseY - containerCenterY - imageY * newZoom;

    const clamped = clampPan(newOffsetX, newOffsetY);
    setZoom(newZoom);
    setOffsetX(clamped.x);
    setOffsetY(clamped.y);
  };

  const handleDownload = async () => {
    if (!imageId || !objectUrl) return;
    try {
      const asset = await getImage(imageId);
      if (!asset) return;
      const url = URL.createObjectURL(asset.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `image-${imageId.slice(0, 8)}.${asset.mimeType.split("/")[1] || "png"}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("[ImageViewer] Error downloading image:", error);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : null)}>
      <DialogContent className="p-4">
        <DialogHeader className="flex-row items-center justify-between gap-3 pb-3 pr-12">
          <DialogTitle>Image Preview</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            disabled={!objectUrl}
            title="Download image"
          >
            <Download size={16} />
          </Button>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[1fr,260px]">
          <div
            ref={containerRef}
            className="relative h-[60vh] overflow-hidden rounded-xl border border-white/10 bg-black/20"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            style={{ touchAction: "none" }}
          >
            {objectUrl && (
              <img
                src={objectUrl}
                alt="preview"
                draggable={false}
                onLoad={(event) => {
                  const img = event.currentTarget;
                  setNatural({
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                  });
                }}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  maxWidth: "none",
                  transform: `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${zoom})`,
                  transformOrigin: "center center",
                  userSelect: "none",
                }}
              />
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-[var(--text)]">
              <div className="text-xs text-[var(--muted)]">Metadata</div>
              <div className="mt-1 space-y-1">
                <div>
                  Dimensions:{" "}
                  {meta?.width && meta?.height
                    ? `${meta.width} × ${meta.height}`
                    : natural
                      ? `${natural.width} × ${natural.height}`
                      : "unknown"}
                </div>
                <div>Type: {meta?.mime ?? "unknown"}</div>
                <div>
                  Size:{" "}
                  {meta ? `${Math.round(meta.bytes / 1024)} KB` : "unknown"}
                </div>
                {meta?.source && (
                  <div className="pt-1 border-t border-white/10 space-y-1">
                    <div className="text-xs text-[var(--muted)]">
                      Source Data
                    </div>
                    <div className="font-mono text-xs break-all">
                      {meta.source.dataType === "data-url"
                        ? (meta.source.preview ??
                          meta.source.previewStart ??
                          "(data url)")
                        : (meta.source.value ??
                          meta.source.preview ??
                          meta.source.previewStart ??
                          "unknown")}
                    </div>
                    {meta.source.dataType === "data-url" &&
                      meta.source.previewStart &&
                      meta.source.previewEnd && (
                        <div className="space-y-1">
                          <div>
                            <div className="text-xs text-[var(--muted)]">
                              Start
                            </div>
                            <div className="font-mono text-xs break-all">
                              {meta.source.previewStart}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-[var(--muted)]">
                              End
                            </div>
                            <div className="font-mono text-xs break-all">
                              {meta.source.previewEnd}
                            </div>
                          </div>
                        </div>
                      )}
                    {meta.source.length !== undefined && (
                      <div className="text-xs text-[var(--muted)]">
                        Length: {meta.source.length}
                      </div>
                    )}
                    {meta.source.traces && meta.source.traces.length > 0 && (
                      <div className="pt-1 space-y-1">
                        <div className="text-xs text-[var(--muted)]">
                          Source Trace
                        </div>
                        <div className="space-y-1">
                          {meta.source.traces.map((t, idx) => (
                            <div
                              key={idx}
                              className="font-mono text-xs break-all"
                            >
                              {t.source}
                              {t.chunkId !== undefined
                                ? ` (chunk ${t.chunkId})`
                                : ""}
                              {t.location ? ` :: ${t.location}` : ""}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {(meta?.blobSha256 ||
                  meta?.pixelSha256 ||
                  meta?.aHash ||
                  meta?.dHash) && (
                  <div className="pt-1 border-t border-white/10 space-y-1">
                    <div className="text-xs text-[var(--muted)]">
                      Diagnostics
                    </div>
                    {(meta.aHash || meta.dHash) && (
                      <div>
                        {meta.aHash && (
                          <div>
                            <div className="text-xs text-[var(--muted)]">
                              aHash
                            </div>
                            <div className="font-mono text-xs break-all">
                              {meta.aHash}
                            </div>
                          </div>
                        )}
                        {meta.dHash && (
                          <div className="mt-1">
                            <div className="text-xs text-[var(--muted)]">
                              dHash
                            </div>
                            <div className="font-mono text-xs break-all">
                              {meta.dHash}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {meta.blobSha256 && (
                      <div>
                        <div className="text-xs text-[var(--muted)]">
                          Blob SHA-256
                        </div>
                        <div className="font-mono text-xs break-all">
                          {meta.blobSha256}
                        </div>
                      </div>
                    )}
                    {meta.pixelSha256 && (
                      <div>
                        <div className="text-xs text-[var(--muted)]">
                          Pixels SHA-256{" "}
                          {meta.pixelSha256.scaled
                            ? `(${meta.pixelSha256.width}×${meta.pixelSha256.height}, scaled)`
                            : `(${meta.pixelSha256.width}×${meta.pixelSha256.height})`}
                        </div>
                        <div className="font-mono text-xs break-all">
                          {meta.pixelSha256.hash}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {imageId && (
                  <>
                    <div className="pt-1 border-t border-white/10 space-y-1">
                      <div>
                        <div className="text-xs text-[var(--muted)]">ID</div>
                        <div className="font-mono text-xs break-all">
                          {imageId}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                <span>Zoom</span>
                <span>{Math.round(zoom * 100)}%</span>
              </div>
              <Slider
                value={[zoom]}
                min={minZoom}
                max={5}
                step={0.01}
                onValueChange={(value) => setZoom(value[0] ?? 1)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (fitScale > 0) {
                      setZoom(fitScale);
                    } else {
                      setZoom(1);
                    }
                    setOffsetX(0);
                    setOffsetY(0);
                  }}
                >
                  Fit
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setZoom(1);
                    setOffsetX(0);
                    setOffsetY(0);
                  }}
                >
                  100%
                </Button>
              </div>
            </div>

            <div className="text-xs text-[var(--muted)]">
              Drag to pan. Scroll to zoom. Use the slider to adjust zoom.
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
