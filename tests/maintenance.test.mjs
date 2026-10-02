import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSources, readJson } from './helpers/compile.mjs';

const compiled = compileSources();
const M = compiled.load('src/features/maintenanceCore.js');
const cases = readJson('tests/maintenance-cases.json');
const catalogue = readJson('shared/maintenance-templates.json');
test.after(() => compiled.cleanup());

const noon = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0).getTime();
};

test('the next due date follows the shared cases (same as the server)', () => {
  for (const { task, expected } of cases.next_due) {
    const input = { ...task, last_done_at: task.last_done ? noon(task.last_done) : null, created_at: noon(task.created) };
    assert.equal(M.computeNextDue(input), expected, JSON.stringify(task));
  }
});

test('tasks fall into overdue, this month or upcoming', () => {
  for (const [day, group] of cases.groups.cases) assert.equal(M.groupOf(day, cases.groups.today), group, String(day));
});

test('intervals read in Spanish', () => {
  for (const [task, text] of cases.intervals) assert.equal(M.intervalText(task), text);
});

test('templates are suggested from the name of the thing or the kind of room', () => {
  for (const c of cases.suggest) {
    const got = M.suggestTemplates(catalogue, c.name, { target: c.target, roomKind: c.room_kind }).map((t) => t.id);
    assert.deepEqual(got, c.expected, c.name);
  }
});

test('every legal template states its norm; the rest are advice', () => {
  for (const t of catalogue.templates) {
    assert.ok(['law', 'advice', 'maker'].includes(t.basis), t.id);
    if (t.basis === 'law') assert.ok(t.legal_ref && t.rule, t.id);
    assert.ok(t.every_months || t.every_days, t.id);
  }
  assert.ok(catalogue.advice_source.includes('no es una obligación legal'));
});
