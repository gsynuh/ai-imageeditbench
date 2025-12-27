export function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function createStableId(
  prefix: string,
  stableKey: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${prefix}:${stableKey}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer);
  const slice = bytes.slice(0, 16); // 128-bit is plenty; keeps IDs shorter
  const hex = Array.from(slice)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  wait = 300,
) {
  let timeout: number | undefined;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}

export function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString();
}

export function formatDateTime(timestamp: number) {
  return `${formatDate(timestamp)} ${formatTimestamp(timestamp)}`;
}

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms)) return "";
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(2)}s`;
  return `${(safe / 60_000).toFixed(2)}m`;
}
