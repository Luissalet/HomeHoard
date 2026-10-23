import type { KitSummary } from './packingKits';

/** A filtered page cannot prove that a selected kit has been deleted. */
export function reconcileKitSelection(selected: KitSummary[], visible: KitSummary[], complete: boolean): KitSummary[] {
  const current = new Map(visible.map(kit => [kit.id, kit]));
  const next = selected.flatMap(kit => {
    const fresh = current.get(kit.id);
    if (!fresh) return complete ? [] : [kit];
    return [fresh.name === kit.name && fresh.items === kit.items && fresh.updated_at === kit.updated_at ? kit : fresh];
  });
  return next.length === selected.length && next.every((kit, index) => kit === selected[index]) ? selected : next;
}
