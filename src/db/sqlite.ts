// Fuente de datos SQLite — usada en NATIVO (iOS/Android). Web usa memory.ts.
// Misma semántica que MemorySource (validada en Node) pero sobre expo-sqlite.
import * as SQLite from 'expo-sqlite';
import { newId, now } from './ids';
import { applyTaskPatch, cleanDetails, newTask } from './mutations';
import { linkId, recordsFromBundle } from './records';
import { MIGRATIONS, SCHEMA } from './schema';
import { rankSearch } from './searchUtil';
import { computeNextDue } from '../features/maintenanceCore';
import type {
  Container,
  DataSource,
  ExportBundle,
  Floor,
  FloorPlan,
  Home,
  Household,
  ID,
  Item,
  ItemDetails,
  ItemDetailsInput,
  ItemTag,
  ItemWithLocation,
  MaintenanceLog,
  MaintenanceTarget,
  MaintenanceTask,
  MaintenanceWithTarget,
  NewItemInput,
  NewMaintenanceInput,
  PathSegment,
  Rect,
  Room,
  RoomChoice,
  RoomItemCount,
  Stats,
  Tag,
  UpdateItemInput,
  UpdateMaintenanceInput,
} from './types';

const TASK_COLS = ['id', 'target_kind', 'target_id', 'title', 'every_days', 'every_months', 'anchor_month', 'last_done_at', 'next_due',
  'next_due_manual', 'notes', 'basis', 'legal_ref', 'template_id', 'kafka_deadline_id', 'paused', 'created_at', 'updated_at', 'deleted_at'] as const;
const DETAIL_COLS = ['id', 'item_id', 'brand', 'model', 'serial', 'purchase_date', 'store', 'price', 'warranty_until', 'warranty_source',
  'kafka_doc_ids', 'manual_url', 'consumables', 'notes', 'created_at', 'updated_at', 'deleted_at'] as const;
const LOG_COLS = ['id', 'task_id', 'done_at', 'note', 'cost', 'who', 'created_at', 'updated_at', 'deleted_at'] as const;

type Row = Record<string, unknown>;
const bind = (v: unknown): SQLite.SQLiteBindValue => (v === undefined ? null : Array.isArray(v) ? JSON.stringify(v) : (v as SQLite.SQLiteBindValue));
const parseList = <T,>(v: unknown): T[] => {
  if (Array.isArray(v)) return v as T[];
  try {
    const parsed = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const detailsRow = (r: Row | null): ItemDetails | null =>
  r ? ({ ...r, kafka_doc_ids: parseList<string>(r.kafka_doc_ids), consumables: parseList(r.consumables) } as unknown as ItemDetails) : null;

export class SqliteSource implements DataSource {
  private db: SQLite.SQLiteDatabase | null = null;

  async ready(): Promise<void> {
    if (this.db) return;
    const db = await SQLite.openDatabaseAsync('homehoard.db');
    await db.execAsync(SCHEMA);
    // Migraciones idempotentes: si la columna ya existe, SQLite lanza y lo ignoramos.
    for (const m of MIGRATIONS) {
      try {
        await db.execAsync(m);
      } catch {
        /* columna ya presente */
      }
    }
    this.db = db;
    await this.getDefaultHousehold();
  }

  private get d(): SQLite.SQLiteDatabase {
    if (!this.db) throw new Error('DB no inicializada: llama a ready() primero');
    return this.db;
  }

  async isEmpty(): Promise<boolean> {
    const row = await this.d.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM home WHERE deleted_at IS NULL'
    );
    return (row?.n ?? 0) === 0;
  }

  async getDefaultHousehold(): Promise<Household> {
    let hh = await this.d.getFirstAsync<Household>(
      'SELECT * FROM household WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1'
    );
    if (!hh) {
      const t = now();
      const id = newId();
      await this.d.runAsync(
        'INSERT INTO household (id, name, created_at, updated_at, deleted_at) VALUES (?,?,?,?,NULL)',
        [id, 'Mi casa', t, t]
      );
      hh = { id, name: 'Mi casa', created_at: t, updated_at: t, deleted_at: null };
    }
    return hh;
  }

  // ── Jerarquía espacial ──────────────────────────────────────
  async listHomes(): Promise<Home[]> {
    return this.d.getAllAsync<Home>(
      'SELECT * FROM home WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE'
    );
  }

  async listFloors(homeId: ID): Promise<Floor[]> {
    return this.d.getAllAsync<Floor>(
      'SELECT * FROM floor WHERE home_id = ? AND deleted_at IS NULL ORDER BY level_index',
      [homeId]
    );
  }

  async getFloor(floorId: ID): Promise<Floor | null> {
    return (
      (await this.d.getFirstAsync<Floor>('SELECT * FROM floor WHERE id = ? AND deleted_at IS NULL', [floorId])) ?? null
    );
  }

  async getFloorPlan(floorId: ID): Promise<FloorPlan> {
    const floor = await this.getFloor(floorId);
    if (!floor) throw new Error(`Floor no encontrado: ${floorId}`);
    const rooms = await this.d.getAllAsync<Room>(
      'SELECT * FROM room WHERE floor_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
      [floorId]
    );
    const rootContainers = await this.d.getAllAsync<Container>(
      `SELECT c.* FROM container c
       JOIN room r ON r.id = c.room_id
       WHERE r.floor_id = ? AND c.deleted_at IS NULL
         AND c.parent_container_id IS NULL AND c.x_cm IS NOT NULL`,
      [floorId]
    );
    return { floor, rooms, rootContainers };
  }

  async getRoom(roomId: ID): Promise<Room | null> {
    return (
      (await this.d.getFirstAsync<Room>('SELECT * FROM room WHERE id = ? AND deleted_at IS NULL', [roomId])) ?? null
    );
  }

  async listAllRooms(): Promise<RoomChoice[]> {
    const homes = await this.listHomes();
    const out: RoomChoice[] = [];
    for (const h of homes) {
      const floors = await this.listFloors(h.id);
      for (const f of floors) {
        const rooms = await this.d.getAllAsync<Room>(
          'SELECT * FROM room WHERE floor_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
          [f.id]
        );
        const prefix = `${homes.length > 1 ? h.name + ' · ' : ''}${floors.length > 1 ? f.name + ' · ' : ''}`;
        for (const r of rooms) out.push({ room: r, label: prefix + r.name });
      }
    }
    return out;
  }

  // ── Contenedores ────────────────────────────────────────────
  async listRootContainers(roomId: ID): Promise<Container[]> {
    return this.d.getAllAsync<Container>(
      'SELECT * FROM container WHERE room_id = ? AND parent_container_id IS NULL AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
      [roomId]
    );
  }

  async listChildContainers(containerId: ID): Promise<Container[]> {
    return this.d.getAllAsync<Container>(
      'SELECT * FROM container WHERE parent_container_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
      [containerId]
    );
  }

  async getContainer(containerId: ID): Promise<Container | null> {
    return (
      (await this.d.getFirstAsync<Container>('SELECT * FROM container WHERE id = ? AND deleted_at IS NULL', [
        containerId,
      ])) ?? null
    );
  }

  // ── Objetos ─────────────────────────────────────────────────
  async getItem(itemId: ID): Promise<Item | null> {
    return (
      (await this.d.getFirstAsync<Item>('SELECT * FROM item WHERE id = ? AND deleted_at IS NULL', [itemId])) ?? null
    );
  }

  async getItemWithLocation(itemId: ID): Promise<ItemWithLocation | null> {
    const item = await this.getItem(itemId);
    if (!item) return null;
    const [decorated] = await this.decorateAll([item]);
    return decorated ?? null;
  }

  /** Decora en lote: 3 consultas totales en lugar de 3 por objeto. */
  private async decorateAll(items: Item[]): Promise<ItemWithLocation[]> {
    if (!items.length) return [];
    const rooms = await this.d.getAllAsync<{ id: ID; name: string }>('SELECT id, name FROM room');
    const conts = await this.d.getAllAsync<{ id: ID; name: string }>('SELECT id, name FROM container');
    const links = await this.d.getAllAsync<Tag & { item_id: ID }>(
      `SELECT it.item_id AS item_id, t.* FROM item_tag it
       JOIN tag t ON t.id = it.tag_id WHERE t.deleted_at IS NULL AND it.deleted_at IS NULL
       ORDER BY t.name COLLATE NOCASE`
    );
    const roomName = new Map(rooms.map((r) => [r.id, r.name]));
    const contName = new Map(conts.map((c) => [c.id, c.name]));
    const tagsByItem = new Map<ID, Tag[]>();
    for (const l of links) {
      const { item_id, ...tag } = l;
      const arr = tagsByItem.get(item_id) ?? [];
      arr.push(tag as Tag);
      tagsByItem.set(item_id, arr);
    }
    return items.map((i) => ({
      ...i,
      roomName: roomName.get(i.room_id) ?? '—',
      containerName: i.container_id ? contName.get(i.container_id) ?? null : null,
      tags: tagsByItem.get(i.id) ?? [],
    }));
  }

  async getItemPath(itemId: ID): Promise<PathSegment[]> {
    const item = await this.getItem(itemId);
    if (!item) return [];
    const segments: PathSegment[] = [];
    const room = await this.getRoom(item.room_id);
    if (room) {
      const floor = await this.getFloor(room.floor_id);
      const home = floor
        ? await this.d.getFirstAsync<Home>('SELECT * FROM home WHERE id = ?', [floor.home_id])
        : null;
      if (home) segments.push({ kind: 'home', id: home.id, name: home.name });
      if (floor) segments.push({ kind: 'floor', id: floor.id, name: floor.name });
      segments.push({ kind: 'room', id: room.id, name: room.name });
    }
    const chain: Container[] = [];
    let cid = item.container_id;
    const guard = new Set<ID>();
    while (cid && !guard.has(cid)) {
      guard.add(cid);
      const c = await this.d.getFirstAsync<Container>('SELECT * FROM container WHERE id = ?', [cid]);
      if (!c) break;
      chain.unshift(c);
      cid = c.parent_container_id;
    }
    for (const c of chain) segments.push({ kind: 'container', id: c.id, name: c.name });
    return segments;
  }

  async listLooseItemsInRoom(roomId: ID): Promise<Item[]> {
    return this.d.getAllAsync<Item>(
      'SELECT * FROM item WHERE room_id = ? AND container_id IS NULL AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
      [roomId]
    );
  }

  async listItemsInContainer(containerId: ID): Promise<Item[]> {
    return this.d.getAllAsync<Item>(
      'SELECT * FROM item WHERE container_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE',
      [containerId]
    );
  }

  async listItemsInContainerDeep(containerId: ID): Promise<Item[]> {
    return this.d.getAllAsync<Item>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM container WHERE id = ?
         UNION ALL
         SELECT c.id FROM container c JOIN sub ON c.parent_container_id = sub.id
       )
       SELECT i.* FROM item i
       WHERE i.container_id IN (SELECT id FROM sub) AND i.deleted_at IS NULL
       ORDER BY i.name COLLATE NOCASE`,
      [containerId]
    );
  }

  async countItemsInRoom(roomId: ID): Promise<number> {
    const row = await this.d.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM item WHERE room_id = ? AND deleted_at IS NULL',
      [roomId]
    );
    return row?.n ?? 0;
  }

  async listFavoriteItems(): Promise<ItemWithLocation[]> {
    const rows = await this.d.getAllAsync<Item>(
      'SELECT * FROM item WHERE favorite = 1 AND deleted_at IS NULL ORDER BY name COLLATE NOCASE'
    );
    return this.decorateAll(rows);
  }

  async listRecentItems(limit: number): Promise<ItemWithLocation[]> {
    const rows = await this.d.getAllAsync<Item>(
      'SELECT * FROM item WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?',
      [limit]
    );
    return this.decorateAll(rows);
  }

  // ── Búsqueda (normalizada + relevancia, en searchUtil) ──────
  async searchItems(query: string, tagIds?: ID[]): Promise<ItemWithLocation[]> {
    const clauses: string[] = ['i.deleted_at IS NULL'];
    const params: SQLite.SQLiteBindValue[] = [];
    if (tagIds && tagIds.length) {
      const placeholders = tagIds.map(() => '?').join(',');
      clauses.push(`EXISTS (
        SELECT 1 FROM item_tag it WHERE it.item_id = i.id AND it.deleted_at IS NULL AND it.tag_id IN (${placeholders})
      )`);
      params.push(...tagIds);
    }
    const rows = await this.d.getAllAsync<Item>(
      `SELECT i.* FROM item i WHERE ${clauses.join(' AND ')}`,
      params
    );
    const decorated = await this.decorateAll(rows);
    return rankSearch(decorated, query);
  }

  // ── Tags ────────────────────────────────────────────────────
  async listTags(): Promise<Tag[]> {
    return this.d.getAllAsync<Tag>(
      'SELECT * FROM tag WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE'
    );
  }

  async createTag(name: string, color: string | null = null): Promise<Tag> {
    const existing = await this.d.getFirstAsync<Tag>(
      'SELECT * FROM tag WHERE deleted_at IS NULL AND LOWER(name) = LOWER(?)',
      [name]
    );
    if (existing) return existing;
    const hh = await this.getDefaultHousehold();
    const t = now();
    const id = newId();
    await this.d.runAsync(
      'INSERT INTO tag (id, household_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)',
      [id, hh.id, name, color, t, t]
    );
    return { id, household_id: hh.id, name, color, created_at: t, updated_at: t, deleted_at: null };
  }

  async updateTag(tagId: ID, patch: { name?: string; color?: string | null }): Promise<void> {
    const fields: string[] = [];
    const params: SQLite.SQLiteBindValue[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(patch.name);
    }
    if (patch.color !== undefined) {
      fields.push('color = ?');
      params.push(patch.color);
    }
    if (!fields.length) return;
    fields.push('updated_at = ?');
    params.push(now(), tagId);
    await this.d.runAsync(`UPDATE tag SET ${fields.join(', ')} WHERE id = ?`, params);
  }

  async deleteTag(tagId: ID): Promise<void> {
    const t = now();
    await this.d.runAsync('UPDATE item_tag SET deleted_at = ?, updated_at = ? WHERE tag_id = ? AND deleted_at IS NULL', [t, t, tagId]);
    await this.d.runAsync('UPDATE tag SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, tagId]);
  }

  async getItemTags(itemId: ID): Promise<Tag[]> {
    return this.d.getAllAsync<Tag>(
      `SELECT t.* FROM tag t JOIN item_tag it ON it.tag_id = t.id
       WHERE it.item_id = ? AND t.deleted_at IS NULL AND it.deleted_at IS NULL ORDER BY t.name COLLATE NOCASE`,
      [itemId]
    );
  }

  /** Vínculos con lápida: quitar una etiqueta queda registrado para exportarlo y combinarlo. */
  private async setItemTags(itemId: ID, tagIds: ID[]): Promise<void> {
    const t = now();
    const wanted = new Set(tagIds);
    const placeholders = tagIds.map(() => '?').join(',');
    await this.d.runAsync(
      `UPDATE item_tag SET deleted_at = ?, updated_at = ? WHERE item_id = ? AND deleted_at IS NULL${tagIds.length ? ` AND tag_id NOT IN (${placeholders})` : ''}`,
      [t, t, itemId, ...tagIds]
    );
    for (const tagId of wanted) {
      await this.d.runAsync(
        `INSERT INTO item_tag (item_id, tag_id, id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,NULL)
         ON CONFLICT(item_id, tag_id) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at WHERE item_tag.deleted_at IS NOT NULL`,
        [itemId, tagId, linkId(itemId, tagId), t, t]
      );
    }
  }

  // ── Mutaciones de objetos ───────────────────────────────────
  async addItem(input: NewItemInput): Promise<Item> {
    const hh = await this.getDefaultHousehold();
    const t = now();
    const item: Item = {
      id: newId(),
      household_id: hh.id,
      name: input.name,
      description: input.description ?? null,
      quantity: input.quantity ?? 1,
      room_id: input.room_id,
      container_id: input.container_id ?? null,
      photo_uri: input.photo_uri ?? null,
      favorite: input.favorite ? 1 : 0,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    };
    await this.d.runAsync(
      `INSERT INTO item (id, household_id, name, description, quantity, room_id, container_id, photo_uri, favorite, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [item.id, item.household_id, item.name, item.description, item.quantity, item.room_id, item.container_id, item.photo_uri, item.favorite, item.created_at, item.updated_at]
    );
    if (input.tagIds?.length) await this.setItemTags(item.id, input.tagIds);
    return item;
  }

  async updateItem(id: ID, patch: UpdateItemInput): Promise<void> {
    const fields: string[] = [];
    const params: SQLite.SQLiteBindValue[] = [];
    const set = (col: string, val: SQLite.SQLiteBindValue) => {
      fields.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.quantity !== undefined) set('quantity', patch.quantity);
    if (patch.room_id !== undefined) set('room_id', patch.room_id);
    if (patch.container_id !== undefined) set('container_id', patch.container_id);
    if (patch.photo_uri !== undefined) set('photo_uri', patch.photo_uri);
    if (patch.favorite !== undefined) set('favorite', patch.favorite ? 1 : 0);
    set('updated_at', now());
    if (fields.length) {
      params.push(id);
      await this.d.runAsync(`UPDATE item SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    if (patch.tagIds !== undefined) await this.setItemTags(id, patch.tagIds);
  }

  async setItemFavorite(id: ID, favorite: boolean): Promise<void> {
    await this.d.runAsync('UPDATE item SET favorite = ?, updated_at = ? WHERE id = ?', [favorite ? 1 : 0, now(), id]);
  }

  async deleteItem(id: ID): Promise<void> {
    const t = now();
    await this.d.runAsync('UPDATE item SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
  }

  async restoreItem(id: ID): Promise<void> {
    await this.d.runAsync('UPDATE item SET deleted_at = NULL, updated_at = ? WHERE id = ?', [now(), id]);
  }

  // ── Mutaciones de estructura ────────────────────────────────
  async addHome(name: string, kind = 'house'): Promise<Home> {
    const hh = await this.getDefaultHousehold();
    const t = now();
    const home: Home = { id: newId(), household_id: hh.id, name, kind, created_at: t, updated_at: t, deleted_at: null };
    await this.d.runAsync(
      'INSERT INTO home (id, household_id, name, kind, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)',
      [home.id, home.household_id, home.name, home.kind, home.created_at, home.updated_at]
    );
    return home;
  }

  async addFloor(homeId: ID, name: string, widthCm = 1000, heightCm = 1000): Promise<Floor> {
    const t = now();
    const row = await this.d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM floor WHERE home_id = ?', [homeId]);
    const floor: Floor = {
      id: newId(),
      home_id: homeId,
      name,
      level_index: row?.n ?? 0,
      width_cm: widthCm,
      height_cm: heightCm,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    };
    await this.d.runAsync(
      'INSERT INTO floor (id, home_id, name, level_index, width_cm, height_cm, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,NULL)',
      [floor.id, floor.home_id, floor.name, floor.level_index, floor.width_cm, floor.height_cm, floor.created_at, floor.updated_at]
    );
    return floor;
  }

  async addRoom(floorId: ID, name: string, rect: Rect, opts?: { kind?: string; color?: string }): Promise<Room> {
    const t = now();
    const room: Room = {
      id: newId(),
      floor_id: floorId,
      name,
      kind: opts?.kind ?? null,
      color: opts?.color ?? null,
      shape: 'rect',
      x_cm: rect.x_cm,
      y_cm: rect.y_cm,
      width_cm: rect.width_cm,
      height_cm: rect.height_cm,
      rotation: rect.rotation ?? 0,
      points_json: null,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    };
    await this.d.runAsync(
      `INSERT INTO room (id, floor_id, name, kind, color, shape, x_cm, y_cm, width_cm, height_cm, rotation, points_json, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)`,
      [room.id, room.floor_id, room.name, room.kind, room.color, room.shape, room.x_cm, room.y_cm, room.width_cm, room.height_cm, room.rotation, room.created_at, room.updated_at]
    );
    return room;
  }

  async addContainer(
    roomId: ID,
    name: string,
    opts?: { kind?: string; parentContainerId?: ID | null; rect?: Rect | null; icon?: string }
  ): Promise<Container> {
    const t = now();
    const rect = opts?.rect ?? null;
    const container: Container = {
      id: newId(),
      room_id: roomId,
      parent_container_id: opts?.parentContainerId ?? null,
      name,
      kind: opts?.kind ?? null,
      icon: opts?.icon ?? null,
      x_cm: rect?.x_cm ?? null,
      y_cm: rect?.y_cm ?? null,
      width_cm: rect?.width_cm ?? null,
      height_cm: rect?.height_cm ?? null,
      rotation: rect?.rotation ?? 0,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    };
    await this.d.runAsync(
      `INSERT INTO container (id, room_id, parent_container_id, name, kind, icon, x_cm, y_cm, width_cm, height_cm, rotation, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [container.id, container.room_id, container.parent_container_id, container.name, container.kind, container.icon, container.x_cm, container.y_cm, container.width_cm, container.height_cm, container.rotation, container.created_at, container.updated_at]
    );
    return container;
  }

  async updateRoomGeometry(roomId: ID, rect: Rect): Promise<void> {
    await this.d.runAsync(
      'UPDATE room SET x_cm = ?, y_cm = ?, width_cm = ?, height_cm = ?, rotation = ?, updated_at = ? WHERE id = ?',
      [rect.x_cm, rect.y_cm, rect.width_cm, rect.height_cm, rect.rotation ?? 0, now(), roomId]
    );
  }

  async updateContainerGeometry(containerId: ID, rect: Rect): Promise<void> {
    await this.d.runAsync(
      'UPDATE container SET x_cm = ?, y_cm = ?, width_cm = ?, height_cm = ?, rotation = ?, updated_at = ? WHERE id = ?',
      [rect.x_cm, rect.y_cm, rect.width_cm, rect.height_cm, rect.rotation ?? 0, now(), containerId]
    );
  }

  async renameRoom(roomId: ID, name: string): Promise<void> {
    await this.d.runAsync('UPDATE room SET name = ?, updated_at = ? WHERE id = ?', [name, now(), roomId]);
  }

  async renameContainer(containerId: ID, name: string): Promise<void> {
    await this.d.runAsync('UPDATE container SET name = ?, updated_at = ? WHERE id = ?', [name, now(), containerId]);
  }

  async updateRoomMeta(roomId: ID, patch: { name?: string; kind?: string | null; color?: string | null }): Promise<void> {
    const fields: string[] = [];
    const params: SQLite.SQLiteBindValue[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(patch.name);
    }
    if (patch.kind !== undefined) {
      fields.push('kind = ?');
      params.push(patch.kind);
    }
    if (patch.color !== undefined) {
      fields.push('color = ?');
      params.push(patch.color);
    }
    if (!fields.length) return;
    fields.push('updated_at = ?');
    params.push(now(), roomId);
    await this.d.runAsync(`UPDATE room SET ${fields.join(', ')} WHERE id = ?`, params);
  }

  async updateContainerMeta(containerId: ID, patch: { name?: string; kind?: string | null; icon?: string | null }): Promise<void> {
    const fields: string[] = [];
    const params: SQLite.SQLiteBindValue[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(patch.name);
    }
    if (patch.kind !== undefined) {
      fields.push('kind = ?');
      params.push(patch.kind);
    }
    if (patch.icon !== undefined) {
      fields.push('icon = ?');
      params.push(patch.icon);
    }
    if (!fields.length) return;
    fields.push('updated_at = ?');
    params.push(now(), containerId);
    await this.d.runAsync(`UPDATE container SET ${fields.join(', ')} WHERE id = ?`, params);
  }

  async deleteContainer(containerId: ID): Promise<void> {
    const t = now();
    // Subárbol completo del contenedor
    const sub = await this.d.getAllAsync<{ id: ID }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM container WHERE id = ?
         UNION ALL
         SELECT c.id FROM container c JOIN sub ON c.parent_container_id = sub.id
       ) SELECT id FROM sub`,
      [containerId]
    );
    const ids = sub.map((r) => r.id);
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    // Los objetos del subárbol pasan a "sueltos" en su habitación (no se pierden).
    await this.d.runAsync(
      `UPDATE item SET container_id = NULL, updated_at = ? WHERE container_id IN (${ph}) AND deleted_at IS NULL`,
      [t, ...ids]
    );
    await this.d.runAsync(
      `UPDATE container SET deleted_at = ?, updated_at = ? WHERE id IN (${ph})`,
      [t, t, ...ids]
    );
  }

  async deleteRoom(roomId: ID): Promise<boolean> {
    const items = await this.countItemsInRoom(roomId);
    const conts = await this.d.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM container WHERE room_id = ? AND deleted_at IS NULL',
      [roomId]
    );
    if (items > 0 || (conts?.n ?? 0) > 0) return false;
    const t = now();
    await this.d.runAsync('UPDATE room SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, roomId]);
    return true;
  }

  // ── Stats ───────────────────────────────────────────────────
  async countItemsByRoom(floorId: ID): Promise<RoomItemCount[]> {
    const rooms = await this.d.getAllAsync<Room>(
      'SELECT * FROM room WHERE floor_id = ? AND deleted_at IS NULL',
      [floorId]
    );
    const counts = await this.d.getAllAsync<{ room_id: ID; n: number }>(
      `SELECT room_id, COUNT(*) AS n FROM item WHERE deleted_at IS NULL GROUP BY room_id`
    );
    const byRoom = new Map(counts.map((c) => [c.room_id, c.n]));
    return rooms
      .map((room) => ({ room, count: byRoom.get(room.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
  }

  async getStats(): Promise<Stats> {
    const one = async (sql: string): Promise<number> =>
      (await this.d.getFirstAsync<{ n: number }>(sql))?.n ?? 0;
    return {
      homes: await one('SELECT COUNT(*) AS n FROM home WHERE deleted_at IS NULL'),
      floors: await one('SELECT COUNT(*) AS n FROM floor WHERE deleted_at IS NULL'),
      rooms: await one('SELECT COUNT(*) AS n FROM room WHERE deleted_at IS NULL'),
      containers: await one('SELECT COUNT(*) AS n FROM container WHERE deleted_at IS NULL'),
      items: await one('SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NULL'),
      totalQuantity: await one('SELECT COALESCE(SUM(quantity),0) AS n FROM item WHERE deleted_at IS NULL'),
      photos: await one('SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NULL AND photo_uri IS NOT NULL'),
      tags: await one('SELECT COUNT(*) AS n FROM tag WHERE deleted_at IS NULL'),
      favorites: await one('SELECT COUNT(*) AS n FROM item WHERE deleted_at IS NULL AND favorite = 1'),
    };
  }

  // ── Ficha del objeto ────────────────────────────────────────
  async getItemDetails(itemId: ID): Promise<ItemDetails | null> {
    return detailsRow(await this.d.getFirstAsync<Row>('SELECT * FROM item_details WHERE id = ? AND deleted_at IS NULL', [itemId]));
  }

  async saveItemDetails(itemId: ID, patch: ItemDetailsInput): Promise<ItemDetails> {
    const t = now();
    const current = detailsRow(await this.d.getFirstAsync<Row>('SELECT * FROM item_details WHERE id = ?', [itemId]));
    const row: ItemDetails = {
      id: itemId, item_id: itemId, brand: null, model: null, serial: null, purchase_date: null, store: null, price: null, warranty_until: null,
      warranty_source: null, kafka_doc_ids: [], manual_url: null, consumables: [], notes: null, created_at: t, ...(current ?? {}),
      ...cleanDetails(patch), updated_at: Math.max(t, (current?.updated_at ?? 0) + 1), deleted_at: null,
    };
    if (patch.warranty_until !== undefined && patch.warranty_source === undefined) row.warranty_source = row.warranty_until ? 'manual' : null;
    await this.upsert('item_details', DETAIL_COLS, row as unknown as Row);
    return row;
  }

  private async upsert(table: string, cols: readonly string[], row: Row): Promise<void> {
    await this.d.runAsync(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => bind(row[c])));
  }

  // ── Mantenimiento ───────────────────────────────────────────
  private async targetOf(kind: MaintenanceTarget, id: ID): Promise<{ name: string | null; path: string | null }> {
    if (kind === 'item') {
      const path = await this.getItemPath(id);
      const name = path.length ? (await this.getItem(id))?.name ?? null : null;
      const crumbs = path.filter((s) => s.kind === 'room' || s.kind === 'container').map((s) => s.name);
      return { name, path: crumbs.join(' › ') || null };
    }
    const table = kind === 'container' ? 'container' : kind === 'room' ? 'room' : 'home';
    const row = await this.d.getFirstAsync<{ name: string }>(`SELECT name FROM ${table} WHERE id = ? AND deleted_at IS NULL`, [id]);
    return { name: row?.name ?? null, path: row?.name ?? null };
  }

  async listMaintenance(filter?: { target_kind?: MaintenanceTarget; target_id?: ID }): Promise<MaintenanceWithTarget[]> {
    const clauses = ['deleted_at IS NULL'];
    const params: SQLite.SQLiteBindValue[] = [];
    if (filter?.target_kind) { clauses.push('target_kind = ?'); params.push(filter.target_kind); }
    if (filter?.target_id) { clauses.push('target_id = ?'); params.push(filter.target_id); }
    const rows = await this.d.getAllAsync<MaintenanceTask>(`SELECT * FROM maintenance_task WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(next_due, '9999'), title`, params);
    const out: MaintenanceWithTarget[] = [];
    for (const r of rows) {
      const { name, path } = await this.targetOf(r.target_kind, r.target_id);
      out.push({ ...r, targetName: name, targetPath: path });
    }
    return out;
  }

  async getMaintenance(taskId: ID): Promise<MaintenanceTask | null> {
    return (await this.d.getFirstAsync<MaintenanceTask>('SELECT * FROM maintenance_task WHERE id = ? AND deleted_at IS NULL', [taskId])) ?? null;
  }

  async addMaintenance(input: NewMaintenanceInput): Promise<MaintenanceTask> {
    const task = newTask(input, now());
    await this.upsert('maintenance_task', TASK_COLS, task as unknown as Row);
    return task;
  }

  async updateMaintenance(taskId: ID, patch: UpdateMaintenanceInput): Promise<MaintenanceTask | null> {
    const task = await this.d.getFirstAsync<MaintenanceTask>('SELECT * FROM maintenance_task WHERE id = ?', [taskId]);
    if (!task) return null;
    applyTaskPatch(task, patch, now());
    await this.upsert('maintenance_task', TASK_COLS, task as unknown as Row);
    return task;
  }

  async deleteMaintenance(taskId: ID): Promise<void> {
    const t = now();
    await this.d.runAsync('UPDATE maintenance_task SET deleted_at = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ?', [t, t, taskId]);
  }

  async markMaintenanceDone(taskId: ID, entry: { done_at?: number; note?: string | null; cost?: number | null; who?: string | null } = {}): Promise<MaintenanceTask | null> {
    const task = await this.getMaintenance(taskId);
    if (!task) return null;
    const t = now();
    const doneAt = entry.done_at ?? t;
    const log: MaintenanceLog = { id: newId(), task_id: taskId, done_at: doneAt, note: entry.note ?? null, cost: entry.cost ?? null, who: entry.who ?? null, created_at: t, updated_at: t, deleted_at: null };
    await this.upsert('maintenance_log', LOG_COLS, log as unknown as Row);
    task.last_done_at = Math.max(doneAt, task.last_done_at ?? 0);
    task.next_due_manual = 0;
    task.next_due = computeNextDue(task, t);
    task.updated_at = Math.max(t, task.updated_at + 1);
    await this.upsert('maintenance_task', TASK_COLS, task as unknown as Row);
    return task;
  }

  async listMaintenanceLog(taskId: ID): Promise<MaintenanceLog[]> {
    return this.d.getAllAsync<MaintenanceLog>('SELECT * FROM maintenance_log WHERE task_id = ? AND deleted_at IS NULL ORDER BY done_at DESC', [taskId]);
  }

  async clearAll(): Promise<void> {
    const t = now();
    for (const table of ['home', 'floor', 'room', 'container', 'item', 'tag', 'item_tag', 'item_details', 'maintenance_task', 'maintenance_log']) {
      await this.d.runAsync(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL`, [t, t]);
    }
  }

  // ── Backup local ────────────────────────────────────────────
  async exportAll(): Promise<ExportBundle> {
    return {
      format: 'homehoard-export',
      version: 3,
      exported_at: now(),
      data: {
        households: await this.d.getAllAsync<Household>('SELECT * FROM household'),
        homes: await this.d.getAllAsync<Home>('SELECT * FROM home'),
        floors: await this.d.getAllAsync<Floor>('SELECT * FROM floor'),
        rooms: await this.d.getAllAsync<Room>('SELECT * FROM room'),
        containers: await this.d.getAllAsync<Container>('SELECT * FROM container'),
        items: await this.d.getAllAsync<Item>('SELECT * FROM item'),
        tags: await this.d.getAllAsync<Tag>('SELECT * FROM tag'),
        itemTags: await this.d.getAllAsync<ItemTag>('SELECT * FROM item_tag'),
        item_details: (await this.d.getAllAsync<Row>('SELECT * FROM item_details')).map((r) => detailsRow(r)!),
        maintenance_tasks: await this.d.getAllAsync<MaintenanceTask>('SELECT * FROM maintenance_task'),
        maintenance_log: await this.d.getAllAsync<MaintenanceLog>('SELECT * FROM maintenance_log'),
      },
    };
  }

  async importAll(bundle: ExportBundle): Promise<void> {
    if (bundle.format !== 'homehoard-export') throw new Error('Archivo no reconocido');
    const d = recordsFromBundle(bundle).tables as unknown as ExportBundle['data'] & { itemTags: ItemTag[] };
    await this.d.execAsync('BEGIN');
    try {
      for (const table of ['item_tag', 'item_photo', 'maintenance_log', 'maintenance_task', 'item_details', 'item', 'container', 'room', 'floor', 'home', 'tag', 'member', 'household']) {
        await this.d.execAsync(`DELETE FROM ${table}`);
      }
      for (const r of d.households) {
        await this.d.runAsync('INSERT INTO household (id, name, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?)', [r.id, r.name, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.homes) {
        await this.d.runAsync('INSERT INTO home (id, household_id, name, kind, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?)', [r.id, r.household_id, r.name, r.kind, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.floors) {
        await this.d.runAsync('INSERT INTO floor (id, home_id, name, level_index, width_cm, height_cm, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)', [r.id, r.home_id, r.name, r.level_index, r.width_cm, r.height_cm, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.rooms) {
        await this.d.runAsync('INSERT INTO room (id, floor_id, name, kind, color, shape, x_cm, y_cm, width_cm, height_cm, rotation, points_json, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [r.id, r.floor_id, r.name, r.kind, r.color, r.shape, r.x_cm, r.y_cm, r.width_cm, r.height_cm, r.rotation, r.points_json, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.containers) {
        await this.d.runAsync('INSERT INTO container (id, room_id, parent_container_id, name, kind, icon, x_cm, y_cm, width_cm, height_cm, rotation, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [r.id, r.room_id, r.parent_container_id, r.name, r.kind, r.icon, r.x_cm, r.y_cm, r.width_cm, r.height_cm, r.rotation, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.items) {
        await this.d.runAsync('INSERT INTO item (id, household_id, name, description, quantity, room_id, container_id, photo_uri, favorite, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [r.id, r.household_id, r.name, r.description, r.quantity, r.room_id, r.container_id, r.photo_uri, r.favorite ?? 0, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.tags) {
        await this.d.runAsync('INSERT INTO tag (id, household_id, name, color, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?)', [r.id, r.household_id, r.name, r.color, r.created_at, r.updated_at, r.deleted_at]);
      }
      for (const r of d.itemTags) {
        await this.d.runAsync('INSERT OR IGNORE INTO item_tag (item_id, tag_id, id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?)',
          [r.item_id, r.tag_id, r.id, r.created_at ?? null, r.updated_at, r.deleted_at]);
      }
      for (const r of d.item_details ?? []) await this.upsert('item_details', DETAIL_COLS, r as unknown as Row);
      for (const r of d.maintenance_tasks ?? []) await this.upsert('maintenance_task', TASK_COLS, r as unknown as Row);
      for (const r of d.maintenance_log ?? []) await this.upsert('maintenance_log', LOG_COLS, r as unknown as Row);
      await this.d.execAsync('COMMIT');
    } catch (e) {
      await this.d.execAsync('ROLLBACK');
      throw e;
    }
  }
}
