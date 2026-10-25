// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {DatabaseSync} from 'node:sqlite';

/** Private local text transcript. Images remain in the separately bounded RAM history. */
export function createPiContextStore({path}){
 const db=new DatabaseSync(path);
 db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS pi_context(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)');
 const validScope=scope=>{if(typeof scope!=='string'||scope.length>1000)throw new Error('invalid_pi_scope');};
 return {
  load(scope){validScope(scope);const row=db.prepare('SELECT payload FROM pi_context WHERE scope=?').get(scope);return row?JSON.parse(row.payload):null;},
  save(scope,value){
   validScope(scope);
   const payload=JSON.stringify(value,(_key,item)=>{if(item?.type==='image')throw new Error('pi_images_are_ram_only');return item;});
   if(Buffer.byteLength(payload)>1500000)throw new Error('pi_context_storage_limit');
   db.prepare('INSERT INTO pi_context(scope,payload) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload').run(scope,payload);
  },
  close(){db.close();}
 };
}
