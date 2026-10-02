// Llamadas de la web al servidor de HomeHoard (el ordenador): herramientas, Kafka y ajustes.
// Solo funcionan cuando la web está conectada con el ordenador; si no, lanzan un error que se puede mostrar.
import { getServerSync } from '../db/serverSync';

export const OFFLINE_MESSAGE = 'Disponible con HomeHoard abierto en el ordenador.';

export interface KafkaProblem {
  ok: false;
  reason: string;
  message: string;
}

function base(): string {
  const sync = getServerSync();
  if (!sync?.active) throw new Error(OFFLINE_MESSAGE);
  return sync.url('');
}

async function request<T>(path: string, body?: unknown, timeoutMs = 60000): Promise<T> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(base() + path, body === undefined
      ? { signal: ctrl?.signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl?.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`);
    return data as T;
  } catch (e) {
    if (e instanceof Error && e.message === OFFLINE_MESSAGE) throw e;
    if (e instanceof TypeError || (e as { name?: string })?.name === 'AbortError') throw new Error('Sin conexión con el ordenador.');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Antes de pedir algo al ordenador sobre un objeto, que tenga los últimos cambios de esta web. */
export async function flushLocal(): Promise<void> {
  await getServerSync()?.pushNow();
}

export async function refreshFromServer(): Promise<void> {
  await getServerSync()?.pull(false);
}

export const uiCall = <T = Record<string, unknown>>(tool: string, args: Record<string, unknown>) => request<T>('/api/ui/call', { tool, arguments: args });

export interface KafkaDoc {
  id: string;
  title: string | null;
  kind: string | null;
  kind_label?: string | null;
  issuer: string | null;
  issue_date: string | null;
  snippet?: string;
  page?: number;
}

export interface Papers {
  doc_ids: string[];
  documents: KafkaDoc[];
  missing?: string[];
  warranty: { until: string; active: boolean; days_left: number; source: 'manual' | 'kafka' } | null;
  kafka_warranty?: { until: string; active: boolean; days_left: number; basis: string; cite: string; document: { id: string; title: string } | null; linked: boolean };
  kafka: { ok: boolean; reason?: string; message?: string };
}

export interface ManualHit {
  doc_id: string;
  title: string;
  page: number;
  snippet: string;
  cite: string;
}

export const itemPapers = (itemId: string) => uiCall<Papers>('home_item_papers', { item: itemId });
export const manualSearch = (itemId: string, query: string) =>
  uiCall<{ status: string; results: ManualHit[]; message?: string | null; searched?: string }>('home_manual_search', { item: itemId, query });

export const kafkaSearch = (query: string, kind = '') =>
  request<{ ok: boolean; documents: KafkaDoc[]; reason?: string; message?: string }>('/api/kafka/search', { query, kind });

export const kafkaUpload = (itemId: string, kind: string, filename: string, data: string) =>
  request<{ ok: boolean; documents?: KafkaDoc[]; reason?: string; message?: string; duplicate_of?: string | null }>(
    '/api/kafka/upload', { item_id: itemId, kind, filename, data }, 240000);

export interface MirrorTask {
  ok: boolean | null;
  deadline_id: string | null;
  date: string | null;
  error: string | null;
  reason: string | null;
  closed: boolean | null;
}

export interface KafkaStatus {
  kafka: { reachable: boolean; reason?: string; message?: string };
  mirror: { enabled: boolean; last_run: number | null; pending: number; mirrored: number; tasks: Record<string, MirrorTask>; last_error: string | null } | null;
  settings: { kafka_mirror: boolean };
}

export const kafkaStatus = (force = false) => request<KafkaStatus>(`/api/kafka/status${force ? '?force=1' : ''}`);
export const runMirror = () => request<KafkaStatus>('/api/kafka/mirror/run', {});
export const saveSettings = (values: { kafka_mirror?: boolean }) => request<{ kafka_mirror: boolean }>('/api/settings', values);

/** Elige un archivo en el navegador y lo devuelve como base64. */
export function pickFileBase64(accept = '.pdf,image/*,.txt,.eml,.docx,.html'): Promise<{ name: string; data: string } | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, data: String(reader.result) });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

export const KAFKA_URL = 'http://127.0.0.1:5200';
export const kafkaDocUrl = (docId: string, page?: number) => `${KAFKA_URL}/#/documentos/${docId}${page ? `?p=${page}` : ''}`;
