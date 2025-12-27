import type {
  Conversation,
  ConversationStats,
  DefaultsState,
  ImageAsset,
  Message,
  SettingsState,
} from "../types/db";
import type { OpenRouterModel } from "../types/openrouter";

const DB_NAME = "image-edit-bench";
const DB_VERSION = 5;

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

function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    createdAt: toFiniteNumber(conversation.createdAt),
    updatedAt: toFiniteNumber(conversation.updatedAt),
    firstRunAt:
      conversation.firstRunAt === undefined
        ? undefined
        : toFiniteNumber(conversation.firstRunAt),
    messageCount: toFiniteNumber(conversation.messageCount),
    totalTokens: toFiniteNumber(conversation.totalTokens),
    totalCost: toFiniteNumber(conversation.totalCost),
  };
}

function normalizeStats(stats: ConversationStats): ConversationStats {
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
  | "conversations"
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
        const tx = (event.target as IDBOpenDBRequest).transaction;

        // If upgrading from version 1 or earlier, create defaults store
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains("defaults")) {
            db.createObjectStore("defaults", { keyPath: "id" });
          }
        }

        // Ensure all stores exist
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("models")) {
          db.createObjectStore("models", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("conversations")) {
          const store = db.createObjectStore("conversations", {
            keyPath: "id",
          });
          store.createIndex("updatedAt", "updatedAt");
        } else if (tx) {
          const store = tx.objectStore("conversations");
          if (!Array.from(store.indexNames).includes("updatedAt")) {
            store.createIndex("updatedAt", "updatedAt");
          }
        }
        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: "id" });
          store.createIndex("conversationId", "conversationId");
          store.createIndex("modelId", "modelId");
          store.createIndex("conversationModel", ["conversationId", "modelId"]);
          store.createIndex("createdAt", "createdAt");
        } else if (tx) {
          const store = tx.objectStore("messages");
          const indexes = new Set(Array.from(store.indexNames));
          if (!indexes.has("conversationId")) {
            store.createIndex("conversationId", "conversationId");
          }
          if (!indexes.has("modelId")) {
            store.createIndex("modelId", "modelId");
          }
          if (!indexes.has("conversationModel")) {
            store.createIndex("conversationModel", [
              "conversationId",
              "modelId",
            ]);
          }
          if (!indexes.has("createdAt")) {
            store.createIndex("createdAt", "createdAt");
          }
        }
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images", { keyPath: "id" });
        } else if (tx) {
          const store = tx.objectStore("images");
          if (oldVersion < 5) {
            if (Array.from(store.indexNames).includes("dedupeKey")) {
              store.deleteIndex("dedupeKey");
            }
            if (Array.from(store.indexNames).includes("blobHash")) {
              store.deleteIndex("blobHash");
            }
          }
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

export async function saveConversation(
  conversation: Conversation,
): Promise<void> {
  await withStore("conversations", "readwrite", (store) =>
    store.put(normalizeConversation(conversation)),
  );
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  return withStore("conversations", "readonly", (store) => store.get(id)).then(
    (conversation) =>
      conversation ? normalizeConversation(conversation as Conversation) : null,
  );
}

export async function listConversations(
  offset = 0,
  limit = 20,
): Promise<Conversation[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readonly");
    const store = tx.objectStore("conversations");
    const hasUpdatedAtIndex = Array.from(store.indexNames).includes(
      "updatedAt",
    );
    if (!hasUpdatedAtIndex) {
      const requestAll = store.getAll();
      requestAll.onsuccess = () => {
        const all = (requestAll.result as Conversation[])
          .map(normalizeConversation)
          .slice();
        all.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(all.slice(offset, offset + limit));
      };
      requestAll.onerror = () => reject(requestAll.error);
      return;
    }

    const index = store.index("updatedAt");
    const request = index.openCursor(null, "prev");
    const results: Conversation[] = [];
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
        results.push(normalizeConversation(cursor.value as Conversation));
        cursor.continue();
        return;
      }
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      ["conversations", "messages", "stats", "images"],
      "readwrite",
    );
    const conversationStore = tx.objectStore("conversations");
    const messageStore = tx.objectStore("messages");
    const statsStore = tx.objectStore("stats");
    const imageStore = tx.objectStore("images");
    conversationStore.delete(id);
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
      if (message.conversationId === id) {
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
      if ((cursor.value as ConversationStats).conversationId === id) {
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
  conversationId: string,
  modelId?: string,
): Promise<Message[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index(modelId ? "conversationModel" : "conversationId");
    const key = modelId ? [conversationId, modelId] : conversationId;
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
  conversationId: string,
  modelId: string,
  messageId: string,
  runIndex?: number,
): Promise<void> {
  const messages = await getMessages(conversationId, modelId);
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

export async function saveStats(stats: ConversationStats): Promise<void> {
  const normalized = normalizeStats(stats);
  const payload = {
    ...normalized,
    id: `${normalized.conversationId}:${normalized.modelId}`,
  };
  await withStore("stats", "readwrite", (store) => store.put(payload));
}

export async function getStats(
  conversationId: string,
): Promise<ConversationStats[]> {
  return withStore("stats", "readonly", (store) => store.getAll()).then(
    (stats) =>
      (stats as ConversationStats[])
        .filter((item) => item.conversationId === conversationId)
        .map((item) => normalizeStats(item as ConversationStats)),
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
        "conversations",
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
      "conversations",
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
