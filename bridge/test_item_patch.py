import base64,json,threading,unittest,urllib.request
from concurrent.futures import ThreadPoolExecutor
from helpers_test import Running,make_app,sample_records,tempdir
from homehoard_server import tools

class ItemPatchTest(unittest.TestCase):
 def test_public_partial_patch_preserves_native_siblings_and_extra_fields(self):
  with tempdir() as tmp:
   app,clock,kafka,events=make_app(tmp,mirror=False);app.store.merge(sample_records())
   row=app.store.get('items','torch');row['custom_extra']={'keep':True};app.store.put('items',row)
   with Running(app) as base:
    tools.call(app.ctx,'home_update_item',{'item':'torch','quantity':4})
    tools.call(app.ctx,'home_move_item',{'item':'torch','location':'Cocina'})
    request=urllib.request.Request(base+'/api/home/item-patch',data=json.dumps({'id':'torch','patch':{'description':'Draft'}}).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(request) as response:state=json.load(response)['state']
    saved=next(i for i in state['tables']['items'] if i['id']=='torch')
    self.assertEqual((saved['quantity'],saved['room_id'],saved['container_id'],saved['description']),(4,'kitchen',None,'Draft'))
    self.assertEqual(saved['custom_extra'],{'keep':True})

 def test_tag_clear_restore_photo_and_all_form_fields(self):
  with tempdir() as tmp:
   app,*_=make_app(tmp,mirror=False);app.store.merge(sample_records())
   image='data:image/png;base64,'+base64.b64encode(b'private-test-image').decode()
   app.store.patch_item('torch',{'name':'New','quantity':0,'description':None,'room_id':'kitchen','container_id':None,'favorite':True,'tagIds':[],'photo_uri':image})
   item=app.store.get('items','torch')
   self.assertEqual((item['name'],item['quantity'],item['description'],item['favorite']),('New',0,None,1))
   self.assertEqual(app.store.photo_file('torch').read_bytes(),b'private-test-image')
   self.assertFalse([r for r in app.store.alive('itemTags') if r['item_id']=='torch'])
   app.store.patch_item('torch',{'tagIds':['electric'],'photo_uri':None})
   self.assertIsNone(app.store.photo_file('torch'))
   self.assertEqual([r['tag_id'] for r in app.store.alive('itemTags') if r['item_id']=='torch'],['electric'])

 def test_native_read_modify_write_holds_same_lock_as_ui_patch(self):
  with tempdir() as tmp:
   app,*_=make_app(tmp,mirror=False);app.store.merge(sample_records())
   entered=threading.Event();release=threading.Event();original=tools.TOOLS_BY_NAME['home_update_item'].run
   def held(ctx,args):
    entered.set();release.wait(5);return original(ctx,args)
   tool=tools.TOOLS_BY_NAME['home_update_item'];previous=tool.run
   # The descriptor itself is frozen; replace its catalogue entry for this test only.
   from dataclasses import replace
   tools.TOOLS_BY_NAME['home_update_item']=replace(tool,run=held)
   try:
    with ThreadPoolExecutor(2) as pool:
     native=pool.submit(tools.call,app.ctx,'home_update_item',{'item':'torch','quantity':4})
     self.assertTrue(entered.wait(3))
     ui=pool.submit(app.store.patch_item,'torch',{'description':'Concurrent draft'})
     self.assertFalse(ui.done());release.set();native.result();ui.result()
    saved=app.store.get('items','torch')
    self.assertEqual((saved['quantity'],saved['description']),(4,'Concurrent draft'))
   finally:
    release.set();tools.TOOLS_BY_NAME['home_update_item']=tool

if __name__=='__main__':unittest.main()

