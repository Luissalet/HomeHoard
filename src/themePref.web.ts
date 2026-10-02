// Tema elegido en la web: localStorage de este navegador.
const KEY = 'homehoard.theme';

export function readThemePref(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  } catch {
    return null;
  }
}

export function writeThemePref(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // sin almacenamiento: se queda el tema por defecto
  }
}
