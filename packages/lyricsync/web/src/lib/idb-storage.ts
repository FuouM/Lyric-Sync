// packages/lyricsync/web/src/lib/idb-storage.ts
// Minimal IndexedDB storage helper for persisting FileSystemDirectoryHandle across visits.

const DB_NAME = "lyricsync_editor_db";
const STORE_NAME = "handles";
const KEY_LIBRARY = "library_root_handle";

function openDB(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  return promise;
}

export async function storeLibraryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, KEY_LIBRARY);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    return await promise;
  } catch (e) {
    console.warn("Failed to save library handle to IndexedDB:", e);
  }
}

export async function getStoredLibraryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(KEY_LIBRARY);
    const { promise, resolve } = Promise.withResolvers<FileSystemDirectoryHandle | null>();
    req.onsuccess = () => {
      const handle = req.result as FileSystemDirectoryHandle | undefined;
      resolve(handle ?? null);
    };
    req.onerror = () => resolve(null);
    return await promise;
  } catch {
    return null;
  }
}

export async function clearStoredLibraryHandle(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(KEY_LIBRARY);
    const { promise, resolve } = Promise.withResolvers<void>();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    await promise;
  } catch {}
}
