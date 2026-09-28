export type LabelKind = 'container' | 'item';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ID_PATTERN = new RegExp(`^${UUID}$`);
const LABEL_PATTERN = new RegExp(`^homehoard:\/\/\/(container|item)\/(${UUID})$`);

export function labelUrl(kind: LabelKind, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('Identificador de inventario no válido.');
  return `homehoard:///${kind}/${id.toLowerCase()}`;
}

export function parseLabel(value: string): { kind: LabelKind; id: string } | null {
  const match = LABEL_PATTERN.exec(value.trim());
  return match ? { kind: match[1] as LabelKind, id: match[2].toLowerCase() } : null;
}
