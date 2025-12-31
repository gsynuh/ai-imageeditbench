import type {
  Session,
  SessionStats,
  DefaultsState,
  ImageAsset,
  Message,
  SettingsState,
} from "../types/db";
import { addNotification } from "@stores/notificationsStore";
import type { OpenRouterModel } from "../types/openrouter";

const DB_NAME = "image-edit-bench";
const DB_VERSION = 6;

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    createdAt: toFiniteNumber(session.createdAt),
    updatedAt: toFiniteNumber(session.updatedAt),
    firstExecutedAt:
      session.firstExecutedAt === undefined
        ? undefined
        : toFiniteNumber(session.firstExecutedAt),
    messageCount: toFiniteNumber(session.messageCount),
    totalTokens: toFiniteNumber(session.totalTokens),
    totalCost: toFiniteNumber(session.totalCost),
  };
}

function normalizeStats(stats: SessionStats): SessionStats {
  return {
    ...stats,
    inputTokens: toFiniteNumber(stats.inputTokens),
    outputTokens: toFiniteNumber(stats.outputTokens),
    totalCost: toFiniteNumber(stats.totalCost),
  };
}

type StoreName =
  | "settings"
  | "models"
  | "sessions"
  | "messages"
  | "images"
  | "stats"
  | "defaults";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;
        // Non-destructive migration: ensure all stores exist without dropping them.
        // This preserves data across schema versions.
        if (oldVersion < 6) {
          // Drop legacy store if it exists from a very old version
          if (db.objectStoreNames.contains("conversations")) {
            db.deleteObjectStore("conversations");
          }
        }

        // Ensure all stores exist
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("models")) {
          db.createObjectStore("models", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          const store = db.createObjectStore("sessions", {
            keyPath: "id",
          });
          store.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: "id" });
          store.createIndex("sessionId", "sessionId");
          store.createIndex("modelId", "modelId");
          store.createIndex("sessionModel", ["sessionId", "modelId"]);
          store.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("stats")) {
          db.createObjectStore("stats", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("defaults")) {
          db.createObjectStore("defaults", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        console.warn("[IndexedDB] Database upgrade blocked - close other tabs");
        addNotification({
          type: "warning",
          message:
            "Database upgrade is blocked. Please close any other tabs with this application open and refresh the page.",
        });
      };
    });
  }
  return dbPromise;
}

async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    Promise.resolve(callback(store))
      .then((result) => {
        if (result instanceof IDBRequest) {
          result.onsuccess = () => resolve(result.result);
          result.onerror = () => reject(result.error);
        } else {
          resolve(result);
        }
      })
      .catch(reject);
  });
}

export async function getSettings(): Promise<SettingsState | null> {
  return withStore("settings", "readonly", (store) => store.get("settings"));
}

export async function saveSettings(settings: SettingsState): Promise<void> {
  await withStore("settings", "readwrite", (store) => store.put(settings));
}

export async function saveModels(models: OpenRouterModel[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("models", "readwrite");
    const store = tx.objectStore("models");
    store.clear();
    models.forEach((model) => store.put(model));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getModels(): Promise<OpenRouterModel[]> {
  return withStore("models", "readonly", (store) => store.getAll());
}

export async function saveSession(session: Session): Promise<void> {
  await withStore("sessions", "readwrite", (store) =>
    store.put(normalizeSession(session)),
  );
}

export async function getSession(id: string): Promise<Session | null> {
  return withStore("sessions", "readonly", (store) => store.get(id)).then(
    (session) => (session ? normalizeSession(session as Session) : null),
  );
}

export async function listSessions(offset = 0, limit = 20): Promise<Session[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const store = tx.objectStore("sessions");
    const hasUpdatedAtIndex = Array.from(store.indexNames).includes(
      "updatedAt",
    );
    if (!hasUpdatedAtIndex) {
      const requestAll = store.getAll();
      requestAll.onsuccess = () => {
        const all = (requestAll.result as Session[])
          .map(normalizeSession)
          .slice();
        all.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(all.slice(offset, offset + limit));
      };
      requestAll.onerror = () => reject(requestAll.error);
      return;
    }

    const index = store.index("updatedAt");
    const request = index.openCursor(null, "prev");
    const results: Session[] = [];
    let skipped = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      if (skipped < offset) {
        skipped += 1;
        cursor.continue();
        return;
      }
      if (results.length < limit) {
        results.push(normalizeSession(cursor.value as Session));
        cursor.continue();
        return;
      }
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["sessions", "messages", "stats", "images"],
      "readwrite",
    );
    const sessionStore = tx.objectStore("sessions");
    sessionStore.delete(id);

    const messageStore = tx.objectStore("messages");
    const messageIndex = messageStore.index("sessionId");
    const messageRequest = messageIndex.openCursor(id);
    messageRequest.onsuccess = () => {
      const cursor = messageRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    const statsStore = tx.objectStore("stats");
    const statsRequest = statsStore.openCursor();
    statsRequest.onsuccess = () => {
      const cursor = statsRequest.result;
      if (cursor) {
        if ((cursor.value as SessionStats).sessionId === id) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveMessage(message: Message): Promise<void> {
  await withStore("messages", "readwrite", (store) => store.put(message));
}

export async function saveMessages(messages: Message[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    messages.forEach((message) => store.put(message));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMessages(
  sessionId: string,
  modelId?: string,
): Promise<Message[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index(modelId ? "sessionModel" : "sessionId");
    const key = modelId ? [sessionId, modelId] : sessionId;
    const request = index.getAll(key);
    request.onsuccess = () => {
      const messages = request.result as Message[];
      messages.sort((a, b) => a.createdAt - b.createdAt);
      resolve(messages);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteMessage(messageId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["messages"], "readwrite");
    const messageStore = tx.objectStore("messages");
    messageStore.delete(messageId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteMessagesAfter(
  sessionId: string,
  modelId: string,
  messageId: string,
  runIndex?: number,
): Promise<void> {
  const messages = await getMessages(sessionId, modelId);
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) return;

  // If runIndex is specified, only delete messages for that run
  // Otherwise, delete all messages after the specified message
  const messagesAfter = messages.slice(index + 1);
  const toDelete =
    runIndex !== undefined
      ? messagesAfter.filter((msg) => msg.runIndex === runIndex)
      : messagesAfter;

  if (toDelete.length === 0) return;

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["messages"], "readwrite");
    const messageStore = tx.objectStore("messages");
    toDelete.forEach((message) => messageStore.delete(message.id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveImage(asset: ImageAsset): Promise<void> {
  await withStore("images", "readwrite", (store) => store.put(asset));
}

export async function getImage(id: string): Promise<ImageAsset | null> {
  return withStore("images", "readonly", (store) => store.get(id));
}

export async function saveStats(stats: SessionStats): Promise<void> {
  const normalized = normalizeStats(stats);
  const payload = {
    ...normalized,
    id: `${normalized.sessionId}:${normalized.modelId}`,
  };
  await withStore("stats", "readwrite", (store) => store.put(payload));
}

export async function getStats(sessionId: string): Promise<SessionStats[]> {
  return withStore("stats", "readonly", (store) => store.getAll()).then(
    (stats) =>
      (stats as SessionStats[])
        .filter((item) => item.sessionId === sessionId)
        .map((item) => normalizeStats(item as SessionStats)),
  );
}

export async function getAllStats(): Promise<SessionStats[]> {
  return withStore("stats", "readonly", (store) => store.getAll()).then(
    (stats) =>
      (stats as SessionStats[]).map((item) =>
        normalizeStats(item as SessionStats),
      ),
  );
}

export async function getDefaults(): Promise<DefaultsState | null> {
  return withStore("defaults", "readonly", (store) => store.get("defaults"));
}

export async function saveDefaults(defaults: DefaultsState): Promise<void> {
  await withStore("defaults", "readwrite", (store) =>
    store.put({ ...defaults, id: "defaults" }),
  );
}

export async function clearAllStorage(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [
        "sessions",
        "messages",
        "images",
        "stats",
        "models",
        "settings",
        "defaults",
      ],
      "readwrite",
    );
    const stores: StoreName[] = [
      "sessions",
      "messages",
      "images",
      "stats",
      "models",
      "settings",
      "defaults",
    ];
    stores.forEach((storeName) => {
      const store = tx.objectStore(storeName);
      store.clear();
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cleanupOrphanedImages(): Promise<number> {
  const db = await openDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(["messages", "images"], "readwrite");
    const messageStore = tx.objectStore("messages");
    const imageStore = tx.objectStore("images");

    const referenced = new Set<string>();
    let deletedCount = 0;

    const messagesCursor = messageStore.openCursor();
    messagesCursor.onsuccess = () => {
      const cursor = messagesCursor.result;
      if (!cursor) {
        const imagesCursor = imageStore.openCursor();
        imagesCursor.onsuccess = () => {
          const imageCursor = imagesCursor.result;
          if (!imageCursor) return;
          const asset = imageCursor.value as ImageAsset;
          if (!referenced.has(asset.id)) {
            imageCursor.delete();
            deletedCount += 1;
          }
          imageCursor.continue();
        };
        imagesCursor.onerror = () => reject(imagesCursor.error);
        return;
      }

      const message = cursor.value as Message;
      message.imageIds.forEach((imageId) => referenced.add(imageId));
      cursor.continue();
    };
    messagesCursor.onerror = () => reject(messagesCursor.error);

    tx.oncomplete = () => resolve(deletedCount);
    tx.onerror = () => reject(tx.error);
  });
}
