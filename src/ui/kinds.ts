import { Ionicons } from '@expo/vector-icons';

// Iconos coherentes en todo el inventario.

const ROOM_LINE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  bedroom: 'bed-outline', living: 'tv-outline', kitchen: 'restaurant-outline', bathroom: 'water-outline',
  office: 'desktop-outline', garage: 'car-outline', storage: 'cube-outline', hall: 'enter-outline',
  kids: 'happy-outline', dining: 'restaurant-outline',
};
const CONTAINER_LINE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  wardrobe: 'file-tray-outline', dresser: 'albums-outline', drawer: 'file-tray-outline', shelf: 'library-outline',
  cabinet: 'grid-outline', box: 'cube-outline', fridge: 'snow-outline', nightstand: 'bed-outline',
  desk: 'desktop-outline', chest: 'briefcase-outline', closet: 'file-tray-outline',
};
export const roomLineIcon = (kind?: string | null): keyof typeof Ionicons.glyphMap => (kind && ROOM_LINE_ICONS[kind]) || 'grid-outline';
export const containerLineIcon = (kind?: string | null): keyof typeof Ionicons.glyphMap => (kind && CONTAINER_LINE_ICONS[kind]) || 'file-tray-outline';

export const ROOM_KINDS: { key: string; label: string }[] = [
  { key: 'bedroom', label: 'Dormitorio' },
  { key: 'living', label: 'Salón' },
  { key: 'kitchen', label: 'Cocina' },
  { key: 'bathroom', label: 'Baño' },
  { key: 'office', label: 'Oficina' },
  { key: 'garage', label: 'Garaje' },
  { key: 'storage', label: 'Trastero' },
  { key: 'dining', label: 'Comedor' },
];

export const CONTAINER_KINDS: { key: string; label: string }[] = [
  { key: 'wardrobe', label: 'Armario' },
  { key: 'dresser', label: 'Cómoda' },
  { key: 'drawer', label: 'Cajón' },
  { key: 'shelf', label: 'Estantería' },
  { key: 'cabinet', label: 'Alacena' },
  { key: 'box', label: 'Caja' },
  { key: 'fridge', label: 'Nevera' },
  { key: 'nightstand', label: 'Mesita' },
  { key: 'chest', label: 'Baúl' },
];

export const containerKindLabel = (kind?: string | null): string =>
  CONTAINER_KINDS.find((k) => k.key === kind)?.label ?? 'Mueble';
export const roomKindLabel = (kind?: string | null): string =>
  ROOM_KINDS.find((k) => k.key === kind)?.label ?? 'Habitación';

// Paleta para habitaciones nuevas.
export const ROOM_COLORS = ['#5C8171', '#9A8060', '#647D93', '#9B705F', '#776D8D', '#7C8B5E', '#9D8254', '#697F77'];
