// Sincronización de la web con el ordenador (el servidor de HomeHoard en 127.0.0.1:5196).
// El ordenador guarda la casa; el navegador mantiene una copia en localStorage para poder trabajar sin conexión.
// - Al arrancar descarga /api/home y lo combina con lo local (gana el cambio más reciente de cada registro).
// - Cada cambio local se envía a /api/home/sync al poco (agrupado), con reintentos si el ordenador no responde.
// - Mientras la página está visible pregunta /api/home/version cada pocos segundos para ver los cambios de Faustus.
// Sin dependencias de React ni de Expo: se prueba en Node con fetch y almacenamiento simulados.
import { mergeInto, recordKey, TABLES, type AnyRecord, type TableName, type Tables } from './records';

export const SERVER_URL = 'http://127.0.0.1:5196';
const META_KEY = 'homehoard.sync.v1';
const RETRY_MS = [2000, 5000, 15000, 30000];

export type SyncMode = 'off' | 'connecting' | 'online' | 'offline' | 'demo';

export interface SyncStatus {
  mode: SyncMode;
  base: string | null; // '' = misma página que el servidor
  version: number | null;
  lastSync: number | null;
  pending: number; // registros locales aún no guardados en el ordenador
  error: string | null;
}

export interface SyncHost {
  tables(): Tables; // referencia viva al almacén local
  apply(remote: Partial<Tables>): number; // combina (LWW) y persiste; devuelve cuántos registros cambiaron
  resetTo(remote: Tables): void; // sustituye todo (para descartar la casa de ejemplo)
  hasOnlyExample(): boolean;
}

export interface SyncEnv {
  fetch: typeof fetch;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now: () => number;
  location: { origin: string; hostname: string; port: string; protocol: string } | null;
  isVisible: () => boolean;
  onWake: (cb: () => void) => void; // foco / pestaña visible
  pollMs?: number;
  debounceMs?: number;
}

interface Meta {
  base: string | null;
  instance: string | null;
  version: number | null;
  stamps: Record<string, number>; // tabla/id -> updated_at que tiene el ordenador
}

interface ServerState {
  instance: string;
  version: number;
  tables: Partial<Record<TableName, AnyRecord[]>>;
}

let current: ServerSync | null = null;
export const getServerSync = (): ServerSync | null => current;

export class ServerSync {
  status: SyncStatus = { mode: 'off', base: null, version: null, lastSync: null, pending: 0, error: null };
  private meta: Meta;
  private listeners = new Set<(s: SyncStatus) => void>();
  private pushTimer: unknown = null;
  private retry = 0;
  private pushing: Promise<boolean> | null = null;
  private pulling = false;
  private started = false;
  private stopped = false;
  private poller: unknown = null;

  constructor(private host: SyncHost, private env: SyncEnv) {
    this.meta = this.loadMeta();
    current = this;
  }

  // ---------------------------------------------------------------- estado
  subscribe(listener: (s: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  private loadMeta(): Meta {
    try {
      const raw = this.env.storage?.getItem(META_KEY);
      if (raw) return { base: null, instance: null, version: null, stamps: {}, ...JSON.parse(raw) };
    } catch {
      // almacenamiento no disponible o corrupto
    }
    return { base: null, instance: null, version: null, stamps: {} };
  }

  private saveMeta(): void {
    try {
      this.env.storage?.setItem(META_KEY, JSON.stringify(this.meta));
    } catch {
      // sin espacio: se recalcula en la próxima sincronización
    }
  }

  get active(): boolean {
    return this.status.base !== null;
  }

  url(path: string): string {
    return `${this.status.base ?? SERVER_URL}${path}`;
  }

  /** Foto de un objeto: las rutas /photos/… del ordenador, absolutas si la web no la sirve él. */
  photoUrl(uri: string | null | undefined): string | null {
    if (!uri) return null;
    if (uri.startsWith('/photos/') && this.status.base) return this.status.base + uri;
    return uri;
  }

  // ---------------------------------------------------------------- red
  private async request(path: string, init?: RequestInit, timeoutMs = 8000): Promise<unknown> {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? this.env.setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await this.env.fetch(this.url(path), { ...init, signal: ctrl?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      if (timer !== null) this.env.clearTimeout(timer);
    }
  }

  private async probe(base: string): Promise<boolean> {
    try {
      const res = await this.env.fetch(`${base}/api/home/version`);
      if (!res.ok) return false;
      const body = (await res.json()) as { instance?: unknown };
      return typeof body?.instance === 'string';
    } catch {
      return false;
    }
  }

  /** Busca el ordenador: la propia página si la sirve él, o 127.0.0.1:5196 desde una página local. */
  async detect(): Promise<string | null> {
    const loc = this.env.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return null;
    if (await this.probe(loc.origin)) return '';
    if (['127.0.0.1', 'localhost'].includes(loc.hostname) && loc.origin !== SERVER_URL && (await this.probe(SERVER_URL))) return SERVER_URL;
    return null;
  }

  // ---------------------------------------------------------------- ciclo
  async start(): Promise<boolean> {
    if (this.started) return this.active;
    this.started = true;
    this.set({ mode: 'connecting' });
    const base = await this.detect();
    if (base === null) {
      // Si alguna vez se conectó, decirlo: la web sigue funcionando con su copia local.
      this.set({ mode: this.meta.base !== null ? 'offline' : 'off', base: this.meta.base, error: this.meta.base !== null ? 'sin conexión con el ordenador' : null });
      if (this.meta.base !== null) this.scheduleRetry();
      this.watch();
      return this.meta.base !== null;
    }
    this.meta.base = base;
    this.saveMeta();
    this.set({ base });
    await this.pull(true);
    this.watch();
    return true;
  }

  /** Detiene temporizadores y sondeo (pruebas, cierre). */
  stop(): void {
    this.stopped = true;
    if (this.pushTimer !== null) this.env.clearTimeout(this.pushTimer);
    this.pushTimer = null;
    if (this.poller !== null) this.env.clearInterval?.(this.poller);
    this.poller = null;
  }

  private watch(): void {
    this.env.onWake(() => {
      if (!this.active || this.stopped) return;
      if (this.dirty().length || this.status.mode === 'offline') this.schedulePush(50);
      else void this.pullIfChanged();
    });
    this.poller = this.env.setInterval(() => {
      if (this.active && !this.stopped && this.env.isVisible()) void this.pullIfChanged();
    }, this.env.pollMs ?? 4000);
  }

  /** Registros locales que el ordenador aún no tiene (o tiene más antiguos). */
  dirty(): { table: TableName; rec: AnyRecord }[] {
    const out: { table: TableName; rec: AnyRecord }[] = [];
    const tables = this.host.tables();
    for (const table of TABLES) {
      for (const rec of tables[table] ?? []) {
        const stamp = this.meta.stamps[recordKey(table, rec.id)];
        if (stamp === undefined || Number(rec.updated_at) > stamp) out.push({ table, rec });
      }
    }
    return out;
  }

  private absolutePhotos(tables: Partial<Record<TableName, AnyRecord[]>>): Partial<Record<TableName, AnyRecord[]>> {
    if (!this.status.base || !tables.items) return tables;
    const base = this.status.base;
    return { ...tables, items: tables.items.map((i) => (typeof i.photo_uri === 'string' && i.photo_uri.startsWith('/photos/') ? { ...i, photo_uri: base + i.photo_uri } : i)) };
  }

  private adopt(state: ServerState): void {
    if (this.meta.instance !== state.instance) {
      // Otro ordenador u otra carpeta de datos: todo lo local se envía y se combina.
      this.meta.stamps = {};
      this.meta.instance = state.instance;
    }
    const remote = this.absolutePhotos(state.tables);
    const serverItems = (state.tables.items ?? []).filter((i) => i.deleted_at == null).length;
    if (this.host.hasOnlyExample() && serverItems > 0) {
      this.host.resetTo(fill(remote));
    } else {
      this.host.apply(remote);
    }
    for (const table of TABLES) {
      for (const rec of state.tables[table] ?? []) this.meta.stamps[recordKey(table, rec.id)] = Number(rec.updated_at);
    }
    this.meta.version = state.version;
    this.saveMeta();
  }

  async pull(thenPush = false): Promise<boolean> {
    if (this.pulling) return false;
    this.pulling = true;
    try {
      const state = (await this.request('/api/home', undefined, 20000)) as ServerState;
      this.adopt(state);
      this.retry = 0;
      const pending = this.dirty().length;
      const demo = this.host.hasOnlyExample();
      this.set({ mode: demo ? 'demo' : 'online', version: state.version, lastSync: this.env.now(), pending, error: null });
      if (thenPush && pending && !demo) this.schedulePush(50);
      return true;
    } catch (e) {
      this.set({ mode: 'offline', error: 'sin conexión con el ordenador' });
      this.scheduleRetry();
      return false;
    } finally {
      this.pulling = false;
    }
  }

  async pullIfChanged(): Promise<void> {
    if (this.pushing || this.pulling) return;
    try {
      const info = (await this.request('/api/home/version')) as { version: number; instance: string };
      if (info.version !== this.meta.version || info.instance !== this.meta.instance) await this.pull(true);
      else if (this.status.mode === 'offline') this.set({ mode: 'online', error: null });
    } catch {
      this.set({ mode: 'offline', error: 'sin conexión con el ordenador' });
    }
  }

  /** Llamar tras cada cambio local. */
  schedulePush(delay = this.env.debounceMs ?? 600): void {
    if (!this.active || this.stopped) return;
    this.set({ pending: this.dirty().length });
    if (this.pushTimer !== null) this.env.clearTimeout(this.pushTimer);
    this.pushTimer = this.env.setTimeout(() => {
      this.pushTimer = null;
      void this.pushNow();
    }, delay);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry += 1;
    if (this.pushTimer !== null) this.env.clearTimeout(this.pushTimer);
    this.pushTimer = this.env.setTimeout(() => {
      this.pushTimer = null;
      if (this.meta.instance === null || this.status.mode === 'offline') void this.pull(true);
      else void this.pushNow();
    }, wait);
  }

  async pushNow(): Promise<boolean> {
    if (!this.active) return false;
    if (this.pushing) {
      await this.pushing;
      return this.pushNow();
    }
    this.pushing = this.doPush();
    try {
      return await this.pushing;
    } finally {
      this.pushing = null;
    }
  }

  private async doPush(): Promise<boolean> {
    if (this.meta.instance === null) return this.pull(true);
    if (this.host.hasOnlyExample()) {
      this.set({ mode: 'demo', pending: 0 });
      return true;
    }
    const dirty = this.dirty();
    if (!dirty.length) {
      this.set({ mode: 'online', pending: 0, error: null });
      return true;
    }
    const records: Partial<Record<TableName, AnyRecord[]>> = {};
    for (const { table, rec } of dirty) (records[table] ??= []).push(rec);
    try {
      const body = (await this.request('/api/home/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_version: this.meta.version, records }),
      }, 60000)) as { state: ServerState };
      this.adopt(body.state);
      this.retry = 0;
      const pending = this.dirty().length;
      this.set({ mode: 'online', version: body.state.version, lastSync: this.env.now(), pending, error: null });
      if (pending) this.schedulePush();
      return true;
    } catch {
      this.set({ mode: 'offline', pending: dirty.length, error: 'sin conexión con el ordenador' });
      this.scheduleRetry();
      return false;
    }
  }

  /** «Actualizar Faustus ahora»: envía lo pendiente y trae lo nuevo. Devuelve los objetos que tiene el ordenador. */
  async forceSync(): Promise<number> {
    if (!this.active) {
      const base = await this.detect();
      if (base === null) throw new Error('Sin conexión con el ordenador. Abre el servidor de HomeHoard (python bridge/server.py).');
      this.meta.base = base;
      this.saveMeta();
      this.set({ base });
      if (!this.started) {
        this.started = true;
        this.watch();
      }
    }
    if (!(await this.pull(false))) throw new Error('Sin conexión con el ordenador. Abre el servidor de HomeHoard (python bridge/server.py).');
    if (this.host.hasOnlyExample()) throw new Error('La casa de ejemplo no se guarda en el ordenador. Empieza con tu casa.');
    if (!(await this.pushNow()) || this.status.mode !== 'online') throw new Error('No se pudo guardar en el ordenador.');
    return (this.host.tables().items ?? []).filter((i) => i.deleted_at == null).length;
  }
}

function fill(t: Partial<Record<TableName, AnyRecord[]>>): Tables {
  return Object.fromEntries(TABLES.map((name) => [name, [...(t[name] ?? [])]])) as unknown as Tables;
}

/** Combina tablas remotas en las locales (exportado para la fuente en memoria). */
export function mergeRemote(local: Tables, remote: Partial<Record<TableName, AnyRecord[]>>): number {
  return mergeInto(local, remote as Record<string, unknown[]>);
}
