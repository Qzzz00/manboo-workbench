/**
 * Media sandbox storage — client-side persistent storage for chat media.
 *
 * - Mobile (Capacitor): uses @capacitor/filesystem in Directory.Data
 * - Web: uses IndexedDB via a simple blob-store wrapper
 *
 * Files are keyed by message ID to guarantee uniqueness.
 * Directories:
 *   media/voice/   -> audio blobs
 *   media/image/   -> image blobs
 */

// ── Types ─────────────────────────────────────────

export interface MediaFileStore {
  readBinary(path: string): Promise<Uint8Array | null>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(directory: string): Promise<string[]>;
}

// ── Capacitor implementation ──────────────────────

type FilesystemModule = typeof import('@capacitor/filesystem');
let filesystemModule: Promise<FilesystemModule> | null = null;

function loadFilesystem() {
  if (!filesystemModule) {
    filesystemModule = import('@capacitor/filesystem');
  }
  return filesystemModule;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isCapacitorEnv(): boolean {
  if (typeof window === 'undefined') return false;
  // Capacitor injects `window.Capacitor`
  return !!(window as unknown as Record<string, unknown>).Capacitor;
}

const capacitorMediaStore: MediaFileStore = {
  async readBinary(path) {
    const { Filesystem, Directory } = await loadFilesystem();
    try {
      const result = await Filesystem.readFile({ path, directory: Directory.Data });
      const data = typeof result.data === 'string' ? result.data : await result.data.text();
      return base64ToUint8(data);
    } catch {
      return null;
    }
  },
  async writeBinary(path, data) {
    const { Filesystem, Directory } = await loadFilesystem();
    await Filesystem.writeFile({
      path,
      data: uint8ToBase64(data),
      directory: Directory.Data,
      recursive: true,
    });
  },
  async delete(path) {
    const { Filesystem, Directory } = await loadFilesystem();
    try {
      await Filesystem.deleteFile({ path, directory: Directory.Data });
    } catch {
      // ignore
    }
  },
  async exists(path) {
    const { Filesystem, Directory } = await loadFilesystem();
    try {
      await Filesystem.stat({ path, directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  },
  async list(directory) {
    const { Filesystem, Directory } = await loadFilesystem();
    try {
      const result = await Filesystem.readdir({ path: directory, directory: Directory.Data });
      return result.files.map((f) => (typeof f === 'string' ? f : f.name));
    } catch {
      return [];
    }
  },
};

// ── Web IndexedDB implementation ──────────────────

const DB_NAME = 'llm-live2d-media';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

const indexedDbMediaStore: MediaFileStore = {
  async readBinary(path) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(path);
      req.onsuccess = () => {
        const result = req.result;
        if (result instanceof ArrayBuffer) {
          resolve(new Uint8Array(result));
        } else if (result instanceof Blob) {
          const reader = new FileReader();
          reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(result);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  },
  async writeBinary(path, data) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async delete(path) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async exists(path) {
    const data = await indexedDbMediaStore.readBinary(path);
    return data !== null;
  },
  async list(directory) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        const keys = (req.result as IDBValidKey[]).map((k) => String(k));
        resolve(keys.filter((k) => k.startsWith(directory)));
      };
      req.onerror = () => reject(req.error);
    });
  },
};

// ── Default store selector ────────────────────────

export function getDefaultMediaStore(): MediaFileStore {
  return isCapacitorEnv() ? capacitorMediaStore : indexedDbMediaStore;
}

// ── High-level helpers ────────────────────────────

const VOICE_DIR = 'media/voice';
const IMAGE_DIR = 'media/image';

export function voicePath(messageId: string): string {
  return `${VOICE_DIR}/${messageId}`;
}

export function imagePath(messageId: string): string {
  return `${IMAGE_DIR}/${messageId}`;
}

export async function saveVoiceToSandbox(
  messageId: string,
  blob: Blob,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  await store.writeBinary(voicePath(messageId), new Uint8Array(arrayBuffer));
}

export async function saveImageToSandbox(
  messageId: string,
  blob: Blob,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  await store.writeBinary(imagePath(messageId), new Uint8Array(arrayBuffer));
}

export async function loadVoiceFromSandbox(
  messageId: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<Blob | null> {
  const data = await store.readBinary(voicePath(messageId));
  if (!data) return null;
  return new Blob([data], { type: 'audio/mpeg' });
}

export async function loadImageFromSandbox(
  messageId: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<Blob | null> {
  const data = await store.readBinary(imagePath(messageId));
  if (!data) return null;
  return new Blob([data], { type: 'image/jpeg' });
}

export async function hasVoiceInSandbox(
  messageId: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<boolean> {
  return store.exists(voicePath(messageId));
}

export async function hasImageInSandbox(
  messageId: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<boolean> {
  return store.exists(imagePath(messageId));
}

export async function deleteMediaFromSandbox(
  messageId: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<void> {
  await Promise.all([
    store.delete(voicePath(messageId)).catch(() => {}),
    store.delete(imagePath(messageId)).catch(() => {}),
  ]);
}

export async function clearAllSandboxMedia(
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<void> {
  const [voiceFiles, imageFiles] = await Promise.all([
    store.list(VOICE_DIR).catch(() => [] as string[]),
    store.list(IMAGE_DIR).catch(() => [] as string[]),
  ]);
  await Promise.all(
    [...voiceFiles, ...imageFiles].map((f) => store.delete(f).catch(() => {})),
  );
}
