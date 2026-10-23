import type { PackingKit } from '../db/types';
import { flushLocal, refreshFromServer, uiCall } from './serverApi';

export interface KitSummary { id: string; name: string; items: number; updated_at: number }
export interface CheckedKit {id: string; name: string; updated_at: number}
export interface PackingRow {
  item_id: string;
  name: string | null;
  requested: number;
  available: number | null;
  to_pack: number | null;
  missing: number | null;
  location: string | null;
  status: 'available' | 'shortage' | 'not_found' | 'unknown_quantity';
  kits?: {id: string; name: string; quantity: number}[];
}
export interface PackingCheck {
  inventory_version: number;
  ready: boolean;
  totals_complete: boolean;
  requested_total: number;
  to_pack_total: number | null;
  missing_total: number | null;
  items: PackingRow[];
  kits?: CheckedKit[];
}

export const listKits = () => uiCall<{kits: KitSummary[]; total: number}>('home_kits', {action: 'list'});
export const getKit = (id: string) => uiCall<{kit: PackingKit}>('home_kits', {action: 'get', kit: id});
export async function saveKit(name: string, notes: string, requests: PackingKit['requests'], id?: string) {
  await flushLocal();
  const result = await uiCall<{kit: PackingKit; status: string}>('home_kits', {action: 'save', name, notes, requests, ...(id ? {kit: id} : {})});
  await refreshFromServer();
  return result;
}
export async function deleteKit(id: string) {
  await uiCall('home_kits', {action: 'delete', kit: id, confirm: true});
  await refreshFromServer();
}
export async function checkPacking(requests: PackingKit['requests']) {
  await flushLocal();
  return uiCall<PackingCheck>('home_check_list', {requests});
}
export async function checkKits(kits: string[]) {
  await flushLocal();
  return uiCall<PackingCheck>('home_check_list', {kits});
}
