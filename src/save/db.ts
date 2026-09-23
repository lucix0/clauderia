/**
 * IndexedDB storage for save format v2: a `worlds` store (one record per
 * world) and a `chunks` store (one gzipped record per changed chunk, keyed
 * "<worldId>/<cx>,<cz>"). The v1 `saves` store is kept only to migrate it.
 */
import { gunzip, gzip } from './compress';
import {
  chunkStoreKey,
  decodeChunkRecord,
  encodeChunkRecord,
  sanitizeWorldRecord,
  type ChunkRecord,
  type WorldRecord,
} from './records';

const DB_NAME = 'blocktide';
const DB_VERSION = 2;
const WORLDS = 'worlds';
const CHUNKS = 'chunks';
const LEGACY = 'saves';
const LEGACY_SLOT = 'latest';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORLDS)) db.createObjectStore(WORLDS);
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
      if (!db.objectStoreNames.contains(LEGACY)) db.createObjectStore(LEGACY);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Could not open the save database'));
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Save database error'));
    tx.onabort = () => reject(tx.error ?? new Error('Save transaction aborted'));
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Save database error'));
  });
}

export async function listWorlds(): Promise<WorldRecord[]> {
  const db = await open();
  const tx = db.transaction(WORLDS, 'readonly');
  const all = await result(tx.objectStore(WORLDS).getAll());
  return all
    .map((w) => sanitizeWorldRecord(w))
    .filter((w): w is WorldRecord => w !== null)
    .sort((a, b) => b.lastPlayed - a.lastPlayed);
}

export async function getWorld(id: string): Promise<WorldRecord | null> {
  const db = await open();
  const raw: unknown = await result(db.transaction(WORLDS, 'readonly').objectStore(WORLDS).get(id));
  return sanitizeWorldRecord(raw);
}

/** Encode + gzip chunk records (off the transaction, which must not await). */
export async function packChunks(worldId: string, chunks: readonly ChunkRecord[]): Promise<Array<[string, ArrayBuffer]>> {
  return Promise.all(
    chunks.map(async (c): Promise<[string, ArrayBuffer]> => [
      chunkStoreKey(worldId, c.cx, c.cz),
      (await gzip(encodeChunkRecord(c))).buffer,
    ]),
  );
}

/** Write a world record and any number of chunk records in one transaction. */
export async function saveBatch(world: WorldRecord | null, packed: ReadonlyArray<[string, ArrayBuffer]>): Promise<void> {
  const db = await open();
  const tx = db.transaction([WORLDS, CHUNKS], 'readwrite');
  if (world) tx.objectStore(WORLDS).put(world, world.id);
  const store = tx.objectStore(CHUNKS);
  for (const [key, data] of packed) store.put(data, key);
  await done(tx);
}

/** Every stored chunk record of a world. */
export async function loadChunks(worldId: string): Promise<ChunkRecord[]> {
  const db = await open();
  const range = IDBKeyRange.bound(`${worldId}/`, `${worldId}/￿`);
  const raws = await result(db.transaction(CHUNKS, 'readonly').objectStore(CHUNKS).getAll(range));
  return Promise.all(raws.map(async (raw: unknown) => decodeChunkRecord(await gunzip(new Uint8Array(raw as ArrayBuffer)))));
}

/** One stored chunk record, or null when the chunk was never changed. */
export async function loadChunk(worldId: string, cx: number, cz: number): Promise<ChunkRecord | null> {
  const db = await open();
  const raw: unknown = await result(
    db.transaction(CHUNKS, 'readonly').objectStore(CHUNKS).get(chunkStoreKey(worldId, cx, cz)),
  );
  if (!(raw instanceof ArrayBuffer)) return null;
  return decodeChunkRecord(await gunzip(new Uint8Array(raw)));
}

export async function deleteWorld(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([WORLDS, CHUNKS], 'readwrite');
  tx.objectStore(WORLDS).delete(id);
  tx.objectStore(CHUNKS).delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
  await done(tx);
}

/** The v1 single-slot save, if one is still waiting to be migrated. */
export async function readLegacySave(): Promise<ArrayBuffer | null> {
  const db = await open();
  const raw: unknown = await result(db.transaction(LEGACY, 'readonly').objectStore(LEGACY).get(LEGACY_SLOT));
  if (typeof raw !== 'object' || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  return data instanceof ArrayBuffer ? data : null;
}

/** Store a migrated world and drop the v1 record, atomically. */
export async function commitMigration(world: WorldRecord, packed: ReadonlyArray<[string, ArrayBuffer]>): Promise<void> {
  const db = await open();
  const tx = db.transaction([WORLDS, CHUNKS, LEGACY], 'readwrite');
  tx.objectStore(WORLDS).put(world, world.id);
  const store = tx.objectStore(CHUNKS);
  for (const [key, data] of packed) store.put(data, key);
  tx.objectStore(LEGACY).delete(LEGACY_SLOT);
  await done(tx);
}

/** Write a v1-style legacy save (used by tests of the migration path). */
export async function writeLegacySave(data: ArrayBuffer): Promise<void> {
  const db = await open();
  const tx = db.transaction(LEGACY, 'readwrite');
  tx.objectStore(LEGACY).put({ data, savedAt: Date.now(), label: 'legacy' }, LEGACY_SLOT);
  await done(tx);
}
