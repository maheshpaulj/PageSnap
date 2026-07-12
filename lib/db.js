// PageSnap — shared IndexedDB media store.
// Media (screenshot data URLs, video Blobs) must NOT live in chrome.storage
// (10MB quota) nor in service-worker memory (lost when the SW idles ~30s).
// IndexedDB persists across SW restarts and is shared by every extension
// context: service worker, popup, annotate page, and video editor.
const PSDB = (() => {
  const DB_NAME = 'pagesnap';
  const STORE = 'media';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    put: (id, data) => tx('readwrite', s => s.put(data, id)),
    get: (id) => tx('readonly', s => s.get(id)),
    remove: (id) => tx('readwrite', s => s.delete(id)),
    clear: () => tx('readwrite', s => s.clear()),
  };
})();

// Works in both window contexts and the service worker
self.PSDB = PSDB;
