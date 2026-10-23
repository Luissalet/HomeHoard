import copy
import json
import unittest

import inventory
from helpers_test import make_app, sample_records, tempdir, Running
from homehoard_server import tools as T
from test_http_sync import get, post


class CombinedKitsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir()
        self.app, self.clock, self.kafka, self.events = make_app(self.tmp.name, mirror=False)
        self.app.store.merge(sample_records())
        self.app.store.put('items', {**self.app.store.get('items', 'torch'), 'quantity': 2})
        self.camp = self.save('Acampada', [{'item_id': 'torch', 'quantity': 2}])
        self.emergency = self.save('Emergencias', [{'item_id': 'torch', 'quantity': 1}])

    def tearDown(self):
        inventory.use_store(None)
        self.tmp.cleanup()

    def save(self, name, requests):
        return T.call(self.app.ctx, 'home_kits', {'action': 'save', 'name': name, 'requests': requests})['kit']

    def check(self, **args):
        return T.call(self.app.ctx, 'home_check_list', args)

    def snapshot(self):
        file = self.app.paths.state
        return (self.app.store.client_state(), file.read_bytes(), file.stat().st_mtime_ns,
                copy.deepcopy(self.events), copy.deepcopy(self.kafka.calls))

    def test_shared_stock_is_counted_once_and_each_kit_is_attributed_without_writes(self):
        before = self.snapshot()
        self.assertTrue(self.check(kit='Acampada')['ready'])
        self.assertTrue(self.check(kit='Emergencias')['ready'])
        result = self.check(kits=['Acampada', self.emergency['id']])
        self.assertFalse(result['ready'])
        self.assertEqual((result['requested_total'], result['to_pack_total'], result['missing_total']), (3, 2, 1))
        row = result['items'][0]
        self.assertEqual((row['requested'], row['available'], row['to_pack'], row['missing']), (3, 2, 2, 1))
        self.assertTrue(row['location'].endswith('Trastero › Estantería › Caja roja'))
        self.assertEqual(row['kits'], [{'id': self.camp['id'], 'name': 'Acampada', 'quantity': 2},
                                       {'id': self.emergency['id'], 'name': 'Emergencias', 'quantity': 1}])
        self.assertEqual([k['id'] for k in result['kits']], [self.camp['id'], self.emergency['id']])
        self.assertEqual(self.snapshot(), before)

    def test_duplicate_refs_and_id_name_aliases_count_each_resolved_kit_once(self):
        expected = self.check(kits=['Acampada', 'Emergencias'])
        self.assertEqual(self.check(kits=[self.camp['id'], ' acampada ', 'ACAMPADA', self.emergency['id'], 'Emergencias']), expected)
        single = self.check(kits=['Acampada', self.camp['id']])
        self.assertEqual(single['requested_total'], 2)
        self.assertTrue(single['ready'])

    def test_each_definition_has_its_own_limit_and_shared_objects_keep_first_seen_order(self):
        a = self.save('Cien A', [{'item_id': f'a{i}', 'quantity': 1} for i in range(100)])
        b = self.save('Cien B', [{'item_id': f'a{i}', 'quantity': 2} for i in range(50, 150)])
        result = self.check(kits=[a['id'], b['id']])
        self.assertEqual(result['requested_total'], 300)
        self.assertEqual([r['item_id'] for r in result['items']], [f'a{i}' for i in range(150)])
        self.assertEqual(result['items'][50]['requested'], 3)
        self.assertFalse(result['totals_complete'])
        self.assertIsNone(result['missing_total'])

    def test_latest_saved_definition_stock_and_location_are_used_without_changing_kits(self):
        first = self.check(kits=['Acampada', 'Emergencias'])
        self.app.store.put('items', {**self.app.store.get('items', 'torch'), 'quantity': 4, 'room_id': 'kitchen', 'container_id': 'drawer'})
        T.call(self.app.ctx, 'home_kits', {'action': 'save', 'kit': self.camp['id'], 'name': 'Acampada',
                                       'requests': [{'item_id': 'torch', 'quantity': 3}]})
        before = self.snapshot()
        result = self.check(kits=['Acampada', 'Emergencias'])
        self.assertTrue(result['ready'])
        self.assertEqual((result['requested_total'], result['missing_total']), (4, 0))
        self.assertGreater(result['inventory_version'], first['inventory_version'])
        self.assertIn('Cocina › Cajón rojo', result['items'][0]['location'])
        self.assertEqual(self.snapshot(), before)

    def test_unknown_quantity_and_deleted_item_keep_totals_incomplete(self):
        for changes, status in [({'quantity': None}, 'unknown_quantity'), ({'deleted_at': 123}, 'not_found')]:
            with self.subTest(status=status):
                self.app.store.put('items', {**self.app.store.get('items', 'torch'), **changes})
                result = self.check(kits=['Acampada', 'Emergencias'])
                self.assertFalse(result['ready'])
                self.assertFalse(result['totals_complete'])
                self.assertIsNone(result['missing_total'])
                self.assertEqual(result['items'][0]['status'], status)
                self.assertIsNone(result['items'][0]['available'])
                self.assertEqual(len(result['items'][0]['kits']), 2)

    def test_bad_sources_missing_deleted_or_ambiguous_kit_fail_without_writes(self):
        cases = [{}, {'kits': []}, {'kits': ['Acampada'] * 51}, {'kits': 'Acampada'},
                 {'kits': [None]}, {'kits': [True]}, {'kits': [1]}, {'kits': [' ']},
                 {'kits': ['Acampada', 'No existe']}, {'kits': ['Acampada'], 'kit': 'Acampada'},
                 {'kits': ['Acampada'], 'requests': [{'item_id': 'torch', 'quantity': 1}]}]
        self.app.store.put('packing_kits', {**self.emergency, 'deleted_at': 123})
        cases.append({'kits': [self.emergency['id']]})
        self.app.store.put('packing_kits', {**self.camp, 'id': 'ambiguous', 'name': 'ACAMPADA'})
        cases.append({'kits': ['Acampada']})
        before = self.snapshot()
        for args in cases:
            with self.subTest(args=args), self.assertRaises(T.ToolError):
                self.check(**args)
            self.assertEqual(self.snapshot(), before)

    def test_native_http_ui_and_agent_share_schema_results_and_read_only_annotations(self):
        args = {'kits': [self.camp['id'], self.emergency['id']]}
        expected = self.check(**args)
        before = self.snapshot()
        with Running(self.app) as base:
            _, _, raw = get(base + '/api/agent/tools')
            tool = next(t for t in json.loads(raw)['tools'] if t['name'] == 'home_check_list')
            self.assertEqual(tool['inputSchema']['properties']['kits']['maxItems'], 50)
            self.assertTrue(tool['annotations']['readOnlyHint'])
            for endpoint, headers in [('/api/agent/call', {'Authorization': 'Bearer ' + self.app.token}), ('/api/ui/call', {})]:
                status, result = post(base + endpoint, {'tool': 'home_check_list', 'arguments': args}, headers)
                self.assertEqual(status, 200)
                self.assertEqual(result, expected)
                status, _ = post(base + endpoint, {'tool': 'home_check_list', 'arguments': {'kits': []}}, headers)
                self.assertEqual(status, 400)
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
