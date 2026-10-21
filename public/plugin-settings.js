(() => {
  "use strict";
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const section=el("section","settings-section plugin-settings");
  section.append(el("h3","","Plugins"));
  const status=el("p","settings-hint");status.setAttribute("role","status");
  const list=el("div","ml-sources");
  let confirmRemove=async()=>false;
  const button=(text,run)=>{const node=el("button","",text);node.type="button";node.addEventListener("click",()=>Promise.resolve(run()).catch(error=>{status.textContent=error.message;}));return node;};
  const row=(parent,label,control,hint)=>{const line=el("div","setting-row"),text=el("label","",label);if(hint){text.dataset.tooltip=hint;text.setAttribute("aria-description",hint);}control.setAttribute("aria-label",label);line.append(text,control);parent.append(line);return line;};
  const toggle=(value,run)=>{const node=button("",async()=>{node.disabled=true;try{await run(node.getAttribute("aria-checked")!=="true");await refresh();}finally{node.disabled=false;}});node.className="pill-toggle";node.setAttribute("role","switch");node.setAttribute("aria-checked",String(value));return node;};
  async function request(path="",method="GET",body){const res=await fetch(`/api/plugins${path}`,{method,headers:body===undefined?{}:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error||"Plugin request failed");return data;}
  const enabled=toggle(true,value=>request("/","PUT",{enabled:value}));
  row(section,"Enable plugins",enabled);
  section.append(list);
  const picker=el("input");picker.type="file";picker.accept=".scribeplugin,.zip";picker.hidden=true;
  const actions=el("div","settings-actions");actions.append(button("Import plugin…",()=>picker.click()),picker);section.append(actions,status);
  const base64=async file=>{const bytes=new Uint8Array(await file.arrayBuffer());let text="";for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};

  async function reviewPackage(preview,archive) {
    const m=preview.manifest,dialog=el("dialog","confirm plugin-consent"),form=el("form");form.method="dialog";
    let approvePaths=!(preview.parts?.paths?.length);
    form.append(el("h2","",`${preview.previous?"Update":"Install"} ${m.name} ${m.version}?`),el("p","",m.summary));
    if(m.backend)form.append(el("p","permission-ask-what","Runs code on this PC as you."));
    if(preview.previous?.author!==m.author && preview.previous)form.append(el("p","settings-hint","The author differs from the installed package."));
    if(preview.previous?.edited)form.append(el("p","settings-hint","This plugin has local source edits. Keep mine preserves them; Take theirs replaces the installed version."));
    const access=el("ul");for(const folder of m.access.files)access.append(el("li","",`Files: ${folder}`));for(const host of m.access.network)access.append(el("li","",`Network: ${host}`));
    form.append(access,el("p","",`${m.templates.length} templates · ${Object.keys(m.methods).length} methods · ${m.risky?"resets page grants after agent edits":"keeps page grants after agent edits"}`));
    if(preview.changes){const changes=el("ul");for(const key of ["methods","settings","templates"])if(preview.changes[key]?.length)changes.append(el("li","",`${key}: ${preview.changes[key].join(", ")}`));if(preview.changes.access)changes.append(el("li","","Declared file or network access changed."));if(preview.changes.risky)changes.append(el("li","","Page grant reset behavior changed."));form.append(changes);}
    const source=el("details"),summary=el("summary","","View source"),code=el("pre","plugin-source");
    code.textContent=Object.entries(preview.source??{"plugin.json":JSON.stringify(m,null,2)}).map(([path,text])=>`${path}\n${text}`).join("\n\n");source.append(summary,code);form.append(source);
    if(preview.sourceTruncated)source.append(el("p","settings-hint","Source preview is limited; inspect the original archive for the complete source."));
    if(preview.diff){const diff=el("details"),label=el("summary","","View diff");diff.append(label,el("pre","plugin-source",preview.diff));form.append(diff);}
    if(preview.parts?.settings)form.append(el("h4","","Imported settings"),el("pre","plugin-source",JSON.stringify(preview.parts.settings,null,2)));
    if(preview.parts?.state)form.append(el("p","",`Replace shared state with ${preview.parts.stateKeys.length} imported keys.`));
    if(preview.parts?.data)form.append(el("p","",`Replace the data folder with ${preview.parts.dataFiles.length} imported files.`));
    const controls=el("div","confirm-actions");
    const cancel=el("button","",preview.previous?"Keep mine":"Cancel");cancel.value="cancel";
    const install=el("button","primary",preview.previous?"Take theirs":"Install");install.value="install";
    install.disabled=!approvePaths;
    if(!approvePaths){const paths=el("ul");for(const item of preview.parts.paths)for(const folder of item.paths)paths.append(el("li","",`${item.label}: ${folder}`));form.append(paths);const allow=button("",()=>{approvePaths=!approvePaths;allow.setAttribute("aria-checked",String(approvePaths));install.disabled=!approvePaths;});allow.className="pill-toggle";allow.setAttribute("role","switch");allow.setAttribute("aria-checked","false");row(form,"Allow imported folders",allow);}
    controls.append(cancel);
    if(preview.previous?.edited){const merge=el("button","","Merge with an agent");merge.value="merge";controls.append(merge);}
    let copyId;
    if(preview.previous&&preview.previous.author!==m.author){copyId=el("input","ag-input");copyId.value=`${m.id.slice(0,58)}-copy`;row(form,"Copy id",copyId);const copy=el("button","","Install as a renamed copy");copy.value="copy";controls.append(copy);}
    controls.append(install);form.append(controls);dialog.append(form);document.body.append(dialog);dialog.showModal();
    const choice=await new Promise(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue),{once:true}));dialog.remove();
    if(choice==="merge"){const result=await request("/merge","POST",{archive,id:m.id});if(result.thread)window.scribeChat?.openThread(result.thread);return false;}
    if(choice==="copy"){const result=await request("/copy","POST",{archive,id:copyId.value});return reviewPackage(result.preview,result.archive);}
    if(choice!=="install")return false;
    await request("/install","POST",{archive,hash:preview.hash,replace:!!preview.previous,approvePaths});return true;
  }
  async function importFile(file){if(file.size>64*1024**2)throw new Error("Plugin packages must be under 64 MiB");const archive=await base64(file),preview=await request("/preview","POST",{archive});const installed=await reviewPackage(preview,archive);await refresh();return installed;}
  picker.addEventListener("change",()=>{const file=picker.files[0];picker.value="";if(file)importFile(file).catch(error=>{status.textContent=error.message;});});
  async function details(view,parent){
    const form=el("form","ml-source-form"),fields=[];
    for(const [key,field] of Object.entries(view.manifest.settings)){
      let input;
      if(field.type==="boolean"){input=toggle(!!view.settings[key],value=>request(`/${view.id}`,"PUT",{settings:{[key]:value}}));}
      else{input=el(field.type==="paths"?"textarea":"input","ag-input audio-control");if(field.type!=="paths")input.type=field.type==="secret"?"password":field.type==="number"?"number":"text";input.value=field.type==="secret"?"":field.type==="paths"?(view.settings[key]??[]).join("\n"):String(view.settings[key]??"");if(field.type==="secret"){input.autocomplete="new-password";input.placeholder=view.secrets[key]?"Saved (type to replace)":"Not set";}}
      fields.push({key,field,input});row(form,`${view.name} · ${field.label}`,input,field.description);
      if(field.type==="secret"&&view.secrets[key])form.append(button(`Clear ${field.label}`,async()=>{await request(`/${view.id}`,"PUT",{settings:{[key]:""}});await refresh();}));
    }
    if(view.manifest.backend)row(form,`${view.name} · Keep running`,toggle(view.keepAlive,value=>request(`/${view.id}`,"PUT",{enabled:view.enabled,keepAlive:value})),"Start with Scribe and keep the backend running between calls.");
    if(fields.some(f=>f.field.type!=="boolean")){
      const save=button("Save settings",async()=>{const settings={};for(const {key,field,input} of fields){if(field.type==="boolean")continue;if(field.type==="secret"&&!input.value)continue;settings[key]=field.type==="number"?Number(input.value):field.type==="paths"?input.value.split("\n").map(v=>v.trim()).filter(Boolean):input.value;}await request(`/${view.id}`,"PUT",{settings});await refresh();});form.append(save);
    }
    form.addEventListener("submit",event=>event.preventDefault());parent.append(form);
    const controls=el("div","settings-actions"),logs=el("pre","plugin-source");logs.hidden=true;
    controls.append(button("Restart",async()=>{await request(`/${view.id}/restart`,"POST",{});await refresh();}),button("Logs",async()=>{logs.textContent=(await request(`/${view.id}/logs`)).logs.join("\n")||"No backend log yet.";logs.hidden=!logs.hidden;}),button("Export…",()=>exportPlugin(view.id)),button("Update from file…",()=>picker.click()),button("Remove",async()=>{if(await confirmRemove(`Remove “${view.name}”? Its source and data stay on disk.`,"Remove")){await request(`/${view.id}`,"DELETE");await refresh();}}));parent.append(controls,logs);
    if(view.readme){const readme=el("details"),summary=el("summary","","README"),text=el("pre","plugin-source",view.readme);readme.append(summary,text);parent.append(readme);}
    const methods=Object.entries(view.methods).filter(([,def])=>def.agent);
    if(methods.length){parent.append(el("h4","","Agent methods"));for(const [name,def]of methods)parent.append(el("p","settings-hint",`${name} · ${def.agent} — ${def.description}`));}
  }
  async function exportPlugin(id){const parts=await chooseParts();if(!parts)return;const query=new URLSearchParams(parts),link=el("a");link.href=`/api/plugins/${id}/export?${query}`;link.download="";document.body.append(link);link.click();link.remove();}
  async function chooseParts(){
    const dialog=el("dialog","confirm"),form=el("form");form.method="dialog";form.append(el("h2","","Export plugin"));
    const selected={source:true,settings:false,state:false,data:false};
    row(form,"Code",el("span","","Included"));
    for(const [key,label,hint]of [["source","Source","Editable source for agents on the receiving PC."],["settings","Settings","Configuration values; secrets are excluded."],["state","State","Shared keyed state used by this plugin's pages."],["data","Data folder","Private database and caches. Stop the backend first."]]){
      const control=button("",()=>{selected[key]=!selected[key];control.setAttribute("aria-checked",String(selected[key]));});control.className="pill-toggle";control.setAttribute("role","switch");control.setAttribute("aria-checked",String(selected[key]));row(form,label,control,hint);
    }
    const actions=el("div","confirm-actions"),cancel=el("button","","Cancel"),save=el("button","primary","Export");cancel.value="cancel";save.value="export";actions.append(cancel,save);form.append(actions);dialog.append(form);document.body.append(dialog);dialog.showModal();const result=await new Promise(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue==="export"?selected:null),{once:true}));dialog.remove();return result;
  }
  async function exportChoices(plugins){
    const dialog=el("dialog","confirm"),form=el("form");form.method="dialog";form.append(el("h2","","Export pages with plugins"));
    const selects=new Map();
    for(const plugin of plugins){
      const select=el("select");select.multiple=true;
      for(const [value,label,hint]of [["code","Code","Runnable backend, templates, manifest and guide. Required with any other part."],["source","Source","Editable source for an agent on another PC."],["settings","Settings","Configuration values, excluding secrets."],["state","State","Shared keyed plugin state."],["data","Data folder","Private database and caches; stop the backend first."]]){
        const option=el("option","",label);option.value=value;option.selected=value==="code"||value==="source";option.dataset.tooltip=hint;select.append(option);
      }
      let hadCode=true;
      select.addEventListener("change",()=>{
        if(hadCode&&!select.options[0].selected)for(const option of select.options)option.selected=false;
        else if([...select.options].some(option=>option.selected))select.options[0].selected=true;
        hadCode=select.options[0].selected;select.parentElement.syncSelect?.();
      });
      row(form,`${plugin.name} ${plugin.version}`,select);window.createSelect(select);selects.set(plugin.id,select);
    }
    const actions=el("div","confirm-actions"),cancel=el("button","","Cancel"),save=el("button","primary","Export");cancel.value="cancel";save.value="export";actions.append(cancel,save);form.append(actions);dialog.append(form);document.body.append(dialog);dialog.showModal();
    const choice=await new Promise(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue),{once:true}));dialog.remove();
    return choice==="export"?Object.fromEntries([...selects].map(([id,select])=>[id,Object.fromEntries([...select.options].map(option=>[option.value,option.selected]))])):null;
  }
  async function refresh(){
    try{const data=await request("/");enabled.setAttribute("aria-checked",String(data.enabled));const open=new Set([...list.querySelectorAll("details[open]")].map(n=>n.dataset.plugin));list.replaceChildren();
      for(const item of data.plugins){const entry=el("details","plugin-entry");entry.dataset.plugin=item.id;entry.open=open.has(item.id);const summary=el("summary","setting-row"),name=el("span","ml-source-text",`${item.name} ${item.version} · ${item.enabled?item.status:"off"}${item.edited?" · edited":""}`),on=toggle(item.enabled,value=>request(`/${item.id}`,"PUT",{enabled:value}));on.addEventListener("click",event=>event.preventDefault());on.setAttribute("aria-label",`Enable ${item.name}`);summary.append(name,on);entry.append(summary);list.append(entry);await details(await request(`/${item.id}`),entry);}
      if(!data.plugins.length)list.append(el("p","settings-hint","No plugins installed."));status.textContent="";
    }catch(error){status.textContent=error.message;}
  }
  window.scribePluginSettings={sections:[section],refresh,importFile,reviewPackage,chooseParts,exportChoices,init({confirm}){if(confirm)confirmRemove=confirm;}};
})();
