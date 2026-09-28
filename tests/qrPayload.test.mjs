import assert from 'node:assert/strict';
import test from 'node:test';
import { labelUrl, parseLabel } from '../src/features/qrPayload.ts';

const id = '550e8400-e29b-41d4-a716-446655440000';

test('printed QR opens the right local record', () => {
  assert.deepEqual(parseLabel(labelUrl('container', id)), { kind: 'container', id });
  assert.deepEqual(parseLabel(labelUrl('item', id)), { kind: 'item', id });
});

test('unrelated or malformed QR is ignored', () => {
  assert.equal(parseLabel(`https://example.com/item/${id}`), null);
  assert.equal(parseLabel(`homehoard:///room/${id}`), null);
  assert.equal(parseLabel('homehoard:///item/not-a-uuid'), null);
  assert.throws(() => labelUrl('item', 'not-a-uuid'));
});
