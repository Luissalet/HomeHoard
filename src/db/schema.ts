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

-- Ficha del aparato u objeto (una por objeto; id = item_id). Listas como JSON en texto.
CREATE TABLE IF NOT EXISTS item_details (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL,
  brand TEXT, model TEXT, serial TEXT, purchase_date TEXT, store TEXT, price REAL,
  warranty_until TEXT, warranty_source TEXT, kafka_doc_ids TEXT NOT NULL DEFAULT '[]', manual_url TEXT,
  consumables TEXT NOT NULL DEFAULT '[]', notes TEXT, source_ref TEXT, warranty_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);

-- Mantenimiento: tareas sobre un objeto, mueble, habitación o vivienda, y su historial.
CREATE TABLE IF NOT EXISTS maintenance_task (
  id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, title TEXT NOT NULL,
  every_days INTEGER, every_months INTEGER, anchor_month INTEGER, last_done_at INTEGER,
  next_due TEXT, next_due_manual INTEGER NOT NULL DEFAULT 0, notes TEXT,
  basis TEXT NOT NULL DEFAULT 'advice', legal_ref TEXT, template_id TEXT, kafka_deadline_id TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS maintenance_log (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, done_at INTEGER NOT NULL, note TEXT, cost REAL, who TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mtask_target ON maintenance_task(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_mlog_task ON maintenance_log(task_id);

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
  // 0.3: vínculos objeto–etiqueta con id determinista, fecha y lápida (para sincronizar y exportar en versión 3).
  `ALTER TABLE item_tag ADD COLUMN id TEXT`,
  `ALTER TABLE item_tag ADD COLUMN created_at INTEGER`,
  `ALTER TABLE item_tag ADD COLUMN updated_at INTEGER`,
  `ALTER TABLE item_tag ADD COLUMN deleted_at INTEGER`,
  `UPDATE item_tag SET id = item_id || ':' || tag_id WHERE id IS NULL`,
  // 0.4: de dónde viene el objeto (hoard://app/tipo/id) y el papel de su garantía, para los objetos dados de alta desde una compra.
  `ALTER TABLE item_details ADD COLUMN source_ref TEXT`,
  `ALTER TABLE item_details ADD COLUMN warranty_ref TEXT`,
  `UPDATE item_tag SET updated_at = COALESCE((SELECT updated_at FROM item WHERE item.id = item_tag.item_id), 0) WHERE updated_at IS NULL`,
];
