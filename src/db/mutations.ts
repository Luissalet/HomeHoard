// Reglas de escritura compartidas por la fuente en memoria (web) y la de SQLite (móvil): ficha y mantenimiento.
import { newId } from './ids';
import { computeNextDue } from '../features/maintenanceCore';
import type { ID, ItemDetails, ItemDetailsInput, MaintenanceTask, NewMaintenanceInput, UpdateMaintenanceInput } from './types';

export function emptyDetails(itemId: ID): ItemDetails {
  return {
    id: itemId, item_id: itemId, brand: null, model: null, serial: null, purchase_date: null, store: null, price: null,
    warranty_until: null, warranty_source: null, kafka_doc_ids: [], manual_url: null, consumables: [], notes: null,
    source_ref: null, warranty_ref: null, created_at: 0, updated_at: 0, deleted_at: null,
  };
}

/** Solo los campos de la ficha, con textos recortados y vacíos como null. */
export function cleanDetails(patch: ItemDetailsInput): ItemDetailsInput {
  const out: ItemDetailsInput = {};
  for (const key of ['brand', 'model', 'serial', 'store', 'manual_url', 'notes', 'purchase_date', 'warranty_until', 'source_ref', 'warranty_ref'] as const) {
    if (patch[key] !== undefined) out[key] = patch[key] ? String(patch[key]).trim() || null : null;
  }
  if (patch.price !== undefined) out.price = patch.price == null || Number.isNaN(Number(patch.price)) ? null : Number(patch.price);
  if (patch.warranty_source !== undefined) out.warranty_source = patch.warranty_source;
  if (patch.kafka_doc_ids !== undefined) out.kafka_doc_ids = [...new Set(patch.kafka_doc_ids.map((x) => String(x).trim()).filter(Boolean))];
  if (patch.consumables !== undefined) out.consumables = patch.consumables.filter((c) => c.name?.trim()).map((c) => ({ name: c.name.trim(), spec: c.spec?.trim() || null, qty: c.qty ?? null, last_bought: c.last_bought || null }));
  return out;
}

export function newTask(input: NewMaintenanceInput, t: number): MaintenanceTask {
  const task: MaintenanceTask = {
    id: newId(), target_kind: input.target_kind, target_id: input.target_id, title: input.title.trim(),
    every_days: input.every_days ?? null, every_months: input.every_days ? null : input.every_months ?? 12, anchor_month: input.anchor_month ?? null,
    last_done_at: input.last_done_at ?? null, next_due: input.next_due ?? null, next_due_manual: input.next_due ? 1 : 0,
    notes: input.notes ?? null, basis: input.basis ?? 'advice', legal_ref: input.legal_ref ?? null, template_id: input.template_id ?? null,
    kafka_deadline_id: null, paused: 0, created_at: t, updated_at: t, deleted_at: null,
  };
  task.next_due = computeNextDue(task, t);
  return task;
}

export function applyTaskPatch(task: MaintenanceTask, patch: UpdateMaintenanceInput, t: number): void {
  if (patch.title !== undefined && patch.title.trim()) task.title = patch.title.trim();
  if (patch.every_days !== undefined && patch.every_days) { task.every_days = patch.every_days; task.every_months = null; }
  if (patch.every_months !== undefined && patch.every_months) { task.every_months = patch.every_months; task.every_days = null; }
  if (patch.anchor_month !== undefined) task.anchor_month = patch.anchor_month;
  if (patch.last_done_at !== undefined) task.last_done_at = patch.last_done_at;
  if (patch.notes !== undefined) task.notes = patch.notes;
  if (patch.basis !== undefined) task.basis = patch.basis;
  if (patch.legal_ref !== undefined) task.legal_ref = patch.legal_ref;
  if (patch.template_id !== undefined) task.template_id = patch.template_id;
  if (patch.paused !== undefined) task.paused = patch.paused ? 1 : 0;
  if (patch.next_due !== undefined) {
    task.next_due = patch.next_due;
    task.next_due_manual = patch.next_due ? 1 : 0;
  }
  task.next_due = computeNextDue(task, t);
  task.updated_at = Math.max(t, task.updated_at + 1);
}
