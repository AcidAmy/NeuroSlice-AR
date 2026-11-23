const prefix = 'neuroslice-medical-v1:';

export function medicalCacheName(base, release) {
  if (!release) return undefined;
  return prefix + new URL(base, document.baseURI).pathname + ':' + release;
}

export async function pruneMedicalCaches(name) {
  if (!name) return;
  const scope = name.slice(0, name.lastIndexOf(':') + 1);
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(scope) && key !== name).map(key => caches.delete(key)));
  } catch {
    // Storage may be disabled. Immutable HTTP caching remains available.
  }
}

export async function openAssetCache(name) {
  if (!name) return null;
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}
