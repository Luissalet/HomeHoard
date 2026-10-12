import type { UpdateItemInput } from '../db/types';

export interface ItemValues {
  name: string; description: string | null; quantity: number;
  roomId: string; containerId: string | null; photoUri: string | null;
  favorite: boolean; tagIds: string[];
}

export function changedItemFields(before: ItemValues, after: ItemValues): UpdateItemInput {
  const patch: UpdateItemInput = {};
  if (before.name !== after.name) patch.name = after.name;
  if (before.description !== after.description) patch.description = after.description;
  if (before.quantity !== after.quantity) patch.quantity = after.quantity;
  if (before.roomId !== after.roomId || before.containerId !== after.containerId) {
    patch.room_id = after.roomId; patch.container_id = after.containerId;
  }
  if (before.photoUri !== after.photoUri) patch.photo_uri = after.photoUri;
  if (before.favorite !== after.favorite) patch.favorite = after.favorite;
  if (JSON.stringify([...before.tagIds].sort()) !== JSON.stringify([...after.tagIds].sort())) patch.tagIds = [...after.tagIds];
  return patch;
}

export function acknowledgeItemFields(base: ItemValues, sent: ItemValues, patch: UpdateItemInput): ItemValues {
  const next = { ...base, tagIds: [...base.tagIds] };
  for (const key of ['name', 'description', 'quantity', 'favorite'] as const) {
    if (patch[key] !== undefined) Object.assign(next, { [key]: sent[key] });
  }
  if (patch.room_id !== undefined) { next.roomId = sent.roomId; next.containerId = sent.containerId; }
  if (patch.photo_uri !== undefined) next.photoUri = sent.photoUri;
  if (patch.tagIds !== undefined) next.tagIds = [...sent.tagIds];
  return next;
}

