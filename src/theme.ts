// Paleta cálida para consultar el inventario con buena luz y en pantallas pequeñas.
export const colors = {
  bg: '#F6F3EB',
  surface: '#FFFEFA',
  surface2: '#ECE8DE',
  border: '#D9D5C9',
  text: '#182A24',
  textDim: '#52635A',
  accent: '#1D6450',
  accent2: '#16523F',
  danger: '#B3342D',
  good: '#23735C',
  warn: '#A15D20',
};

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };

/** Escala de espaciado en múltiplos de 4. */
export const space = (n: number): number => n * 4;
