import type {
  Session,
  SessionStats,
  DefaultsState,
  ImageAsset,
  Message,
  SettingsState,
} from "../types/db";
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
        // This app does not require schema migration/back-compat. If the schema changes,
        // we drop and recreate session-related stores.
        if (oldVersion < 6) {
          const storesToDrop: string[] = [
            "conversations", // legacy store name (pre-session terminology)
            "sessions",
            "messages",
            "images",
            "stats",
          ];
          storesToDrop.forEach((name) => {
            if (db.objectStoreNames.contains(name)) {
              db.deleteObjectStore(name);
            }
          });
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
    const messageStore = tx.objectStore("messages");
    const statsStore = tx.objectStore("stats");
    const imageStore = tx.objectStore("images");
    sessionStore.delete(id);
    const imageIdsToDelete = new Set<string>();
    const imageIdsInUse = new Set<string>();
    const request = messageStore.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        imageIdsToDelete.forEach((imageId) => {
          if (!imageIdsInUse.has(imageId)) {
            imageStore.delete(imageId);
          }
        });
        return;
      }
      const message = cursor.value as Message;
      if (message.sessionId === id) {
        message.imageIds.forEach((imageId) => imageIdsToDelete.add(imageId));
        cursor.delete();
      } else {
        message.imageIds.forEach((imageId) => imageIdsInUse.add(imageId));
      }
      cursor.continue();
    };
    const statsRequest = statsStore.openCursor();
    statsRequest.onsuccess = () => {
      const cursor = statsRequest.result;
      if (!cursor) return;
      if ((cursor.value as SessionStats).sessionId === id) {
        cursor.delete();
      }
      cursor.continue();
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
    const tx = db.transaction(["messages", "images"], "readwrite");
    const messageStore = tx.objectStore("messages");
    const imageStore = tx.objectStore("images");
    const request = messageStore.get(messageId);
    request.onsuccess = () => {
      const message = request.result as Message | undefined;
      if (!message) return;

      const imageIdsToDelete = new Set<string>(message.imageIds);
      const imageIdsInUse = new Set<string>();
      const cursorRequest = messageStore.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          imageIdsToDelete.forEach((imageId) => {
            if (!imageIdsInUse.has(imageId)) {
              imageStore.delete(imageId);
            }
          });
          messageStore.delete(messageId);
          return;
        }
        const otherMessage = cursor.value as Message;
        if (otherMessage.id !== messageId) {
          otherMessage.imageIds.forEach((imageId) =>
            imageIdsInUse.add(imageId),
          );
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
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
  const messagesAfter = messages.slice(index);
  const toDelete =
    runIndex !== undefined
      ? messagesAfter.filter((msg) => msg.runIndex === runIndex)
      : messagesAfter;

  if (toDelete.length === 0) return;

  const messageIdsToDelete = new Set<string>(toDelete.map((m) => m.id));
  const imageIdsToDelete = new Set<string>();
  toDelete.forEach((message) => {
    message.imageIds.forEach((imageId) => imageIdsToDelete.add(imageId));
  });

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["messages", "images"], "readwrite");
    const messageStore = tx.objectStore("messages");
    const imageStore = tx.objectStore("images");
    const imageIdsInUse = new Set<string>();
    const cursorRequest = messageStore.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        toDelete.forEach((message) => {
          messageStore.delete(message.id);
        });
        imageIdsToDelete.forEach((imageId) => {
          if (!imageIdsInUse.has(imageId)) {
            imageStore.delete(imageId);
          }
        });
        return;
      }
      const message = cursor.value as Message;
      if (!messageIdsToDelete.has(message.id)) {
        message.imageIds.forEach((imageId) => imageIdsInUse.add(imageId));
      }
      cursor.continue();
    };
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
