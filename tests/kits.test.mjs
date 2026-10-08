import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { compileSources } from './helpers/compile.mjs';

const compiled=compileSources();
const R=compiled.load('src/db/records.js');
const { MemorySource }=compiled.load('src/db/memory.js');
test.after(()=>compiled.cleanup());
const kit={id:'kit-trip',household_id:'hh',name:'Viaje',requests:[{item_id:'torch',quantity:3}],notes:'Equipo',
           created_at:100,updated_at:200,deleted_at:null};
const bundle=()=>({format:'homehoard-export',version:4,exported_at:200,data:{...R.emptyTables(),
  households:[{id:'hh',name:'Home',created_at:100,updated_at:200,deleted_at:null}],packing_kits:[structuredClone(kit)]}});

test('web persistence/export roundtrip keeps saved kit rows and JSON arrays',async()=>{
  const source=new MemorySource();await source.ready();await source.importAll(bundle());
  const exported=await source.exportAll();assert.equal(exported.version,4);
  assert.deepEqual(exported.data.packing_kits,[kit]);
  await source.clearAll();assert.notEqual((await source.exportAll()).data.packing_kits[0].deleted_at,null);
});

test('version 3 remains importable; JSON text from SQLite normalizes to requests',()=>{
  const b=bundle();b.version=3;delete b.data.packing_kits;
  assert.deepEqual(R.recordsFromBundle(b).tables.packing_kits,[]);
  assert.deepEqual(R.normalizeRecord('packing_kits',{...kit,requests:JSON.stringify(kit.requests)}).requests,kit.requests);
});

test('actual native SqliteSource import/export/clear over a real SQLite database preserves kits',async()=>{
  const db=new DatabaseSync(':memory:');
  const adapter={openDatabaseAsync:async()=>({execAsync:async sql=>db.exec(sql),
    runAsync:async(sql,args=[])=>db.prepare(sql).run(...args),
    getAllAsync:async(sql,args=[])=>db.prepare(sql).all(...args),
    getFirstAsync:async(sql,args=[])=>db.prepare(sql).get(...args)??null})};
  const source=readFileSync(new URL('../src/db/sqlite.ts',import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  const require=(name)=> name==='expo-sqlite'?adapter:compiled.load(name.startsWith('../features/')?
    `src/features/${name.slice('../features/'.length)}.js`:`src/db/${name.slice(2)}.js`);
  vm.runInNewContext(js,{module,exports:module.exports,require,console});
  const native=new module.exports.SqliteSource();
  try{
    await native.ready();await native.importAll(bundle());
    const exported=await native.exportAll();
    assert.equal(exported.version,4);assert.deepEqual(JSON.parse(JSON.stringify(exported.data.packing_kits)),[kit]);
    assert.equal(typeof db.prepare('SELECT requests FROM packing_kit').get().requests,'string');
    for (const bad of [null, [], 'broken JSON', [{item_id:'torch',quantity:0}]]) {
      const broken=bundle();broken.data.packing_kits[0].requests=bad;
      await assert.rejects(native.importAll(broken),/kit inválido/);
      assert.deepEqual(JSON.parse(JSON.stringify((await native.exportAll()).data.packing_kits)),[kit]);
    }
    const incomplete=bundle();delete incomplete.data.packing_kits;
    await assert.rejects(native.importAll(incomplete),/tabla de kits/);
    assert.deepEqual(JSON.parse(JSON.stringify((await native.exportAll()).data.packing_kits)),[kit]);
    await native.clearAll();assert.notEqual((await native.exportAll()).data.packing_kits[0].deleted_at,null);
  }finally{db.close();}
});
