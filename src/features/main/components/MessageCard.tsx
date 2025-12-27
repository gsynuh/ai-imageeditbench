import { useStore } from "@nanostores/react";
import type { Message } from "../../../types/db";
import styles from "../MainView.module.scss";
import { Button } from "../../../components/ui/button";
import { formatDuration, formatTimestamp } from "../../../lib/utils";
import {
  $uiState,
  toggleCollapsedBlock,
  toggleCollapsedMessage,
  toggleHiddenMessage,
} from "../../../stores/uiStore";
import { Trash2, ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";

export default function MessageCard({
  message,
  images,
  onRemove,
  onOpenImage,
}: {
  message: Message;
  images: Array<{ id: string; url: string }>;
  onRemove: () => void;
  onOpenImage: (imageId: string) => void;
}) {
  const uiState = useStore($uiState);
  const isCollapsible = message.role === "system" || message.role === "tool";
  const isCollapsed =
    isCollapsible && uiState.collapsedMessageIds.has(message.id);
  const isHidden = uiState.hiddenMessageIds.has(message.id);
  const reasoningId = `${message.id}:reasoning`;
  const thinkingId = `${message.id}:thinking`;
  const reasoningCollapsed = uiState.collapsedBlockIds.has(reasoningId);
  const thinkingCollapsed = uiState.collapsedBlockIds.has(thinkingId);
  const hasReasoning = Boolean(message.contentReasoning?.trim());
  const hasThinking = Boolean(message.contentThinking?.trim());
  const ttfbMs =
    message.firstTokenAt !== undefined
      ? message.firstTokenAt - message.createdAt
      : null;
  const totalMs =
    message.completedAt !== undefined
      ? message.completedAt - message.createdAt
      : null;

  return (
    <div
      className={`${styles.messageCard} ${
        message.role === "system"
          ? styles.messageSystem
          : message.role === "assistant"
            ? styles.messageAssistant
            : message.role === "tool"
              ? styles.messageTool
              : styles.messageUser
      }`}
    >
      <div className={styles.messageMeta}>
        <span>{message.role.toUpperCase()}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => toggleHiddenMessage(message.id)}
            className="h-6 w-6 p-0"
            title={isHidden ? "Show message" : "Hide message"}
          >
            {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
          <span>{formatTimestamp(message.createdAt)}</span>
        </div>
      </div>
      {!isCollapsed && !isHidden && (
        <>
          {/* Show error for assistant messages only */}
          {message.error && message.role === "assistant" && (
            <div
              className={`text-xs text-[var(--danger)] break-words whitespace-pre-wrap ${styles.messageError}`}
            >
              {message.error}
            </div>
          )}
          {/* Show reasoning/thinking FIRST, before main content - always expanded by default */}
          {(hasReasoning || hasThinking) && (
            <div className="flex flex-col gap-2 mb-3">
              {hasReasoning && (
                <div className={styles.reasoningBlock}>
                  <div className={styles.reasoningLabel}>
                    <span className="font-medium">Reasoning</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => toggleCollapsedBlock(reasoningId)}
                    >
                      {reasoningCollapsed ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronUp size={16} />
                      )}
                      {reasoningCollapsed ? "Show" : "Hide"}
                    </Button>
                  </div>
                  {!reasoningCollapsed && (
                    <div className="whitespace-pre-wrap break-words opacity-50 text-sm">
                      {message.contentReasoning}
                    </div>
                  )}
                </div>
              )}
              {hasThinking && (
                <div className={styles.reasoningBlock}>
                  <div className={styles.reasoningLabel}>
                    <span className="font-medium">Thinking</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => toggleCollapsedBlock(thinkingId)}
                    >
                      {thinkingCollapsed ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronUp size={16} />
                      )}
                      {thinkingCollapsed ? "Show" : "Hide"}
                    </Button>
                  </div>
                  {!thinkingCollapsed && (
                    <div className="whitespace-pre-wrap break-words text-sm">
                      {message.contentThinking}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Main content text */}
          {message.contentText && (
            <div className={message.status === "streaming" ? "opacity-70" : ""}>
              {message.contentText}
            </div>
          )}
          {/* Images */}
          {images.length > 0 && (
            <div className={styles.imagePreview}>
              {images.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  className="cursor-zoom-in relative group"
                  onClick={() => onOpenImage(img.id)}
                  title={`Image ID: ${img.id}`}
                >
                  <img src={img.url} alt="message" />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-xs font-mono text-white p-1 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] break-all">
                    {img.id.slice(0, 16)}...
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* Streaming indicator for assistant messages */}
          {message.role === "assistant" && message.status === "streaming" && (
            <div className={styles.streamingIndicator}>
              <span>streaming</span>
              <span className={styles.streamingDots}>
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </div>
          )}
          {message.role === "assistant" &&
            (ttfbMs !== null || totalMs !== null) && (
              <div className={styles.messageTiming}>
                {ttfbMs !== null && <span>TTFB {formatDuration(ttfbMs)}</span>}
                {totalMs !== null && (
                  <span>Total {formatDuration(totalMs)}</span>
                )}
              </div>
            )}
        </>
      )}
      <div className={styles.messageActions}>
        {isCollapsible && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => toggleCollapsedMessage(message.id)}
          >
            {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            {isCollapsed ? "Expand" : "Collapse"}
          </Button>
        )}
        <Button variant="ghost" size="sm" type="button" onClick={onRemove}>
          <Trash2 size={16} />
          Remove
        </Button>
      </div>
    </div>
  );
}
