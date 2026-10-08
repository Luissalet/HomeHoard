import json
import unittest
import inventory
from helpers_test import make_app, sample_records, tempdir, Running
from homehoard_server import tools as T
from test_http_sync import post


class WarrantiesTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempdir();self.app,self.clock,self.kafka,self.events=make_app(self.tmp.name,mirror=False)
        self.app.store.merge(sample_records())
        T.save_details(self.app.ctx,'torch',{'warranty_until':'2026-10-06'})
        T.save_details(self.app.ctx,'washer',{'warranty_until':'2026-10-20','warranty_source':'kafka'})
        T.save_details(self.app.ctx,'boiler',{'warranty_until':'2026-10-05'})

    def tearDown(self):
        inventory.use_store(None);self.tmp.cleanup()

    def call(self,**args):
        return T.call(self.app.ctx,'home_warranties',{'as_of':'2026-10-06',**args})

    def test_inclusive_dates_and_source_no_remote_calls_or_writes(self):
        before=self.app.store.client_state();raw=self.app.paths.state.read_bytes();events=list(self.events)
        r=self.call(days=14)
        self.assertEqual([x['item_id'] for x in r['items']],['torch','washer'])
        self.assertEqual([x['days_left'] for x in r['items']],[0,14])
        self.assertEqual(r['items'][1]['source'],'kafka')
        self.assertFalse(r['kafka_queried'])
        self.assertEqual(self.call(days=14),r)
        self.assertEqual(self.app.store.client_state(),before);self.assertEqual(self.app.paths.state.read_bytes(),raw)
        self.assertEqual(self.events,events);self.assertEqual(self.kafka.calls,[])

    def test_nested_location_and_pagination(self):
        r=self.call(status='all',location='shelf')
        self.assertEqual(r['checked_items'],1);self.assertEqual(r['items'][0]['item_id'],'torch')
        self.assertTrue(r['items'][0]['location'].endswith('Estantería › Caja roja'))
        page=self.call(status='all',limit=1)
        self.assertEqual(page['matched'],3);self.assertEqual(page['next_offset'],1)
        following=self.call(status='all',limit=1,offset=page['next_offset'])
        self.assertNotEqual(page['items'][0]['item_id'],following['items'][0]['item_id'])

    def test_unknown_invalid_card_and_deleted_item_are_distinct(self):
        card=self.app.store.get('item_details','washer')
        self.app.store.put('item_details',{**card,'warranty_until':'not-a-date'})
        item=self.app.store.get('items','boiler')
        self.app.store.put('items',{**item,'deleted_at':self.app.ctx.now_ms()})
        r=self.call(status='unknown')
        self.assertEqual(r['unknown_dates'],1);self.assertEqual(r['checked_items'],2)
        self.assertEqual(r['items'][0]['item_id'],'washer');self.assertIsNone(r['items'][0]['days_left'])
        self.assertEqual(self.call(status='expired')['matched'],0)

    def test_leap_day_and_expired_date(self):
        T.save_details(self.app.ctx,'torch',{'warranty_until':'2028-02-29'})
        r=T.call(self.app.ctx,'home_warranties',{'as_of':'2028-02-28','days':1})
        self.assertEqual([x['item_id'] for x in r['items']],['torch']);self.assertEqual(r['items'][0]['days_left'],1)
        self.assertEqual(self.call(status='expired')['items'][0]['days_left'],-1)

    def test_invalid_query_does_not_change_inventory(self):
        before=self.app.store.client_state()
        for a in [{'days':True},{'days':-1},{'status':'invented'},{'limit':101},{'offset':-1},{'as_of':'2026-02-30'}, {'as_of':'9999-12-31','days':1}]:
            with self.subTest(a=a),self.assertRaises(T.ToolError):self.call(**a)
        self.assertEqual(self.app.store.client_state(),before)

    def test_http_tool_contract(self):
        with Running(self.app) as url:
            status,r=post(url+'/api/agent/call',{'name':'home_warranties','arguments':{'as_of':'2026-10-06','days':0}},
                          {'Authorization':'Bearer '+self.app.token})
            self.assertEqual(status,200);self.assertEqual(r['items'][0]['item_id'],'torch')


if __name__=='__main__':unittest.main()
