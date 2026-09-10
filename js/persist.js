/* ============================================================
   persist.js — durable save layer

   Adapted from Search and Go's persist.js. Three cooperating layers,
   strongest first:

     1. A real file on the device, via the File System Access API. It
        lives outside the browser's storage bucket, so it survives
        "clear browsing data". Supported on Chrome for Android.
     2. IndexedDB (+ navigator.storage.persist()) as the always-on
        working copy. Fast, but wiped if the user clears site data.
     3. Manual download / import of a .json backup — works everywhere.

   Its own database name, so this game and Search and Go can be installed
   side by side without ever touching each other's progress.
   ============================================================ */

const DB_NAME = 'pinball-creatures';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const KEY_SAVE = 'save';
const KEY_HANDLE = 'saveFileHandle';
const KEY_SNAPSHOTS = 'snapshots';

export const SAVE_FILENAME = 'pinball-creatures-save.json';

/* A last line of defence: snapshots live under their own key, so a bad
   write to `save` cannot reach them. */
export const SNAPSHOT_KEEP = 6;
export const SNAPSHOT_GAP_MS = 3 * 3_600_000;   // 3 hours

let idb = null;

/**
 * How much progress a save represents, and whether it is effectively blank.
 * Used to refuse a write that would replace real progress with a fresh start.
 *
 * This game keeps no creature storage — only the dex — so "progress" is
 * registrations, games played and the best score.
 */
export function progressOf(save) {
  if (!save || typeof save !== 'object') {
    return { registered: 0, shinies: 0, games: 0, best: 0, empty: true };
  }
  const registered = save.registered && typeof save.registered === 'object'
    ? Object.keys(save.registered).length : 0;
  const shinies = save.shinyCaught && typeof save.shinyCaught === 'object'
    ? Object.keys(save.shinyCaught).length : 0;
  const games = Number(save.stats?.games) || 0;
  const best = Number(save.best?.score) || 0;
  return { registered, shinies, games, best, empty: registered === 0 && games === 0 && best === 0 };
}

/* ---------------------------------------------------------------
   IndexedDB primitives
   --------------------------------------------------------------- */
function openIDB() {
  if (idb) return Promise.resolve(idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
    };
    req.onsuccess = () => { idb = req.result; resolve(idb); };
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readonly');
    const r = tx.objectStore(KV_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite');
    tx.objectStore(KV_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------------------------------------------------------
   Persist controller
   --------------------------------------------------------------- */
export const Persist = {
  supportsFS: typeof window !== 'undefined' && 'showSaveFilePicker' in window,
  fileHandle: null,
  filePermission: 'unavailable',   // 'granted' | 'prompt' | 'denied' | 'unavailable'
  persisted: false,
  lastError: null,
  onStatusChange: null,
  /** Set when a write was refused for trying to blank an existing save. */
  guardTripped: null,
  lastFileWriteAt: 0,

  /* ---------- lifecycle ---------- */

  async init() {
    try {
      if (navigator.storage?.persist) {
        this.persisted = await navigator.storage.persisted?.() || false;
        if (!this.persisted) this.persisted = await navigator.storage.persist();
      }
    } catch { /* non-fatal */ }

    if (this.supportsFS) {
      try {
        const h = await idbGet(KEY_HANDLE);
        if (h) {
          this.fileHandle = h;
          this.filePermission = await this._queryPerm(h);
        } else {
          this.filePermission = 'prompt';
        }
      } catch (e) {
        this.lastError = e;
        this.filePermission = 'prompt';
      }
    }
    this._emit();
    return this;
  },

  async _queryPerm(handle) {
    try {
      if (!handle?.queryPermission) return 'granted';
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch { return 'prompt'; }
  },

  _emit() { try { this.onStatusChange?.(this.status()); } catch { /* ignore */ } },

  status() {
    return {
      supportsFS: this.supportsFS,
      linked: !!this.fileHandle,
      fileName: this.fileHandle?.name || null,
      filePermission: this.filePermission,
      persisted: this.persisted,
      autoFileSave: !!this.fileHandle && this.filePermission === 'granted',
      lastFileWriteAt: this.lastFileWriteAt,
      guardTripped: this.guardTripped
    };
  },

  /* ---------- loading ---------- */

  /**
   * Reads the newest available save, preferring whichever of the device file
   * or the IndexedDB copy has the later `savedAt`.
   *
   * `readFailed` distinguishes "brand-new player" from "we could not read the
   * save". Those look identical otherwise, and treating the second as the
   * first is exactly how a save gets destroyed.
   */
  async load() {
    let fromIDB = null, fromFile = null, readFailed = false;

    try { fromIDB = await idbGet(KEY_SAVE) || null; }
    catch (e) { this.lastError = e; readFailed = true; }

    if (this.fileHandle && this.filePermission === 'granted') {
      try { fromFile = await this._readFile(this.fileHandle); }
      catch (e) { this.lastError = e; readFailed = true; }
    }

    let recoverable = null;
    if (!fromIDB && !fromFile) recoverable = await this.newestSnapshot();

    if (fromFile && fromIDB) {
      const pick = (fromFile.savedAt || 0) > (fromIDB.savedAt || 0) ? fromFile : fromIDB;
      return { data: pick, source: pick === fromFile ? 'file' : 'idb', readFailed, recoverable };
    }
    if (fromFile) return { data: fromFile, source: 'file', readFailed, recoverable };
    if (fromIDB) return { data: fromIDB, source: 'idb', readFailed, recoverable };
    return { data: null, source: 'none', readFailed, recoverable };
  },

  async _readFile(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  },

  /* ---------- saving ---------- */

  /**
   * Immediate write to every available layer.
   *
   * Guarded: a blank save will never overwrite one that still holds progress.
   * That is how saves get destroyed — the game fails to read one, starts
   * fresh, and the first autosave lands on top. Deliberate wipes pass
   * `force: true`.
   *
   * @returns {Promise<number|null>} the savedAt stamp, or null if refused.
   */
  async writeNow(data, { force = false } = {}) {
    if (!force && progressOf(data).empty) {
      let existing = null;
      try { existing = await idbGet(KEY_SAVE) || null; } catch { /* allow */ }
      const before = progressOf(existing);
      if (existing && !before.empty) {
        this.guardTripped = { at: Date.now(), existing: before, existingSavedAt: Number(existing.savedAt) || 0 };
        this._emit();
        return null;
      }
    }

    const payload = { ...data, savedAt: Date.now() };
    try { await idbSet(KEY_SAVE, payload); }
    catch (e) { this.lastError = e; }

    if (this.fileHandle && this.filePermission === 'granted') {
      try {
        const w = await this.fileHandle.createWritable();
        await w.write(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        await w.close();
        this.lastFileWriteAt = payload.savedAt;
      } catch (e) {
        this.lastError = e;
        this.filePermission = await this._queryPerm(this.fileHandle);
        this._emit();
      }
    }

    await this._maybeSnapshot(payload);
    return payload.savedAt;
  },

  /* ---------- rolling snapshots ---------- */

  async _maybeSnapshot(payload) {
    if (progressOf(payload).empty) return;
    try {
      const list = (await idbGet(KEY_SNAPSHOTS)) || [];
      const last = list[list.length - 1];
      if (last && (payload.savedAt - (last.savedAt || 0)) < SNAPSHOT_GAP_MS) return;

      list.push({ savedAt: payload.savedAt, progress: progressOf(payload), data: payload });
      while (list.length > SNAPSHOT_KEEP) list.shift();
      await idbSet(KEY_SNAPSHOTS, list);
    } catch (e) {
      this.lastError = e;   // never let snapshotting break a real save
    }
  },

  /** Newest last. Each entry is { savedAt, progress, data }. */
  async snapshots() {
    try { return (await idbGet(KEY_SNAPSHOTS)) || []; }
    catch { return []; }
  },

  async newestSnapshot() {
    const list = await this.snapshots();
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && !progressOf(list[i].data).empty) return list[i];
    }
    return null;
  },

  /* ---------- device file linking ---------- */

  async linkFile(data) {
    if (!this.supportsFS) throw new Error('This browser cannot write directly to device files. Use "Download backup" instead.');
    const handle = await window.showSaveFilePicker({
      suggestedName: SAVE_FILENAME,
      types: [{ description: 'Pinball Creatures save', accept: { 'application/json': ['.json'] } }]
    });
    const perm = await handle.requestPermission?.({ mode: 'readwrite' }) ?? 'granted';
    if (perm !== 'granted') throw new Error('Write permission was not granted.');
    this.fileHandle = handle;
    this.filePermission = 'granted';
    await idbSet(KEY_HANDLE, handle);
    await this.writeNow(data);
    this._emit();
    return this.status();
  },

  async openFile() {
    if (!this.supportsFS) throw new Error('This browser cannot open device files directly. Use "Import backup" instead.');
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'Pinball Creatures save', accept: { 'application/json': ['.json'] } }]
    });
    const perm = await handle.requestPermission?.({ mode: 'readwrite' }) ?? 'granted';
    this.fileHandle = handle;
    this.filePermission = perm === 'granted' ? 'granted' : 'prompt';
    await idbSet(KEY_HANDLE, handle);
    const data = await this._readFile(handle);
    this._emit();
    return data;
  },

  /** Re-request permission for an already-linked file. Needs a user gesture. */
  async regrant() {
    if (!this.fileHandle) return 'unavailable';
    const p = await this.fileHandle.requestPermission?.({ mode: 'readwrite' }) ?? 'granted';
    this.filePermission = p;
    this._emit();
    return p;
  },

  async unlink() {
    this.fileHandle = null;
    this.filePermission = this.supportsFS ? 'prompt' : 'unavailable';
    await idbDel(KEY_HANDLE);
    this._emit();
  },

  /* ---------- portable backups ---------- */

  download(data, filename = SAVE_FILENAME) {
    const payload = { ...data, savedAt: Date.now() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  async importFile(file) {
    const text = await file.text();
    return JSON.parse(text);
  },

  async wipe() {
    try { await idbDel(KEY_SAVE); } catch { /* ignore */ }
  }
};
