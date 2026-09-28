// Fuente de datos por defecto (NATIVO: iOS/Android) → SQLite en el dispositivo.
// En web, Metro resuelve index.web.ts en su lugar (nunca mete expo-sqlite en el bundle web).
import type { DataSource } from './types';
import { SqliteSource } from './sqlite';

export const data: DataSource = new SqliteSource();
export * from './types';
