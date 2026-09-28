import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { newId } from '../db/ids';

/** Elige una foto de la galería. Devuelve la uri o null si se cancela. */
export async function pickFromLibrary(): Promise<string | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
  if (res.canceled || !res.assets?.length) return null;
  return res.assets[0].uri;
}

/** Hace una foto con la cámara (solo nativo). */
export async function takePhoto(): Promise<string | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchCameraAsync({ quality: 0.6 });
  if (res.canceled || !res.assets?.length) return null;
  return res.assets[0].uri;
}

/** Copia la foto a un sitio persistente (documentDirectory) en nativo. En web se deja igual. */
export async function persistPhoto(uri: string): Promise<string> {
  if (Platform.OS === 'web') return uri;
  try {
    const dir = `${FileSystem.documentDirectory}photos/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const dest = `${dir}${newId()}.jpg`;
    await FileSystem.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    return uri; // si falla la copia, usa la uri original
  }
}

export const cameraAvailable = Platform.OS !== 'web';
