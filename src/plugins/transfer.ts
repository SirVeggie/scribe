import type { BoardExportFile } from "../boardExport.js";
import { parseImport } from "../boardExport.js";
import { declaredPlugins } from "./manifest.js";
import { MAX_IMPORT_BYTES } from "../config.js";
import type { PluginService, ExportParts } from "./service.js";
import { zip, unzip, type PackageFiles } from "./package.js";

export type PluginExportChoice = ExportParts & {code?:boolean};
export type TransferManifest = BoardExportFile & {plugins?:Array<{id:string;version:string;path?:string}>};
export async function exportTransfer(file: BoardExportFile, service: PluginService, choices: Record<string,PluginExportChoice> = {}): Promise<Buffer> {
  const files:PackageFiles=Object.create(null), dependencies=new Map<string,string>();
  const pages=file.pages.map(page=>{
    const requires=declaredPlugins(page.html).map(id=>{
      let version="*";try{version=service.get(id).manifest.version;}catch{}
      dependencies.set(id,version);return {id,version};
    });
    return {...page,...(requires.length?{requires}:{})};
  });
  const plugins=[];
  for(const template of file.templates)for(const id of declaredPlugins(template.html))if(!dependencies.has(id)){let version="*";try{version=service.get(id).manifest.version;}catch{}dependencies.set(id,version);}
  for(const [id,version]of dependencies){
    const choice=choices[id]??{code:true,source:true};
    if(choice.code===false&&(choice.source||choice.settings||choice.state||choice.data))throw new Error("Code must be included when exporting other plugin parts");
    let archivePath: string | undefined;
    if(choice.code!==false && version!=="*"){
      archivePath=`plugins/${id}.scribeplugin`;files[archivePath]=service.export(id,choice);
    }
    plugins.push({id,version,...(archivePath?{path:archivePath}:{})});
  }
  files["scribe.json"]=Buffer.from(JSON.stringify({...file,pages,plugins}));
  return zip(files);
}
export async function importTransfer(bytes:Buffer,filename:string) {
  if(bytes.length<2||bytes.readUInt16LE(0)!==0x4b50)return {parsed:parseImport(bytes,filename),packages:[] as Array<{id:string;archive:Buffer;files:PackageFiles}>};
  const files=await unzip(bytes,MAX_IMPORT_BYTES);
  if(files["plugin.json"] && !files["scribe.json"])return {parsed:null,packages:[{id:JSON.parse(files["plugin.json"].toString()).id,archive:bytes,files}]};
  if(!files["scribe.json"])throw new Error("Archive has no scribe.json or plugin.json");
  const metadata=JSON.parse(files["scribe.json"].toString("utf8")) as TransferManifest;
  const packages=[];
  for(const plugin of metadata.plugins??[]){
    if(!plugin.path)continue;
    const archive=files[plugin.path];if(!archive)throw new Error(`Missing embedded plugin: ${plugin.id}`);
    const content=await unzip(archive);const manifest=JSON.parse(content["plugin.json"].toString());
    if(manifest.id!==plugin.id)throw new Error("Embedded plugin id differs from export metadata");
    packages.push({id:plugin.id,archive,files:content});
  }
  return {parsed:parseImport(files["scribe.json"],"scribe.json"),packages};
}
