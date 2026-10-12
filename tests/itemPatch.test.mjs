import test from 'node:test';
import assert from 'node:assert/strict';
import { changedItemFields, acknowledgeItemFields } from '../src/features/itemPatch.ts';

const original = { name:'Torch', description:'Old', quantity:1, roomId:'storage',
 containerId:'box', photoUri:'/photos/torch.png', favorite:false, tagIds:['a','b'] };
test('saving a note omits unchanged quantity, location, photo and tags', () => {
 assert.deepEqual(changedItemFields(original,{...original,description:'Draft'}),{description:'Draft'});
});
test('clears and every existing form field are represented without losing values', () => {
 const next={name:'New',description:null,quantity:0,roomId:'kitchen',containerId:null,photoUri:null,favorite:true,tagIds:[]};
 assert.deepEqual(changedItemFields(original,next),{name:'New',description:null,quantity:0,room_id:'kitchen',container_id:null,photo_uri:null,favorite:true,tagIds:[]});
 assert.deepEqual(changedItemFields(original,{...original,tagIds:['b','a']}),{});
});
test('acknowledgement keeps native siblings and a subsequent draft changes only its field', () => {
 const sent={...original,description:'Submitted'};
 const native={...original,quantity:4,roomId:'kitchen',containerId:null};
 const baseline=acknowledgeItemFields(native,sent,{description:'Submitted'});
 assert.equal(baseline.quantity,4);assert.equal(baseline.roomId,'kitchen');
 assert.deepEqual(changedItemFields(baseline,{...baseline,description:'Later'}),{description:'Later'});
});

