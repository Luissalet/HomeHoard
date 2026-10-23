import copy
import unittest

import inventory
from helpers_test import make_app, sample_records, tempdir, Running
from homehoard_server import tools as T
from homehoard_server.bundle import records_from_bundle
from homehoard_server.store import HomeStore
from test_http_sync import post


class KitsTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempdir()
        self.app,self.clock,self.kafka,self.events=make_app(self.tmp.name,mirror=False)
        self.app.store.merge(sample_records())

    def tearDown(self):
        inventory.use_store(None);self.tmp.cleanup()

    def call(self, **args): return T.call(self.app.ctx,'home_kits',args)

    def save(self, **extra):
        return self.call(action='save',name='Viaje',requests=[{'item_id':'torch','quantity':1},{'item_id':'torch','quantity':2}],**extra)

    def test_save_reuse_recheck_and_correct_without_changing_objects(self):
        before=self.app.store.tables()
        saved=self.save(notes='Equipo personal')['kit']
        self.assertEqual(saved['requests'],[{'item_id':'torch','quantity':3}])
        for table in before:
            if table!='packing_kits':self.assertEqual(self.app.store.tables()[table],before[table])
        state=self.app.paths.state.read_bytes();version=self.app.store.info()['version']
        same=self.save()
        self.assertEqual(same['status'],'unchanged')
        self.assertEqual((self.app.paths.state.read_bytes(),self.app.store.info()['version']),(state,version))
        check=T.call(self.app.ctx,'home_check_list',{'kit':'Viaje'})
        self.assertEqual((check['requested_total'],check['missing_total'],check['kit']['id']),(3,2,saved['id']))
        self.app.store.put('items',{**self.app.store.get('items','torch'),'quantity':4,'container_id':'drawer','room_id':'kitchen'})
        fresh=T.call(self.app.ctx,'home_check_list',{'kit':saved['id']})
        self.assertTrue(fresh['ready']);self.assertEqual(fresh['missing_total'],0)
        self.assertIn('Cocina › Cajón rojo',fresh['items'][0]['location'])
        corrected=self.call(action='save',kit=saved['id'],name='Viaje',requests=[{'item_id':'torch','quantity':2}])
        self.assertEqual(corrected['status'],'updated')
        self.assertEqual(T.call(self.app.ctx,'home_check_list',{'kit':'viaje'})['requested_total'],2)
        self.assertEqual(len(self.call()['kits']),1)

    def test_portable_copy_and_restart_keep_definition_and_tombstone(self):
        kit=self.save()['kit']
        reopened=HomeStore(self.app.paths,self.clock)
        self.assertEqual(reopened.get('packing_kits',kit['id']),kit)
        bundle={'format':'homehoard-export','version':4,'exported_at':self.app.ctx.now_ms(),'data':reopened.tables()}
        records,_,_=records_from_bundle(copy.deepcopy(bundle))
        self.assertEqual(records['packing_kits'][0]['requests'],kit['requests'])
        before=self.app.paths.state.read_bytes()
        with self.assertRaises(T.ToolError):self.call(action='delete',kit=kit['id'])
        self.assertEqual(self.app.paths.state.read_bytes(),before)
        self.clock.advance(1)
        self.call(action='delete',kit=kit['id'],confirm=True)
        self.app.store.merge(records,mode='import')
        self.assertIsNotNone(self.app.store.get('packing_kits',kit['id'])['deleted_at'])
        self.assertEqual(self.call()['total'],0)

    def test_missing_objects_survive_in_definition_and_never_mean_zero(self):
        self.call(action='save',name='Futuro',requests=[{'item_id':'not-yet-owned','quantity':2}])
        r=T.call(self.app.ctx,'home_check_list',{'kit':'Futuro'})
        self.assertFalse(r['ready']);self.assertIsNone(r['missing_total'])
        self.assertEqual(r['items'][0]['status'],'not_found')
        self.assertIsNone(r['items'][0]['available'])

    def test_conflicting_sources_and_bad_save_leave_state_intact(self):
        self.save();before=self.app.paths.state.read_bytes()
        for args in [{'action':'save','name':'Bad','requests':[{'item_id':'torch','quantity':True}]},
                     {'action':'save','name':'Bad','requests':[]},
                     {'action':'save','name':'Bad','requests':[{'item_id':'torch','quantity':0}]}]:
            with self.subTest(args=args),self.assertRaises(T.ToolError):self.call(**args)
            self.assertEqual(self.app.paths.state.read_bytes(),before)
        with self.assertRaises(T.ToolError):
            T.call(self.app.ctx,'home_check_list',{'kit':'Viaje','requests':[{'item_id':'torch','quantity':1}]})

    def test_real_http_contract_saves_and_checks_the_kit(self):
        with Running(self.app) as url:
            headers={'Authorization':'Bearer '+self.app.token}
            status,saved=post(url+'/api/agent/call',{'tool':'home_kits','arguments':{'action':'save','name':'HTTP',
                'requests':[{'item_id':'torch','quantity':2}]}},headers)
            self.assertEqual(status,200)
            status,checked=post(url+'/api/agent/call',{'tool':'home_check_list','arguments':{'kit':'HTTP'}},headers)
            self.assertEqual(status,200);self.assertEqual(checked['missing_total'],1)
            before = self.app.store.tables()['items']
            status,ui=post(url+'/api/ui/call',{'tool':'home_check_list','arguments':{'kit':saved['kit']['id']}})
            self.assertEqual(status,200);self.assertEqual(ui,checked)
            status,loaded=post(url+'/api/ui/call',{'tool':'home_kits','arguments':{'action':'get','kit':saved['kit']['id']}})
            self.assertEqual(status,200);self.assertEqual(loaded['kit'],saved['kit'])
            self.assertEqual(self.app.store.tables()['items'],before)

    def test_invalid_backup_cannot_replace_a_valid_definition(self):
        self.save();before=self.app.paths.state.read_bytes()
        for bad in [None, [], 'broken JSON', [{'item_id':'torch','quantity':0}]]:
            bundle={'format':'homehoard-export','version':4,'exported_at':self.app.ctx.now_ms(), 'data':self.app.store.tables()}
            bundle['data']['packing_kits'][0]['requests']=bad
            with self.subTest(bad=bad),self.assertRaises(ValueError):inventory.save(bundle)
            self.assertEqual(self.app.paths.state.read_bytes(),before)
        broken={'format':'homehoard-export','version':4,'exported_at':self.app.ctx.now_ms(),'data':self.app.store.tables()}
        del broken['data']['packing_kits']
        with self.assertRaises(ValueError):inventory.save(broken)
        self.assertEqual(self.app.paths.state.read_bytes(),before)

    def test_search_pages_reach_every_kit_and_leave_inventory_unchanged(self):
        for index in range(61):
            self.call(action='save', name=f'Equipo {index:02}', notes='Cámara de montaña' if index % 2 else 'Taller',
                      requests=[{'item_id':'torch','quantity':1}])
        state = self.app.paths.state.read_bytes()
        version = self.app.store.info()['version']
        first, last = self.call(), self.call(offset=50)
        self.assertEqual((len(first['kits']), first['total'], first['has_more']), (50,61,True))
        self.assertEqual((len(last['kits']), last['kits'][-1]['name'], last['has_more']), (11,'Equipo 60',False))
        self.assertEqual(len({row['id'] for row in first['kits'] + last['kits']}),61)
        filtered = self.call(q='MONTANA camara', limit=10, offset=20)
        self.assertEqual((filtered['total'],filtered['all_total'],filtered['has_more']), (30,61,False))
        self.assertEqual([row['name'] for row in filtered['kits']], [f'Equipo {i:02}' for i in range(41,60,2)])
        self.assertEqual(self.call(q='equipo 60')['kits'][0]['name'],'Equipo 60')
        self.assertEqual(self.call(q='sin coincidencias')['total'],0)
        self.assertEqual(self.call(offset=500)['kits'],[])
        self.assertEqual((self.app.paths.state.read_bytes(),self.app.store.info()['version']),(state,version))

    def test_search_page_validation_does_not_write(self):
        self.save(); before = self.app.paths.state.read_bytes()
        for args in [{'q':'x'*201}, {'offset':-1}, {'offset':True}, {'limit':0}, {'limit':51}, {'limit':1.5}]:
            with self.subTest(args=args), self.assertRaises(T.ToolError):self.call(**args)
            self.assertEqual(self.app.paths.state.read_bytes(),before)


if __name__=='__main__':unittest.main()
