// Backup local: exporta/importa todo el inventario como JSON.
// Web: descarga/lee archivo con el DOM. Nativo: comparte con expo-sharing y
// elige archivo con expo-document-picker. La version 2 incluye las fotos.
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { newId } from '../db/ids';
import { hasExampleItems } from '../db/demo';
import type { DataSource, ExportBundle } from '../db/types';

const PHOTO_DATA = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

async function photoAsDataUrl(uri: string): Promise<string> {
  if (PHOTO_DATA.test(uri)) return uri;
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('No se pudo leer una foto del inventario');
    const blob = await response.blob();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('Formato de foto no admitido');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('No se pudo leer una foto del inventario'));
      reader.readAsDataURL(blob);
    });
  }
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) throw new Error('Falta una foto del inventario');
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const ext = uri.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase();
  const mime = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpeg';
  return `data:image/${mime};base64,${base64}`;
}

async function makePortable(data: DataSource): Promise<ExportBundle> {
  const bundle = await data.exportAll();
  const photos: Record<string, string> = {};
  const items = bundle.data.items.map((item) => ({ ...item }));
  for (const item of items) {
    if (item.photo_uri) {
      photos[item.id] = await photoAsDataUrl(item.photo_uri);
      item.photo_uri = null;
    }
  }
  return { ...bundle, version: 2, photos, data: { ...bundle.data, items } };
}

async function restorePhotos(bundle: ExportBundle): Promise<ExportBundle> {
  if (bundle.format !== 'homehoard-export' || !bundle.data || !Array.isArray(bundle.data.items)) {
    throw new Error('Copia no reconocida');
  }
  if (bundle.version !== 2) return bundle;
  const items = bundle.data.items.map((item) => ({ ...item }));
  const written: string[] = [];
  try {
    for (const item of items) {
      const encoded = bundle.photos?.[item.id];
      if (!encoded) continue;
      const match = PHOTO_DATA.exec(encoded);
      if (!match) throw new Error('Foto de la copia no valida');
      if (Platform.OS === 'web') {
        item.photo_uri = encoded;
      } else {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const dir = `${FileSystem.documentDirectory}photos/`;
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        const uri = `${dir}${newId()}.${ext}`;
        await FileSystem.writeAsStringAsync(uri, match[2], { encoding: FileSystem.EncodingType.Base64 });
        written.push(uri);
        item.photo_uri = uri;
      }
    }
  } catch (error) {
    await Promise.allSettled(written.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true })));
    throw error;
  }
  return { ...bundle, data: { ...bundle.data, items } };
}

/** Remove newly restored native photos if the following database import fails. */
export async function discardRestoredPhotos(bundle: ExportBundle): Promise<void> {
  if (bundle.version !== 2 || Platform.OS === 'web') return;
  const dir = `${FileSystem.documentDirectory}photos/`;
  await Promise.allSettled(bundle.data.items.map(async (item) => {
    if (bundle.photos?.[item.id] && item.photo_uri?.startsWith(dir)) {
      await FileSystem.deleteAsync(item.photo_uri, { idempotent: true });
    }
  }));
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Exporta todo a un JSON y lo descarga (web) o lo comparte (nativo). */
export async function exportBackup(data: DataSource): Promise<string> {
  const bundle = await makePortable(data);
  const json = JSON.stringify(bundle, null, 2);
  const filename = `homehoard-${stamp()}.json`;

  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-undef
    const blob = new Blob([json], { type: 'application/json' });
    // eslint-disable-next-line no-undef
    const url = URL.createObjectURL(blob);
    // eslint-disable-next-line no-undef
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // eslint-disable-next-line no-undef
    URL.revokeObjectURL(url);
    return filename;
  }

  const uri = `${FileSystem.cacheDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, json);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'Copia de HomeHoard' });
  }
  return filename;
}

/** Actualiza la copia de consulta de Faustus por loopback; nunca envía fotos. */
export async function updateFaustus(data: DataSource): Promise<number> {
  if (Platform.OS !== 'web' || !['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    throw new Error('Abre HomeHoard en el ordenador para actualizar Faustus');
  }
  const bundle = await data.exportAll();
  if (hasExampleItems(bundle.data.items)) throw new Error('La casa de ejemplo sigue en el inventario. Empieza con tu casa antes de actualizar Faustus.');
  const items = bundle.data.items.map((item) => ({ ...item, photo_uri: null }));
  const response = await fetch('http://127.0.0.1:5196/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bundle, data: { ...bundle.data, items } }),
  });
  if (!response.ok) throw new Error('No se pudo actualizar Faustus. Comprueba que el puente local está abierto.');
  const result = await response.json();
  try { localStorage.setItem('homehoard.faustus.auto', '1'); } catch { /* manual update still succeeded */ }
  return result.items;
}

/** Pide un archivo JSON y devuelve el bundle parseado (o null si se cancela). */
export async function pickBackup(): Promise<ExportBundle | null> {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      // eslint-disable-next-line no-undef
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            resolve(await restorePhotos(JSON.parse(String(reader.result)) as ExportBundle));
          } catch {
            resolve(null);
          }
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      input.click();
    });
  }

  const res = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return null;
  try {
    const json = await FileSystem.readAsStringAsync(res.assets[0].uri);
    return await restorePhotos(JSON.parse(json) as ExportBundle);
  } catch {
    return null;
  }
}
