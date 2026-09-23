/** One IndexedDB save slot holding a gzipped save blob. */

const DB_NAME = 'blocktide';
const STORE = 'saves';
const SLOT = 'latest';

export interface StoredSave {
  data: ArrayBuffer;
  savedAt: number;
  label: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open save database'));
  });
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('Save database error'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('Save transaction aborted'));
        };
      }),
  );
}

export async function writeSave(save: StoredSave): Promise<void> {
  await request('readwrite', (store) => store.put(save, SLOT));
}

export async function readSave(): Promise<StoredSave | null> {
  const value = await request<unknown>('readonly', (store) => store.get(SLOT));
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredSave>;
  if (!(v.data instanceof ArrayBuffer)) return null;
  return { data: v.data, savedAt: typeof v.savedAt === 'number' ? v.savedAt : 0, label: String(v.label ?? '') };
}
