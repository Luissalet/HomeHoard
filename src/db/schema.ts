// Esquema SQLite de HomeHoard (validado). Ejecutado por SqliteSource en el arranque.
// Convención: id = UUID texto; *_at = epoch en ms; deleted_at NULL = fila viva (tombstone).

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS household (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES household(id),
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS home (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES household(id),
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'house',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS floor (
  id TEXT PRIMARY KEY, home_id TEXT NOT NULL REFERENCES home(id),
  name TEXT NOT NULL, level_index INTEGER NOT NULL DEFAULT 0,
  width_cm INTEGER NOT NULL DEFAULT 1000, height_cm INTEGER NOT NULL DEFAULT 1000,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS room (
  id TEXT PRIMARY KEY, floor_id TEXT NOT NULL REFERENCES floor(id),
  name TEXT NOT NULL, kind TEXT, color TEXT,
  shape TEXT NOT NULL DEFAULT 'rect',
  x_cm REAL NOT NULL DEFAULT 0, y_cm REAL NOT NULL DEFAULT 0,
  width_cm REAL NOT NULL DEFAULT 300, height_cm REAL NOT NULL DEFAULT 300,
  rotation REAL NOT NULL DEFAULT 0, points_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS container (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES room(id),
  parent_container_id TEXT REFERENCES container(id),
  name TEXT NOT NULL, kind TEXT, icon TEXT,
  x_cm REAL, y_cm REAL, width_cm REAL, height_cm REAL, rotation REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES household(id),
  name TEXT NOT NULL, description TEXT, quantity INTEGER NOT NULL DEFAULT 1,
  room_id TEXT NOT NULL REFERENCES room(id),
  container_id TEXT REFERENCES container(id),
  photo_uri TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS item_photo (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES item(id),
  uri TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tag (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES household(id),
  name TEXT NOT NULL, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS item_tag (
  item_id TEXT NOT NULL REFERENCES item(id), tag_id TEXT NOT NULL REFERENCES tag(id),
  PRIMARY KEY (item_id, tag_id)
);

-- Nota: la búsqueda v0 usa LIKE (rápido para inventarios personales). FTS5 queda
-- como optimización futura (ver spec §6).

CREATE INDEX IF NOT EXISTS idx_item_room        ON item(room_id);
CREATE INDEX IF NOT EXISTS idx_item_container   ON item(container_id);
CREATE INDEX IF NOT EXISTS idx_container_room   ON container(room_id);
CREATE INDEX IF NOT EXISTS idx_container_parent ON container(parent_container_id);
CREATE INDEX IF NOT EXISTS idx_room_floor       ON room(floor_id);
CREATE INDEX IF NOT EXISTS idx_floor_home       ON floor(home_id);
`;

/**
 * Migraciones para bases de datos existentes (anteriores a cada columna nueva).
 * Cada entrada se intenta y, si la columna ya existe, el error se ignora.
 */
export const MIGRATIONS: string[] = [
  `ALTER TABLE item ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`,
];
