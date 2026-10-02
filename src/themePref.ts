// Tema elegido en el móvil: almacén clave-valor síncrono de expo-sqlite (se lee antes de crear los estilos).
import Storage from 'expo-sqlite/kv-store';

const KEY = 'homehoard.theme';

export function readThemePref(): string | null {
  try {
    return Storage.getItemSync(KEY);
  } catch {
    return null;
  }
}

export function writeThemePref(value: string): void {
  try {
    Storage.setItemSync(KEY, value);
  } catch {
    // sin almacén: se queda el tema por defecto
  }
}
