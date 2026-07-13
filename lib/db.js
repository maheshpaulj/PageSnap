// PageSnap — shared IndexedDB store.
// Two object stores:
//   media       — screenshot data URLs and video Blobs. Must NOT live in
//                 chrome.storage (10MB quota) nor in service-worker memory
//                 (lost when the SW idles ~30s).
//   embeddings  — CLIP vectors for semantic search, keyed by entry id.
// IndexedDB persists across SW restarts and is shared by every extension
// context: service worker, offscreen document, popup, and the editors.
const PSDB = (() => {
  const DB_NAME = 'pagesnap';
  const DB_VERSION = 2;
  const MEDIA = 'media';
  const EMB = 'embeddings';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
          if (!db.objectStoreNames.contains(EMB)) db.createObjectStore(EMB);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  // Returns [{ id, value }] for every entry in a store (used by search ranking)
  function all(store) {
    return open().then(db => new Promise((resolve, reject) => {
      const out = [];
      const t = db.transaction(store, 'readonly');
      const cur = t.objectStore(store).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push({ id: c.key, value: c.value }); c.continue(); }
        else resolve(out);
      };
      cur.onerror = () => reject(cur.error);
    }));
  }

  return {
    // media store
    put:    (id, data) => tx(MEDIA, 'readwrite', s => s.put(data, id)),
    get:    (id)       => tx(MEDIA, 'readonly',  s => s.get(id)),
    remove: (id)       => tx(MEDIA, 'readwrite', s => s.delete(id)),
    clear:  ()         => tx(MEDIA, 'readwrite', s => s.clear()),

    // embeddings store
    embPut:    (id, data) => tx(EMB, 'readwrite', s => s.put(data, id)),
    embGet:    (id)       => tx(EMB, 'readonly',  s => s.get(id)),
    embRemove: (id)       => tx(EMB, 'readwrite', s => s.delete(id)),
    embClear:  ()         => tx(EMB, 'readwrite', s => s.clear()),
    embAll:    ()         => all(EMB),
  };
})();

// Works in both window contexts and the service worker
self.PSDB = PSDB;
