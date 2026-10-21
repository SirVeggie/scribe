/** Standalone Node child. stdout is reserved for RPC; plugin console output goes to stderr. */
export const runnerSource = String.raw`
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import util from 'node:util';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for (const name of ['log','info','warn','error','debug']) console[name] = (...args) => process.stderr.write(util.format(...args) + '\n');
let backend, config, database, seq = 0;
const pending = new Map();
const rpc = (method, params) => new Promise((resolve,reject) => {
  const id = 'child:' + (++seq); pending.set(id,{resolve,reject}); send({id,method,params});
});
const lines = createInterface({input:process.stdin, crlfDelay:Infinity});
lines.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && !msg.method) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); } return; }
  try {
    let result;
    if (msg.method === 'init') {
      config = msg.params;
      const module = await import(pathToFileURL(config.entry).href);
      backend = module.default ?? module;
      if (backend.start) await backend.start(context({kind:'system'}));
      result = true;
    } else if (msg.method === 'call') {
      const {method,args,caller} = msg.params;
      const fn = backend.methods?.[method];
      if (typeof fn !== 'function') throw new Error('Backend method not found: ' + method);
      result = await fn(args ?? {}, context(caller));
    } else if (msg.method === 'hook') {
      const {template,hook,args,caller} = msg.params;
      const set = backend.templates?.[template];
      const fn = hook.startsWith('action:') ? set?.actions?.[hook.slice(7)] : set?.[hook];
      if (typeof fn !== 'function') throw new Error('Template hook not found: ' + hook);
      result = await fn(...args, context(caller));
    } else throw new Error('Unknown RPC method');
    send({id:msg.id,result:result ?? null});
  } catch (error) { send({id:msg.id,error:String(error?.message ?? error)}); }
});
function context(caller) {
  return {
    settings: config.settings, dataDir:config.dataDir, caller,
    secret: name => rpc('secret',{name}),
    state: {get:key => rpc('state.get',{key}), set:(key,value) => rpc('state.set',{key,value})},
    emit: (name,data) => rpc('emit',{name,data}),
    saveAsset: (name,mimeType,data) => rpc('asset',{page:caller.page,name,mimeType,data:Buffer.from(data).toString('base64')}),
    db: () => database ??= new DatabaseSync(path.join(config.dataDir,'plugin.sqlite')),
  };
}
process.stdin.on('end', () => process.exit(0));
`;
