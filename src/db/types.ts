// Modelo de dominio de HomeHoard. Compartido por la fuente SQLite (nativo) y la
// fuente en memoria (web). Ver HomeHoard_Spec-Tecnico_ModeloDatos-Plano2D-UI.md §4.

export type ID = string;
export type Millis = number; // epoch en milisegundos

export type RoomShape = 'rect' | 'polygon';
export type MemberRole = 'owner' | 'editor' | 'viewer';

export interface Household {
  id: ID;
  name: string;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface Home {
  id: ID;
  household_id: ID;
  name: string;
  kind: string; // house | flat | storage | office
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface Floor {
  id: ID;
  home_id: ID;
  name: string;
  level_index: number;
  width_cm: number;
  height_cm: number;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface Room {
  id: ID;
  floor_id: ID;
  name: string;
  kind: string | null;
  color: string | null;
  shape: RoomShape;
  x_cm: number;
  y_cm: number;
  width_cm: number;
  height_cm: number;
  rotation: number;
  points_json: string | null;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface Container {
  id: ID;
  room_id: ID;
  parent_container_id: ID | null; // null = mueble raiz colocado en el plano de la habitacion
  name: string;
  kind: string | null; // wardrobe | dresser | shelf | cabinet | box | drawer | fridge...
  icon: string | null;
  x_cm: number | null; // coords relativas a la habitacion (solo muebles raiz)
  y_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  rotation: number;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface Item {
  id: ID;
  household_id: ID;
  name: string;
  description: string | null;
  quantity: number;
  room_id: ID; // SIEMPRE presente (desnormalizado)
  container_id: ID | null; // null = suelto en la habitacion
  photo_uri: string | null;
  favorite: number; // 0 | 1 (INTEGER en SQLite)
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface Tag {
  id: ID;
  household_id: ID;
  name: string;
  color: string | null;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

// Vínculo objeto–etiqueta. Su id es determinista (`<item_id>:<tag_id>`) para que el mismo vínculo hecho en dos
// dispositivos sea un único registro; al quitar una etiqueta queda una lápida (deleted_at) que también se sincroniza.
export interface ItemTag {
  id: string;
  item_id: ID;
  tag_id: ID;
  created_at?: Millis | null;
  updated_at: Millis;
  deleted_at: Millis | null;
}

// Ficha de aparato u objeto (una por objeto; su id es el del objeto).
export interface Consumable {
  name: string; // "Filtro de la campana"
  spec: string | null; // "3x", "CR2032 ×2"
  qty: number | null;
  last_bought: string | null; // YYYY-MM-DD
}

export interface ItemDetails {
  id: ID; // = item_id
  item_id: ID;
  brand: string | null;
  model: string | null;
  serial: string | null;
  purchase_date: string | null; // YYYY-MM-DD
  store: string | null;
  price: number | null;
  warranty_until: string | null; // YYYY-MM-DD
  warranty_source: 'manual' | 'kafka' | null;
  kafka_doc_ids: string[]; // documentos de Kafka's Hoard (factura, garantía, manual…)
  manual_url: string | null;
  consumables: Consumable[];
  notes: string | null;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export type ItemDetailsInput = Partial<Omit<ItemDetails, 'id' | 'item_id' | 'created_at' | 'updated_at' | 'deleted_at'>>;

// Mantenimiento
export type MaintenanceTarget = 'item' | 'container' | 'room' | 'home';
export type MaintenanceBasis = 'law' | 'maker' | 'advice';

export interface MaintenanceTask {
  id: ID;
  target_kind: MaintenanceTarget;
  target_id: ID;
  title: string;
  every_days: number | null;
  every_months: number | null;
  anchor_month: number | null; // 1–12: mes en el que debe caer (p. ej. 10 = octubre)
  last_done_at: Millis | null;
  next_due: string | null; // YYYY-MM-DD (calculada salvo next_due_manual)
  next_due_manual: number; // 0 | 1
  notes: string | null;
  basis: MaintenanceBasis;
  legal_ref: string | null;
  template_id: string | null;
  kafka_deadline_id: string | null; // lo rellena el ordenador al reflejar la tarea en Kafka
  paused: number; // 0 | 1
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface MaintenanceLog {
  id: ID;
  task_id: ID;
  done_at: Millis;
  note: string | null;
  cost: number | null;
  who: string | null;
  created_at: Millis;
  updated_at: Millis;
  deleted_at: Millis | null;
}

export interface NewMaintenanceInput {
  target_kind: MaintenanceTarget;
  target_id: ID;
  title: string;
  every_days?: number | null;
  every_months?: number | null;
  anchor_month?: number | null;
  last_done_at?: Millis | null;
  next_due?: string | null; // fijada a mano
  notes?: string | null;
  basis?: MaintenanceBasis;
  legal_ref?: string | null;
  template_id?: string | null;
}

export type UpdateMaintenanceInput = Partial<Omit<NewMaintenanceInput, 'target_kind' | 'target_id'>> & {
  paused?: boolean;
  next_due?: string | null; // null = volver a la fecha calculada
};

export interface MaintenanceWithTarget extends MaintenanceTask {
  targetName: string | null;
  targetPath: string | null;
}

// Tipos derivados / de vista
export type PathKind = 'home' | 'floor' | 'room' | 'container';

export interface PathSegment {
  kind: PathKind;
  id: ID;
  name: string;
}

export interface ItemWithLocation extends Item {
  roomName: string;
  containerName: string | null;
  tags: Tag[];
}

export interface FloorPlan {
  floor: Floor;
  rooms: Room[];
  rootContainers: Container[]; // muebles raiz de todas las habitaciones de la planta
}

export interface RoomItemCount {
  room: Room;
  count: number;
}

export interface RoomChoice {
  room: Room;
  label: string; // "Casa · Planta · Habitación" (prefijos solo si hay varios)
}

export interface Stats {
  homes: number;
  floors: number;
  rooms: number;
  containers: number;
  items: number; // filas vivas
  totalQuantity: number; // suma de cantidades
  photos: number;
  tags: number;
  favorites: number;
}

// Backup local. La version 2 incluye las fotos dentro del JSON portable; la 3 añade fichas, mantenimiento y
// vínculos de etiquetas con id, fecha y lápida. Las versiones 1 y 2 siguen pudiéndose importar.
export interface ExportBundle {
  format: 'homehoard-export';
  version: 1 | 2 | 3;
  exported_at: Millis;
  photos?: Record<ID, string>; // item id -> data:image/...;base64,...
  data: {
    households: Household[];
    homes: Home[];
    floors: Floor[];
    rooms: Room[];
    containers: Container[];
    items: Item[];
    tags: Tag[];
    itemTags: (ItemTag | { item_id: ID; tag_id: ID })[];
    item_details?: ItemDetails[];
    maintenance_tasks?: MaintenanceTask[];
    maintenance_log?: MaintenanceLog[];
  };
}

// Entradas de mutacion
export interface NewItemInput {
  name: string;
  description?: string | null;
  quantity?: number;
  room_id: ID;
  container_id?: ID | null;
  photo_uri?: string | null;
  favorite?: boolean;
  tagIds?: ID[];
}

export interface UpdateItemInput {
  name?: string;
  description?: string | null;
  quantity?: number;
  room_id?: ID;
  container_id?: ID | null;
  photo_uri?: string | null;
  favorite?: boolean;
  tagIds?: ID[];
}

export interface Rect {
  x_cm: number;
  y_cm: number;
  width_cm: number;
  height_cm: number;
  rotation?: number;
}

// Contrato de la fuente de datos. Operaciones de dominio de alto nivel; la UI nunca ve SQL.
export interface DataSource {
  ready(): Promise<void>;
  isEmpty(): Promise<boolean>;

  getDefaultHousehold(): Promise<Household>;

  // Jerarquia espacial
  listHomes(): Promise<Home[]>;
  listFloors(homeId: ID): Promise<Floor[]>;
  getFloor(floorId: ID): Promise<Floor | null>;
  getFloorPlan(floorId: ID): Promise<FloorPlan>;
  getRoom(roomId: ID): Promise<Room | null>;
  listAllRooms(): Promise<RoomChoice[]>; // todas las habitaciones con etiqueta legible

  // Contenedores
  listRootContainers(roomId: ID): Promise<Container[]>;
  listChildContainers(containerId: ID): Promise<Container[]>;
  getContainer(containerId: ID): Promise<Container | null>;

  // Objetos
  getItem(itemId: ID): Promise<Item | null>;
  getItemWithLocation(itemId: ID): Promise<ItemWithLocation | null>;
  getItemPath(itemId: ID): Promise<PathSegment[]>;
  listLooseItemsInRoom(roomId: ID): Promise<Item[]>; // container_id NULL
  listItemsInContainer(containerId: ID): Promise<Item[]>; // directos
  listItemsInContainerDeep(containerId: ID): Promise<Item[]>; // incl. sub-contenedores
  countItemsInRoom(roomId: ID): Promise<number>;
  listFavoriteItems(): Promise<ItemWithLocation[]>;
  listRecentItems(limit: number): Promise<ItemWithLocation[]>;

  // Busqueda (normalizada, sin acentos, ordenada por relevancia)
  searchItems(query: string, tagIds?: ID[]): Promise<ItemWithLocation[]>;

  // Tags
  listTags(): Promise<Tag[]>;
  createTag(name: string, color?: string | null): Promise<Tag>;
  updateTag(tagId: ID, patch: { name?: string; color?: string | null }): Promise<void>;
  deleteTag(tagId: ID): Promise<void>;
  getItemTags(itemId: ID): Promise<Tag[]>;

  // Mutaciones de objetos
  addItem(input: NewItemInput): Promise<Item>;
  updateItem(id: ID, patch: UpdateItemInput): Promise<void>;
  setItemFavorite(id: ID, favorite: boolean): Promise<void>;
  deleteItem(id: ID): Promise<void>;
  restoreItem(id: ID): Promise<void>; // deshace un borrado (tombstone)

  // Mutaciones de estructura
  addHome(name: string, kind?: string): Promise<Home>;
  addFloor(homeId: ID, name: string, widthCm?: number, heightCm?: number): Promise<Floor>;
  addRoom(floorId: ID, name: string, rect: Rect, opts?: { kind?: string; color?: string }): Promise<Room>;
  addContainer(
    roomId: ID,
    name: string,
    opts?: { kind?: string; parentContainerId?: ID | null; rect?: Rect | null; icon?: string }
  ): Promise<Container>;
  updateRoomGeometry(roomId: ID, rect: Rect): Promise<void>;
  updateContainerGeometry(containerId: ID, rect: Rect): Promise<void>;
  renameRoom(roomId: ID, name: string): Promise<void>;
  renameContainer(containerId: ID, name: string): Promise<void>;
  updateRoomMeta(roomId: ID, patch: { name?: string; kind?: string | null; color?: string | null }): Promise<void>;
  updateContainerMeta(containerId: ID, patch: { name?: string; kind?: string | null; icon?: string | null }): Promise<void>;
  /** Borra un mueble: sus objetos pasan a "sueltos" en la habitación y los sub-contenedores se borran. */
  deleteContainer(containerId: ID): Promise<void>;
  /** Borra una habitación solo si está vacía. Devuelve false si tiene contenido. */
  deleteRoom(roomId: ID): Promise<boolean>;

  // Stats
  countItemsByRoom(floorId: ID): Promise<RoomItemCount[]>;
  getStats(): Promise<Stats>;

  // Ficha del objeto
  getItemDetails(itemId: ID): Promise<ItemDetails | null>;
  saveItemDetails(itemId: ID, patch: ItemDetailsInput): Promise<ItemDetails>;

  // Mantenimiento
  listMaintenance(filter?: { target_kind?: MaintenanceTarget; target_id?: ID }): Promise<MaintenanceWithTarget[]>;
  getMaintenance(taskId: ID): Promise<MaintenanceTask | null>;
  addMaintenance(input: NewMaintenanceInput): Promise<MaintenanceTask>;
  updateMaintenance(taskId: ID, patch: UpdateMaintenanceInput): Promise<MaintenanceTask | null>;
  deleteMaintenance(taskId: ID): Promise<void>;
  markMaintenanceDone(taskId: ID, entry?: { done_at?: Millis; note?: string | null; cost?: number | null; who?: string | null }): Promise<MaintenanceTask | null>;
  listMaintenanceLog(taskId: ID): Promise<MaintenanceLog[]>;

  // Backup local
  exportAll(): Promise<ExportBundle>;
  importAll(bundle: ExportBundle): Promise<void>;
  /** Vacía la casa con lápidas (para empezar de cero sin dejar registros vivos en otros dispositivos). */
  clearAll(): Promise<void>;
}
