import type { ClipboardEvent, DragEvent } from "react";
import { useMemo, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import styles from "../MainView.module.scss";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { SelectPopover } from "../../../components/ui/select-popover";
import {
  $inputState,
  addPendingImage,
  clearInput,
  removePendingImage,
  setInputRole,
  setInputText,
  setMultiplier,
} from "../../../stores/inputStore";
import { $settings } from "../../../stores/settingsStore";
import {
  pushMessageToAll,
  sendMessageToAll,
} from "../../../stores/conversationsStore";
import ImageEditor from "./ImageEditor";
import { ImagePlus, Send, Upload, X } from "lucide-react";

export default function InputDock() {
  const inputState = useStore($inputState);
  const settings = useStore($settings);
  const [editorFile, setEditorFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canSend = settings.selectedModelIds.length > 0 && settings.apiKey;

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    // Be more lenient: check file type OR extension
    // Some files may have incorrect or missing MIME types
    const hasImageType = file.type.startsWith("image/");
    const hasImageExtension =
      /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif|ico|tif|tiff)$/i.test(
        file.name,
      );
    if (!hasImageType && !hasImageExtension) {
      if (import.meta.env.DEV) {
        console.warn(
          "[InputDock] File doesn't appear to be an image:",
          file.name,
          file.type,
        );
      }
      return;
    }
    setEditorFile(file);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    handleFiles(event.dataTransfer.files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData.items;
    for (const item of items) {
      // Accept if it's an image type OR if it's a file with image extension
      if (
        item.type.startsWith("image/") ||
        (item.kind === "file" &&
          /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif|ico|tif|tiff)$/i.test(
            item.type || "",
          ))
      ) {
        const file = item.getAsFile();
        if (file) {
          setEditorFile(file);
          break;
        }
      }
    }
  };

  const handleConfirmImage = (blob: Blob, size: number) => {
    const file = new File([blob], `edited-${size}.png`, { type: blob.type });
    addPendingImage(file, size);
    setEditorFile(null);
  };

  const handleSend = async () => {
    const stateToSend = { ...inputState };
    clearInput();
    await sendMessageToAll(stateToSend);
  };

  const handlePush = async () => {
    const stateToPush = { ...inputState };
    clearInput();
    await pushMessageToAll(stateToPush);
  };

  const previewList = useMemo(
    () =>
      inputState.pendingImages.map((image) => ({
        id: image.id,
        url: image.previewUrl,
      })),
    [inputState.pendingImages],
  );

  return (
    <div className={styles.inputDock}>
      {editorFile && (
        <ImageEditor
          open={Boolean(editorFile)}
          file={editorFile}
          onCancel={() => setEditorFile(null)}
          onConfirm={handleConfirmImage}
        />
      )}
      <div
        className={styles.inputGrid}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
      >
        <div className={styles.inputTopRow}>
          <div className={styles.inputBlockNarrow}>
            <SelectPopover
              value={inputState.role}
              onValueChange={(value) =>
                setInputRole(value as "system" | "user")
              }
              placeholder="Select role"
              items={[
                { value: "system", label: "System" },
                { value: "user", label: "User" },
              ]}
            />
          </div>
          <div className={styles.inputBlockNarrow}>
            <SelectPopover
              value={inputState.multiplier.toString()}
              onValueChange={(value) => setMultiplier(Number(value))}
              placeholder="Runs"
              items={[
                { value: "1", label: "1x" },
                { value: "2", label: "2x" },
                { value: "3", label: "3x" },
                { value: "4", label: "4x" },
              ]}
            />
          </div>
          <div className={styles.inputBlockNarrow}>
            <Input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => handleFiles(event.target.files)}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              className={styles.addImageButton}
            >
              <ImagePlus size={16} />
              Add Image
            </Button>
          </div>
          <div className={styles.inputSpacer}></div>
          <div className={styles.inputActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={handlePush}
              disabled={!settings.selectedModelIds.length}
            >
              <Upload size={16} />
              Push
            </Button>
            <Button type="button" onClick={handleSend} disabled={!canSend}>
              <Send size={16} />
              Send
            </Button>
          </div>
        </div>

        <div className={styles.inputBottomRow}>
          <div className={`${styles.inputBlock} ${styles.inputBlockWide}`}>
            <label htmlFor="prompt" className="text-xs text-[var(--muted)]">
              Message
            </label>
            <Textarea
              id="prompt"
              placeholder="Type or drop an image to compare models."
              rows={4}
              value={inputState.text}
              onChange={(event) => setInputText(event.target.value)}
              onPaste={onPaste}
            />
          </div>
          {previewList.length > 0 && (
            <div className={styles.inputImagePreviews}>
              {previewList.map((preview) => (
                <div key={preview.id} className={styles.inputImageThumbnail}>
                  <img src={preview.url} alt="preview" />
                  <button
                    type="button"
                    className={styles.inputImageRemove}
                    onClick={() => removePendingImage(preview.id)}
                    aria-label="Remove image"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {!settings.apiKey && (
        <p className="text-xs text-[var(--muted)] mt-3">
          Add your OpenRouter API key in Settings to enable Send.
        </p>
      )}
    </div>
  );
}
