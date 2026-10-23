import { flushLocal, uiCall } from './serverApi';

export type WarrantyStatus = 'expiring' | 'active' | 'expired' | 'unknown' | 'all';
export interface WarrantyQuery {
  status: WarrantyStatus;
  days: number;
  as_of?: string;
  location?: string;
  offset: number;
  limit: number;
}
export interface WarrantyRow {
  item_id: string;
  name: string;
  location: string;
  warranty_until: string | null;
  days_left: number | null;
  status: 'active' | 'expired' | 'unknown';
  source: string | null;
  warranty_ref: string | null;
  brand: string | null;
  model: string | null;
}
export interface WarrantyPage {
  as_of: string;
  window_end: string;
  days: number;
  status: WarrantyStatus;
  inventory_version: number;
  checked_items: number;
  unknown_dates: number;
  matched: number;
  items: WarrantyRow[];
  next_offset: number | null;
  basis: 'recorded_home_cards';
  kafka_queried: false;
}

/** The server owns dates, status, location matching and pagination. */
export async function listWarranties(query: WarrantyQuery): Promise<WarrantyPage> {
  await flushLocal();
  return uiCall<WarrantyPage>('home_warranties', {...query});
}
