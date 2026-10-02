// Fuente de datos en memoria - usada en WEB (Metro resuelve index.web.ts).
// Evita expo-sqlite en el bundle web (que da problemas) y persiste en localStorage.
// Misma semantica que SqliteSource; la logica de arbol/busqueda esta testeada en Node.
// Cuando el ordenador (servidor de HomeHoard) responde, él guarda la casa: esta fuente se sincroniza con él
// (serverSync.ts) y localStorage queda como copia para trabajar sin conexión.
import { newId, now } from './ids';
import { onlyExampleItems } from './demo';
import { emptyTables, linkId, mergeInto, recordsFromBundle, TABLES, type AnyRecord, type Tables } from './records';
import { rankSearch } from './searchUtil';
import { ServerSync, type SyncEnv } from './serverSync';
import { computeNextDue } from '../features/maintenanceCore';
import { applyTaskPatch, cleanDetails, emptyDetails, newTask } from './mutations';
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

const STORAGE_KEY = 'homehoard.v1';

interface Store {
  households: Household[];
  homes: Home[];
  floors: Floor[];
  rooms: Room[];
  containers: Container[];
  items: Item[];
  tags: Tag[];
  itemTags: ItemTag[];
  item_details: ItemDetails[];
  maintenance_tasks: MaintenanceTask[];
  maintenance_log: MaintenanceLog[];
}

const emptyStore = (): Store => emptyTables() as unknown as Store;

/** Normaliza lo guardado por versiones anteriores: favoritos, vínculos de etiquetas sin id/fecha, tablas nuevas. */
export function migrateStore(raw: Partial<Store> | null | undefined): Store {
  const s = { ...emptyStore(), ...(raw ?? {}) } as Store;
  for (const t of TABLES) if (!Array.isArray((s as unknown as Tables)[t])) (s as unknown as Record<string, unknown[]>)[t] = [];
  s.items = s.items.map((i) => ({ ...i, favorite: i.favorite ?? 0 }));
  const itemTimes = new Map(s.items.map((i) => [i.id, i.updated_at ?? 0]));
  s.itemTags = s.itemTags.map((l) => ({
    ...l,
    id: linkId(l.item_id, l.tag_id),
    updated_at: l.updated_at ?? itemTimes.get(l.item_id) ?? 0,
    deleted_at: l.deleted_at ?? null,
  }));
  return s;
}

function browserEnv(): SyncEnv | null {
  if (typeof window === 'undefined' || typeof fetch !== 'function' || !window.location) return null;
  return {
    fetch: (...args) => fetch(...args),
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    now: () => Date.now(),
    location: window.location,
    isVisible: () => typeof document === 'undefined' || !document.hidden,
    onWake: (cb) => {
      if (typeof window.addEventListener === 'function') window.addEventListener('focus', cb);
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) cb(); });
      }
    },
  };
}

const alive = <T extends { deleted_at?: number | null }>(r: T): boolean => r.deleted_at == null;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'es');

export class MemorySource implements DataSource {
  private s: Store = emptyStore();
  private hydrated = false;
  private listeners = new Set<() => void>();
  /** Sincronización con el ordenador (null fuera del navegador). */
  sync: ServerSync | null = null;

  constructor(private env: SyncEnv | null = browserEnv()) {}

  async ready(): Promise<void> {
    if (this.hydrated) return;
    this.hydrate();
    this.hydrated = true;
    if (this.env) {
      this.sync = new ServerSync(
        {
          tables: () => this.s as unknown as Tables,
          apply: (remote) => this.applyRemote(remote),
          resetTo: (remote) => {
            this.s = migrateStore(remote as unknown as Store);
            this.save();
            this.emit();
          },
          hasOnlyExample: () => onlyExampleItems(this.s.items) && this.s.homes.filter(alive).length <= 1,
        },
        this.env
      );
      // Espera un poco a que el ordenador conteste para pintar ya su casa; si tarda, sigue en segundo plano.
      await Promise.race([this.sync.start(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await this.getDefaultHousehold();
  }

  /** Avisa a la interfaz de cambios que llegan del ordenador (Faustus, otra pestaña…). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private applyRemote(remote: Partial<Tables>): number {
    const changed = mergeInto(this.s as unknown as Tables, remote as Record<string, unknown[]>);
    if (changed) {
      this.s = migrateStore(this.s);
      this.save();
      this.emit();
    }
    return changed;
  }

  private hydrate(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) this.s = migrateStore(JSON.parse(raw));
      }
    } catch {
      // ignora almacenamiento corrupto / no disponible
    }
  }

  private save(): void {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.s));
    } catch {
      // ignora cuota / no disponible: el ordenador conserva la casa cuando hay conexión
    }
  }

  private persist(): void {
    this.save();
    this.sync?.schedulePush();
  }

  async isEmpty(): Promise<boolean> {
    return this.s.homes.filter(alive).length === 0;
  }

  async getDefaultHousehold(): Promise<Household> {
    let hh = this.s.households.find(alive);
    if (!hh) {
      const t = now();
      hh = { id: newId(), name: 'Mi casa', created_at: t, updated_at: t, deleted_at: null };
      this.s.households.push(hh);
      this.persist();
    }
    return hh;
  }

  // Jerarquia espacial
  async listHomes(): Promise<Home[]> {
    return this.s.homes.filter(alive).sort(byName);
  }

  async listFloors(homeId: ID): Promise<Floor[]> {
    return this.s.floors
      .filter((f) => alive(f) && f.home_id === homeId)
      .sort((a, b) => a.level_index - b.level_index);
  }

  async getFloor(floorId: ID): Promise<Floor | null> {
    return this.s.floors.find((f) => f.id === floorId && alive(f)) ?? null;
  }

  async getFloorPlan(floorId: ID): Promise<FloorPlan> {
    const floor = await this.getFloor(floorId);
    if (!floor) throw new Error(`Floor no encontrado: ${floorId}`);
    const rooms = this.s.rooms.filter((r) => alive(r) && r.floor_id === floorId).sort(byName);
    const roomIds = new Set(rooms.map((r) => r.id));
    const rootContainers = this.s.containers.filter(
      (c) => alive(c) && c.parent_container_id == null && roomIds.has(c.room_id) && c.x_cm != null
    );
    return { floor, rooms, rootContainers };
  }

  async getRoom(roomId: ID): Promise<Room | null> {
    return this.s.rooms.find((r) => r.id === roomId && alive(r)) ?? null;
  }

  async listAllRooms(): Promise<RoomChoice[]> {
    const homes = await this.listHomes();
    const out: RoomChoice[] = [];
    for (const h of homes) {
      const floors = await this.listFloors(h.id);
      for (const f of floors) {
        const rooms = this.s.rooms.filter((r) => alive(r) && r.floor_id === f.id).sort(byName);
        const prefix = `${homes.length > 1 ? h.name + ' · ' : ''}${floors.length > 1 ? f.name + ' · ' : ''}`;
        for (const r of rooms) out.push({ room: r, label: prefix + r.name });
      }
    }
    return out;
  }

  // Contenedores
  async listRootContainers(roomId: ID): Promise<Container[]> {
    return this.s.containers
      .filter((c) => alive(c) && c.room_id === roomId && c.parent_container_id == null)
      .sort(byName);
  }

  async listChildContainers(containerId: ID): Promise<Container[]> {
    return this.s.containers
      .filter((c) => alive(c) && c.parent_container_id === containerId)
      .sort(byName);
  }

  async getContainer(containerId: ID): Promise<Container | null> {
    return this.s.containers.find((c) => c.id === containerId && alive(c)) ?? null;
  }

  private subtreeContainerIds(containerId: ID): Set<ID> {
    const ids = new Set<ID>([containerId]);
    const queue: ID[] = [containerId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const c of this.s.containers) {
        if (alive(c) && c.parent_container_id === cur && !ids.has(c.id)) {
          ids.add(c.id);
          queue.push(c.id);
        }
      }
    }
    return ids;
  }

  // Objetos
  async getItem(itemId: ID): Promise<Item | null> {
    return this.s.items.find((i) => i.id === itemId && alive(i)) ?? null;
  }

  async getItemWithLocation(itemId: ID): Promise<ItemWithLocation | null> {
    const item = await this.getItem(itemId);
    if (!item) return null;
    return this.decorate(item);
  }

  private decorate(item: Item): ItemWithLocation {
    const room = this.s.rooms.find((r) => r.id === item.room_id);
    const container = item.container_id
      ? this.s.containers.find((c) => c.id === item.container_id)
      : null;
    const tagIds = this.s.itemTags.filter((it) => alive(it) && it.item_id === item.id).map((it) => it.tag_id);
    const tags = this.s.tags.filter((t) => alive(t) && tagIds.includes(t.id)).sort(byName);
    return {
      ...item,
      roomName: room?.name ?? '-',
      containerName: container?.name ?? null,
      tags,
    };
  }

  async getItemPath(itemId: ID): Promise<PathSegment[]> {
    const item = await this.getItem(itemId);
    if (!item) return [];
    const room = this.s.rooms.find((r) => r.id === item.room_id);
    const segments: PathSegment[] = [];
    if (room) {
      const floor = this.s.floors.find((f) => f.id === room.floor_id);
      const home = floor ? this.s.homes.find((h) => h.id === floor.home_id) : undefined;
      if (home) segments.push({ kind: 'home', id: home.id, name: home.name });
      if (floor) segments.push({ kind: 'floor', id: floor.id, name: floor.name });
      segments.push({ kind: 'room', id: room.id, name: room.name });
    }
    // Cadena de contenedores desde la raiz hasta el contenedor del objeto
    const chain: Container[] = [];
    let cid = item.container_id;
    const guard = new Set<ID>();
    while (cid && !guard.has(cid)) {
      guard.add(cid);
      const c = this.s.containers.find((x) => x.id === cid);
      if (!c) break;
      chain.unshift(c);
      cid = c.parent_container_id;
    }
    for (const c of chain) segments.push({ kind: 'container', id: c.id, name: c.name });
    return segments;
  }

  async listLooseItemsInRoom(roomId: ID): Promise<Item[]> {
    return this.s.items
      .filter((i) => alive(i) && i.room_id === roomId && i.container_id == null)
      .sort(byName);
  }

  async listItemsInContainer(containerId: ID): Promise<Item[]> {
    return this.s.items
      .filter((i) => alive(i) && i.container_id === containerId)
      .sort(byName);
  }

  async listItemsInContainerDeep(containerId: ID): Promise<Item[]> {
    const ids = this.subtreeContainerIds(containerId);
    return this.s.items
      .filter((i) => alive(i) && i.container_id != null && ids.has(i.container_id))
      .sort(byName);
  }

  async countItemsInRoom(roomId: ID): Promise<number> {
    return this.s.items.filter((i) => alive(i) && i.room_id === roomId).length;
  }

  async listFavoriteItems(): Promise<ItemWithLocation[]> {
    return this.s.items
      .filter((i) => alive(i) && i.favorite === 1)
      .sort(byName)
      .map((i) => this.decorate(i));
  }

  async listRecentItems(limit: number): Promise<ItemWithLocation[]> {
    return [...this.s.items]
      .filter(alive)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit)
      .map((i) => this.decorate(i));
  }

  // Busqueda (normalizada + relevancia, en searchUtil)
  async searchItems(query: string, tagIds?: ID[]): Promise<ItemWithLocation[]> {
    const wantTags = tagIds && tagIds.length ? new Set(tagIds) : null;
    const candidates = this.s.items.filter(alive).filter((item) => {
      if (!wantTags) return true;
      const itemTagIds = this.s.itemTags.filter((it) => alive(it) && it.item_id === item.id).map((it) => it.tag_id);
      return itemTagIds.some((id) => wantTags.has(id));
    });
    return rankSearch(candidates.map((i) => this.decorate(i)), query);
  }

  // Tags
  async listTags(): Promise<Tag[]> {
    return this.s.tags.filter(alive).sort(byName);
  }

  async createTag(name: string, color: string | null = null): Promise<Tag> {
    const existing = this.s.tags.find((t) => alive(t) && t.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const hh = await this.getDefaultHousehold();
    const t = now();
    const tag: Tag = { id: newId(), household_id: hh.id, name, color, created_at: t, updated_at: t, deleted_at: null };
    this.s.tags.push(tag);
    this.persist();
    return tag;
  }

  async updateTag(tagId: ID, patch: { name?: string; color?: string | null }): Promise<void> {
    const tag = this.s.tags.find((t) => t.id === tagId);
    if (!tag) return;
    if (patch.name !== undefined) tag.name = patch.name;
    if (patch.color !== undefined) tag.color = patch.color;
    tag.updated_at = now();
    this.persist();
  }

  async deleteTag(tagId: ID): Promise<void> {
    const tag = this.s.tags.find((t) => t.id === tagId);
    if (!tag) return;
    const t0 = now();
    for (const link of this.s.itemTags) {
      if (link.tag_id === tagId && alive(link)) {
        link.deleted_at = t0;
        link.updated_at = t0;
      }
    }
    tag.deleted_at = t0;
    tag.updated_at = tag.deleted_at;
    this.persist();
  }

  async getItemTags(itemId: ID): Promise<Tag[]> {
    const ids = this.s.itemTags.filter((it) => alive(it) && it.item_id === itemId).map((it) => it.tag_id);
    return this.s.tags.filter((t) => alive(t) && ids.includes(t.id)).sort(byName);
  }

  /** Vínculos con lápida: quitar una etiqueta también viaja al ordenador. */
  private setItemTags(itemId: ID, tagIds: ID[]): void {
    const t = now();
    const wanted = new Set(tagIds);
    for (const link of this.s.itemTags) {
      if (link.item_id !== itemId) continue;
      if (wanted.has(link.tag_id)) {
        if (!alive(link)) {
          link.deleted_at = null;
          link.updated_at = t;
        }
        wanted.delete(link.tag_id);
      } else if (alive(link)) {
        link.deleted_at = t;
        link.updated_at = t;
      }
    }
    for (const tagId of wanted) this.s.itemTags.push({ id: linkId(itemId, tagId), item_id: itemId, tag_id: tagId, created_at: t, updated_at: t, deleted_at: null });
  }

  // Mutaciones de objetos
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
    this.s.items.push(item);
    if (input.tagIds?.length) this.setItemTags(item.id, input.tagIds);
    this.persist();
    return item;
  }

  async updateItem(id: ID, patch: UpdateItemInput): Promise<void> {
    const item = this.s.items.find((i) => i.id === id);
    if (!item) return;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.description !== undefined) item.description = patch.description;
    if (patch.quantity !== undefined) item.quantity = patch.quantity;
    if (patch.room_id !== undefined) item.room_id = patch.room_id;
    if (patch.container_id !== undefined) item.container_id = patch.container_id;
    if (patch.photo_uri !== undefined) item.photo_uri = patch.photo_uri;
    if (patch.favorite !== undefined) item.favorite = patch.favorite ? 1 : 0;
    item.updated_at = now();
    if (patch.tagIds !== undefined) this.setItemTags(id, patch.tagIds);
    this.persist();
  }

  async setItemFavorite(id: ID, favorite: boolean): Promise<void> {
    const item = this.s.items.find((i) => i.id === id);
    if (!item) return;
    item.favorite = favorite ? 1 : 0;
    item.updated_at = now();
    this.persist();
  }

  async deleteItem(id: ID): Promise<void> {
    const item = this.s.items.find((i) => i.id === id);
    if (!item) return;
    item.deleted_at = now();
    item.updated_at = item.deleted_at;
    this.persist();
  }

  async restoreItem(id: ID): Promise<void> {
    const item = this.s.items.find((i) => i.id === id);
    if (!item) return;
    item.deleted_at = null;
    item.updated_at = now();
    this.persist();
  }

  // Mutaciones de estructura
  async addHome(name: string, kind = 'house'): Promise<Home> {
    const hh = await this.getDefaultHousehold();
    const t = now();
    const home: Home = { id: newId(), household_id: hh.id, name, kind, created_at: t, updated_at: t, deleted_at: null };
    this.s.homes.push(home);
    this.persist();
    return home;
  }

  async addFloor(homeId: ID, name: string, widthCm = 1000, heightCm = 1000): Promise<Floor> {
    const t = now();
    const levels = this.s.floors.filter((f) => f.home_id === homeId).length;
    const floor: Floor = {
      id: newId(),
      home_id: homeId,
      name,
      level_index: levels,
      width_cm: widthCm,
      height_cm: heightCm,
      created_at: t,
      updated_at: t,
      deleted_at: null,
    };
    this.s.floors.push(floor);
    this.persist();
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
    this.s.rooms.push(room);
    this.persist();
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
    this.s.containers.push(container);
    this.persist();
    return container;
  }

  async updateRoomGeometry(roomId: ID, rect: Rect): Promise<void> {
    const room = this.s.rooms.find((r) => r.id === roomId);
    if (!room) return;
    room.x_cm = rect.x_cm;
    room.y_cm = rect.y_cm;
    room.width_cm = rect.width_cm;
    room.height_cm = rect.height_cm;
    if (rect.rotation !== undefined) room.rotation = rect.rotation;
    room.updated_at = now();
    this.persist();
  }

  async updateContainerGeometry(containerId: ID, rect: Rect): Promise<void> {
    const c = this.s.containers.find((x) => x.id === containerId);
    if (!c) return;
    c.x_cm = rect.x_cm;
    c.y_cm = rect.y_cm;
    c.width_cm = rect.width_cm;
    c.height_cm = rect.height_cm;
    if (rect.rotation !== undefined) c.rotation = rect.rotation;
    c.updated_at = now();
    this.persist();
  }

  async renameRoom(roomId: ID, name: string): Promise<void> {
    const r = this.s.rooms.find((x) => x.id === roomId);
    if (!r) return;
    r.name = name;
    r.updated_at = now();
    this.persist();
  }

  async renameContainer(containerId: ID, name: string): Promise<void> {
    const c = this.s.containers.find((x) => x.id === containerId);
    if (!c) return;
    c.name = name;
    c.updated_at = now();
    this.persist();
  }

  async updateRoomMeta(roomId: ID, patch: { name?: string; kind?: string | null; color?: string | null }): Promise<void> {
    const r = this.s.rooms.find((x) => x.id === roomId);
    if (!r) return;
    if (patch.name !== undefined) r.name = patch.name;
    if (patch.kind !== undefined) r.kind = patch.kind;
    if (patch.color !== undefined) r.color = patch.color;
    r.updated_at = now();
    this.persist();
  }

  async updateContainerMeta(containerId: ID, patch: { name?: string; kind?: string | null; icon?: string | null }): Promise<void> {
    const c = this.s.containers.find((x) => x.id === containerId);
    if (!c) return;
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.kind !== undefined) c.kind = patch.kind;
    if (patch.icon !== undefined) c.icon = patch.icon;
    c.updated_at = now();
    this.persist();
  }

  async deleteContainer(containerId: ID): Promise<void> {
    const t = now();
    const ids = this.subtreeContainerIds(containerId);
    // Los objetos del subárbol pasan a "sueltos" en su habitación (no se pierden).
    for (const i of this.s.items) {
      if (alive(i) && i.container_id != null && ids.has(i.container_id)) {
        i.container_id = null;
        i.updated_at = t;
      }
    }
    for (const c of this.s.containers) {
      if (ids.has(c.id)) {
        c.deleted_at = t;
        c.updated_at = t;
      }
    }
    this.persist();
  }

  async deleteRoom(roomId: ID): Promise<boolean> {
    const hasItems = this.s.items.some((i) => alive(i) && i.room_id === roomId);
    const hasContainers = this.s.containers.some((c) => alive(c) && c.room_id === roomId);
    if (hasItems || hasContainers) return false;
    const r = this.s.rooms.find((x) => x.id === roomId);
    if (!r) return false;
    r.deleted_at = now();
    r.updated_at = r.deleted_at;
    this.persist();
    return true;
  }

  // Stats
  async countItemsByRoom(floorId: ID): Promise<RoomItemCount[]> {
    const rooms = this.s.rooms.filter((r) => alive(r) && r.floor_id === floorId);
    return rooms
      .map((room) => ({
        room,
        count: this.s.items.filter((i) => alive(i) && i.room_id === room.id).length,
      }))
      .sort((a, b) => b.count - a.count);
  }

  async getStats(): Promise<Stats> {
    const items = this.s.items.filter(alive);
    return {
      homes: this.s.homes.filter(alive).length,
      floors: this.s.floors.filter(alive).length,
      rooms: this.s.rooms.filter(alive).length,
      containers: this.s.containers.filter(alive).length,
      items: items.length,
      totalQuantity: items.reduce((acc, i) => acc + (i.quantity || 0), 0),
      photos: items.filter((i) => i.photo_uri != null).length,
      tags: this.s.tags.filter(alive).length,
      favorites: items.filter((i) => i.favorite === 1).length,
    };
  }

  // Ficha del objeto
  async getItemDetails(itemId: ID): Promise<ItemDetails | null> {
    return this.s.item_details.find((d) => d.id === itemId && alive(d)) ?? null;
  }

  async saveItemDetails(itemId: ID, patch: ItemDetailsInput): Promise<ItemDetails> {
    const t = now();
    let row = this.s.item_details.find((d) => d.id === itemId);
    if (!row) {
      row = { ...emptyDetails(itemId), created_at: t, updated_at: t };
      this.s.item_details.push(row);
    }
    Object.assign(row, cleanDetails(patch), { deleted_at: null, updated_at: Math.max(t, row.updated_at + 1) });
    if (patch.warranty_until !== undefined && patch.warranty_source === undefined) row.warranty_source = row.warranty_until ? 'manual' : null;
    this.persist();
    return { ...row };
  }

  // Mantenimiento
  private targetOf(kind: MaintenanceTarget, id: ID): { name: string | null; path: string | null } {
    const room = (rid: ID | null | undefined) => this.s.rooms.find((r) => r.id === rid && alive(r));
    if (kind === 'item') {
      const item = this.s.items.find((i) => i.id === id && alive(i));
      if (!item) return { name: null, path: null };
      const chain: string[] = [];
      let cid = item.container_id;
      const guard = new Set<ID>();
      while (cid && !guard.has(cid)) {
        guard.add(cid);
        const c = this.s.containers.find((x) => x.id === cid);
        if (!c) break;
        chain.unshift(c.name);
        cid = c.parent_container_id;
      }
      return { name: item.name, path: [room(item.room_id)?.name, ...chain].filter(Boolean).join(' › ') };
    }
    if (kind === 'container') {
      const c = this.s.containers.find((x) => x.id === id && alive(x));
      return { name: c?.name ?? null, path: c ? [room(c.room_id)?.name, c.name].filter(Boolean).join(' › ') : null };
    }
    if (kind === 'room') {
      const r = room(id);
      return { name: r?.name ?? null, path: r?.name ?? null };
    }
    const h = this.s.homes.find((x) => x.id === id && alive(x));
    return { name: h?.name ?? null, path: h?.name ?? null };
  }

  async listMaintenance(filter?: { target_kind?: MaintenanceTarget; target_id?: ID }): Promise<MaintenanceWithTarget[]> {
    return this.s.maintenance_tasks
      .filter((m) => alive(m) && (!filter?.target_kind || m.target_kind === filter.target_kind) && (!filter?.target_id || m.target_id === filter.target_id))
      .map((m) => ({ ...m, ...(({ name, path }) => ({ targetName: name, targetPath: path }))(this.targetOf(m.target_kind, m.target_id)) }))
      .sort((a, b) => (a.next_due ?? '9999').localeCompare(b.next_due ?? '9999') || a.title.localeCompare(b.title, 'es'));
  }

  async getMaintenance(taskId: ID): Promise<MaintenanceTask | null> {
    return this.s.maintenance_tasks.find((m) => m.id === taskId && alive(m)) ?? null;
  }

  async addMaintenance(input: NewMaintenanceInput): Promise<MaintenanceTask> {
    const t = now();
    const task: MaintenanceTask = newTask(input, t);
    this.s.maintenance_tasks.push(task);
    this.persist();
    return { ...task };
  }

  async updateMaintenance(taskId: ID, patch: UpdateMaintenanceInput): Promise<MaintenanceTask | null> {
    const task = this.s.maintenance_tasks.find((m) => m.id === taskId);
    if (!task) return null;
    applyTaskPatch(task, patch, now());
    this.persist();
    return { ...task };
  }

  async deleteMaintenance(taskId: ID): Promise<void> {
    const task = this.s.maintenance_tasks.find((m) => m.id === taskId);
    if (!task) return;
    task.deleted_at = now();
    task.updated_at = Math.max(task.deleted_at, task.updated_at + 1);
    this.persist();
  }

  async markMaintenanceDone(taskId: ID, entry: { done_at?: number; note?: string | null; cost?: number | null; who?: string | null } = {}): Promise<MaintenanceTask | null> {
    const task = this.s.maintenance_tasks.find((m) => m.id === taskId && alive(m));
    if (!task) return null;
    const t = now();
    const doneAt = entry.done_at ?? t;
    this.s.maintenance_log.push({ id: newId(), task_id: taskId, done_at: doneAt, note: entry.note ?? null, cost: entry.cost ?? null, who: entry.who ?? null, created_at: t, updated_at: t, deleted_at: null });
    task.last_done_at = Math.max(doneAt, task.last_done_at ?? 0);
    task.next_due_manual = 0;
    task.next_due = computeNextDue(task, t);
    task.updated_at = Math.max(t, task.updated_at + 1);
    this.persist();
    return { ...task };
  }

  async listMaintenanceLog(taskId: ID): Promise<MaintenanceLog[]> {
    return this.s.maintenance_log.filter((l) => l.task_id === taskId && alive(l)).sort((a, b) => b.done_at - a.done_at);
  }

  // Backup local
  async exportAll(): Promise<ExportBundle> {
    return {
      format: 'homehoard-export',
      version: 3,
      exported_at: now(),
      data: {
        households: [...this.s.households],
        homes: [...this.s.homes],
        floors: [...this.s.floors],
        rooms: [...this.s.rooms],
        containers: [...this.s.containers],
        items: [...this.s.items],
        tags: [...this.s.tags],
        itemTags: [...this.s.itemTags],
        item_details: [...this.s.item_details],
        maintenance_tasks: [...this.s.maintenance_tasks],
        maintenance_log: [...this.s.maintenance_log],
      },
    };
  }

  async importAll(bundle: ExportBundle): Promise<void> {
    if (bundle.format !== 'homehoard-export') throw new Error('Archivo no reconocido');
    const { tables } = recordsFromBundle(bundle);
    if (this.sync?.active) {
      // Con el ordenador, una copia se combina (gana el cambio más reciente) en lugar de sustituir la casa.
      mergeInto(this.s as unknown as Tables, tables as unknown as Record<string, unknown[]>);
      this.s = migrateStore(this.s);
      this.persist();
      return;
    }
    const next = migrateStore(tables as unknown as Store);
    // Do not report a restored backup when the browser cannot keep it.
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        throw new Error('La copia supera el espacio disponible del navegador; no se ha restaurado');
      }
    }
    this.s = next;
    this.sync?.schedulePush();
  }

  /** Vacía la casa (casa de ejemplo): con lápidas, para que también se borre en el ordenador. */
  async clearAll(): Promise<void> {
    const t = now();
    for (const table of ['homes', 'floors', 'rooms', 'containers', 'items', 'tags', 'itemTags', 'item_details', 'maintenance_tasks', 'maintenance_log'] as const) {
      for (const row of this.s[table] as unknown as AnyRecord[]) {
        if (row.deleted_at == null) {
          row.deleted_at = t;
          row.updated_at = Math.max(t, Number(row.updated_at) + 1);
        }
      }
    }
    this.persist();
  }
}
