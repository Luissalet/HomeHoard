// Colores de HomeHoard. Por defecto, la paleta oscura de la familia Hoard (hoard-theme.css,
// html[data-hoard-app="homehoard"]); la paleta clara anterior sigue disponible en Ajustes.
// El tema se lee al arrancar (los estilos se crean al importar cada pantalla), así que cambiarlo recarga la app.
import { Platform } from 'react-native';
import { readThemePref, writeThemePref } from './themePref';

export type ThemeName = 'dark' | 'light';

const PALETTES = {
  // Familia Hoard: deep, surface, elevated, border, text, muted, accent y accent-ink.
  dark: {
    bg: '#1c1814',
    surface: '#24201b',
    surface2: '#2f2a25',
    border: '#433c35',
    text: '#ece7e1',
    textDim: '#beb9b4',
    accent: '#e5913f', // enlaces e iconos (contraste 7,1:1 sobre el fondo)
    accent2: '#e5913f', // fondo de botones principales
    onAccent: '#1b1713', // texto sobre el acento (7,2:1)
    danger: '#e0685c', // texto de error y fondo del botón de borrar (5,3:1 sobre el fondo)
    onDanger: '#1b1713',
    good: '#6cbf8c',
    warn: '#d4a843',
    banner: '#38322b',
    highlight: 'rgba(229, 145, 63, 0.30)',
    toast: '#38322b',
    toastText: '#ece7e1',
    toastAction: '#e5913f',
  },
  // Paleta cálida clara de la versión 0.2.
  light: {
    bg: '#F6F3EB',
    surface: '#FFFEFA',
    surface2: '#ECE8DE',
    border: '#D9D5C9',
    text: '#182A24',
    textDim: '#52635A',
    accent: '#1D6450',
    accent2: '#16523F',
    onAccent: '#FFFFFF',
    danger: '#B3342D',
    onDanger: '#FFFFFF',
    good: '#23735C',
    warn: '#A15D20',
    banner: '#E9DFCB',
    highlight: '#F1E3B8',
    toast: '#26262E',
    toastText: '#F6F3EB',
    toastAction: '#8FD3BB',
  },
} as const;

export type Palette = { [K in keyof (typeof PALETTES)['dark']]: string };

export const themeName: ThemeName = readThemePref() === 'light' ? 'light' : 'dark';
export const colors: Palette = { ...PALETTES[themeName] };
export const isDark = themeName === 'dark';

/** Guarda el tema y recarga (en web); en el móvil se aplica al volver a abrir la app. Devuelve si se recargó. */
export function setTheme(name: ThemeName): boolean {
  writeThemePref(name);
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.reload();
    return true;
  }
  return false;
}

/** Títulos con serifa, como el resto de la familia. */
export const fonts = {
  serif: Platform.select({
    web: "'Cinzel', 'Iowan Old Style', Charter, Georgia, 'Liberation Serif', 'Noto Serif', 'Times New Roman', serif",
    ios: 'Georgia',
    default: 'serif',
  }) as string,
};

// En web, el fondo de la página y la barra del navegador siguen el tema.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.documentElement.style.backgroundColor = colors.bg;
  document.documentElement.style.colorScheme = themeName;
  if (document.body) document.body.style.backgroundColor = colors.bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', colors.bg);
}

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };

/** Escala de espaciado en múltiplos de 4. */
export const space = (n: number): number => n * 4;
