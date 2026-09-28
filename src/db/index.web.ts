// Fuente de datos en WEB → almacén en memoria persistido en localStorage.
// Nunca importa ./sqlite, así expo-sqlite no entra en el bundle web.
import type { DataSource } from './types';
import { MemorySource } from './memory';

export const data: DataSource = new MemorySource();
export * from './types';
