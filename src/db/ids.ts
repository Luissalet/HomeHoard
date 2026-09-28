import * as Crypto from 'expo-crypto';

/** UUID generado en cliente (clave para el sync futuro: sin colisiones offline). */
export const newId = (): string => Crypto.randomUUID();

/** Marca de tiempo epoch en milisegundos. */
export const now = (): number => Date.now();
