(() => {
  "use strict";
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const section=el("section","settings-section plugin-settings");
  section.append(el("h3","","Plugins"));
  const status=el("p","settings-hint");status.setAttribute("role","status");
  const overview=el("div","plugin-overview"),list=el("div","plugin-list"),panels=el("div","plugin-panels");
  let selectedPlugin=null;
  let confirmRemove=async()=>false;
  let controlId=0;
  let toggleFocus=null;
  const button=(text,run)=>{const node=el("button","",text);node.type="button";node.addEventListener("click",()=>Promise.resolve(run()).catch(error=>{status.textContent=error.message;}));return node;};
  const row=(parent,label,control,hint)=>{const line=el("div","setting-row"),text=el("label","",label);if(hint){text.dataset.tooltip=hint;text.setAttribute("aria-description",hint);}control.id||=`plugin-setting-${++controlId}`;text.htmlFor=control.id;control.setAttribute("aria-label",label);line.append(text,control);parent.append(line);return line;};
  const toggle=(value,run)=>{const node=button("",async()=>{const label=document.activeElement===node?node.getAttribute("aria-label"):null;if(label)toggleFocus=label;node.disabled=true;const next=node.getAttribute("aria-checked")!=="true";try{await run(next);node.setAttribute("aria-checked",String(next));await refresh();}finally{node.disabled=false;if(label&&toggleFocus===label){if(document.activeElement===document.body)[...section.querySelectorAll("[aria-label]")].find(control=>control.getAttribute("aria-label")===label)?.focus({preventScroll:true});toggleFocus=null;}}});node.className="pill-toggle";node.setAttribute("role","switch");node.setAttribute("aria-checked",String(value));return node;};
  async function request(path="",method="GET",body){const res=await fetch(`/api/plugins${path}`,{method,headers:body===undefined?{}:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error||"Plugin request failed");return data;}
  const enabled=toggle(true,value=>request("/","PUT",{enabled:value}));
  const enableRow=row(overview,"Enable plugins",enabled,"Off stops every plugin.");enableRow.classList.add("plugin-master");
  overview.append(list);
  const picker=el("input");picker.type="file";picker.accept=".scribeplugin,.zip";picker.hidden=true;
  const actions=el("div","settings-actions plugin-import");actions.append(button("Import plugin…",()=>picker.click()));overview.append(actions);section.append(overview,panels,status,picker);
  function markDrafts(){for(const entry of list.children)entry.classList.toggle("has-draft",!!panels.querySelector(`[data-plugin="${entry.dataset.plugin}"] form[data-dirty="true"]`));}
  function showPlugin(id,{navigate=true}={}){
    selectedPlugin=id;section.classList.toggle("plugin-detail-open",!!id);overview.inert=!!id;
    for(const panel of panels.children){const active=panel.dataset.plugin===id;panel.classList.toggle("is-active",active);panel.inert=!active;panel.setAttribute("aria-hidden",String(!active));}
    if(navigate){
      const target=id?panels.querySelector(`.is-active .plugin-back`):list.querySelector(`[data-plugin="${lastPlugin}"] .plugin-configure`);
      section.closest(".settings-content")?.scrollTo({top:0});target?.focus({preventScroll:true});
    }
    if(id)lastPlugin=id;
    markDrafts();
  }
  let lastPlugin=null;
  const pluginMark=()=>{const node=el("div","plugin-mark","⌁");node.setAttribute("aria-hidden","true");return node;};
  function identity(item){
    const info=el("span","plugin-identity"),title=el("span","plugin-name"),meta=el("span","plugin-meta");
    title.append(el("strong","",item.name),el("span","plugin-version",item.version));
    const state=el("span",`plugin-state${item.edited?" is-edited":item.enabled&&item.status==="running"?" is-running":""}`,item.edited?"edited by agent":!item.enabled?"off":item.status==="idle"?"ready":item.status);
    meta.append(state);if(Number.isInteger(item.pages))meta.append(document.createTextNode(` · ${item.pages} ${item.pages===1?"page":"pages"}`));
    info.append(title,meta);return info;
  }
  function pluginRow(parent,view,label,control,hint){
    const line=row(parent,`${view.name} · ${label}`,control,hint);
    line.querySelector("label").replaceChildren(el("span","plugin-field-context",`${view.name} · `),document.createTextNode(label));
    return line;
  }
  const base64=async file=>{const bytes=new Uint8Array(await file.arrayBuffer());let text="";for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};

  async function reviewPackage(preview,archive,{allowOlder=false}={}) {
    if(preview.same&&!preview.parts?.settings&&!preview.parts?.state&&!preview.parts?.data)return false;
    if(preview.versionStatus==="older"&&!allowOlder)return false;
    const m=preview.manifest,dialog=el("dialog","confirm plugin-consent"),form=el("form");form.method="dialog";
    let approvePaths=!(preview.parts?.paths?.length);
    form.append(el("h2","",`${preview.versionStatus==="older"?"Downgrade":preview.previous?"Update":"Install"} ${m.name} ${m.version}?`),el("p","",m.summary));
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
  async function importFile(file){if(file.size>64*1024**2)throw new Error("Plugin packages must be under 64 MiB");const archive=await base64(file),preview=await request("/preview","POST",{archive});const installed=await reviewPackage(preview,archive,{allowOlder:true});await refresh();return installed;}
  picker.addEventListener("change",()=>{const file=picker.files[0];picker.value="";if(file)importFile(file).catch(error=>{status.textContent=error.message;});});
  async function details(view,parent){
    const form=el("form","ml-source-form"),fields=[];
    for(const [key,field] of Object.entries(view.manifest.settings)){
      let input;
      if(field.type==="boolean"){input=toggle(!!view.settings[key],value=>request(`/${view.id}`,"PUT",{settings:{[key]:value}}));}
      else{input=el(field.type==="paths"?"textarea":"input","ag-input audio-control");if(field.type!=="paths")input.type=field.type==="secret"?"password":field.type==="number"?"number":"text";input.value=field.type==="secret"?"":field.type==="paths"?(view.settings[key]??[]).join("\n"):String(view.settings[key]??"");if(field.type==="secret"){input.autocomplete="new-password";input.placeholder=view.secrets[key]?"Saved (type to replace)":"Not set";}}
      fields.push({key,field,input});pluginRow(form,view,field.label,input,field.description);
      if(field.type==="secret"&&view.secrets[key])form.append(button(`Clear ${field.label}`,async()=>{await request(`/${view.id}`,"PUT",{settings:{[key]:""}});await refresh();}));
    }
    if(view.manifest.backend)pluginRow(form,view,"Keep running",toggle(view.keepAlive,value=>request(`/${view.id}`,"PUT",{keepAlive:value})),"Start with Scribe and keep the backend running between calls.");
    if(fields.some(f=>f.field.type!=="boolean")){
      const save=button("Save settings",async()=>{const settings={};for(const {key,field,input} of fields){if(field.type==="boolean")continue;if(field.type==="secret"&&!input.value)continue;settings[key]=field.type==="number"?Number(input.value):field.type==="paths"?input.value.split("\n").map(v=>v.trim()).filter(Boolean):input.value;}await request(`/${view.id}`,"PUT",{settings});form.dataset.dirty="false";await refresh();});save.classList.add("primary");const saves=el("div","settings-actions plugin-save-actions");saves.append(save,button("Cancel changes",async()=>{form.dataset.dirty="false";await refresh();}));form.append(saves);
    }
    form.addEventListener("input",()=>{form.dataset.dirty="true";markDrafts();});
    form.addEventListener("submit",event=>event.preventDefault());parent.append(form);
    const controls=el("div","settings-actions"),logs=el("pre","plugin-source");logs.hidden=true;
    const remove=button("Remove",async()=>{if(await confirmRemove(`Remove “${view.name}”? Its source and data stay on disk.`,"Remove")){await request(`/${view.id}`,"DELETE");form.dataset.dirty="false";await refresh();}});remove.classList.add("plugin-remove");
    controls.append(button("Restart",async()=>{await request(`/${view.id}/restart`,"POST",{});await refresh();}),button("Logs",async()=>{logs.textContent=(await request(`/${view.id}/logs`)).logs.join("\n")||"No backend log yet.";logs.hidden=!logs.hidden;}),button("Export…",()=>exportPlugin(view.id)),button("Update from file…",()=>picker.click()),remove);parent.append(controls,logs);
    if(view.readme){const readme=el("details"),summary=el("summary","","README"),text=el("pre","plugin-source",view.readme);readme.append(summary,text);parent.append(readme);}
    const methods=Object.entries(view.methods).filter(([,def])=>def.agent);
    if(methods.length){const methodsView=el("details","plugin-methods");methodsView.append(el("summary","","Agent methods"));for(const [name,def]of methods)methodsView.append(el("p","settings-hint",`${name} · ${def.agent} — ${def.description}`));parent.append(methodsView);}
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
  let refreshing=false,refreshAgain=false,refreshDone=Promise.resolve();
  async function refresh(){
    if(refreshing){refreshAgain=true;return refreshDone;}refreshing=true;
    let finish;refreshDone=new Promise(resolve=>{finish=resolve;});
    try{const data=await request("/");enabled.setAttribute("aria-checked",String(data.enabled));
      const entries=[],views=[];
      for(const item of data.plugins){
        const view=await request(`/${item.id}`),entry=el("div","plugin-entry setting-row");entry.dataset.plugin=item.id;
        const configure=button("",()=>showPlugin(item.id));configure.className="plugin-configure";configure.setAttribute("aria-label",`Settings for ${item.name}`);configure.dataset.tooltip=`Settings for ${item.name}`;
        configure.innerHTML='<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M3.6 12.4l1.35-1.35M11.05 4.95l1.35-1.35" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
        const on=toggle(item.configuredEnabled??item.enabled,value=>request(`/${item.id}`,"PUT",{enabled:value}));on.setAttribute("aria-label",`Enable ${item.name}`);
        on.id=`plugin-setting-${++controlId}`;const label=el("label","plugin-field-context",item.name);label.htmlFor=on.id;
        entry.append(pluginMark(),label,identity(item),configure,on);entries.push(entry);
        const panel=el("div","plugin-panel");panel.dataset.plugin=item.id;
        const header=el("div","plugin-detail-header"),back=button("‹ Plugins",()=>showPlugin(null));back.className="plugin-back";
        const heading=el("div","plugin-detail-title");heading.append(pluginMark(),identity(item));header.append(back,heading);panel.append(header);
        await details(view,panel);views.push(panel);
      }
      const focused=section.contains(document.activeElement)?document.activeElement:document.activeElement===document.body&&toggleFocus?[...section.querySelectorAll("[aria-label]")].find(control=>control.getAttribute("aria-label")===toggleFocus):null;
      const focusLabel=focused?.getAttribute("aria-label"),focusText=focused?.textContent,focusPlugin=focused?.closest("[data-plugin]")?.dataset.plugin,focusPanel=!!focused?.closest(".plugin-panel");
      const content=section.closest(".settings-content"),scroll=content?.scrollTop;
      const drafts=new Map([...panels.children].filter(panel=>panel.querySelector('form[data-dirty="true"]')).map(panel=>[panel.dataset.plugin,panel]));
      const nextViews=views.map(panel=>{const draft=drafts.get(panel.dataset.plugin);if(!draft)return panel;draft.querySelector(".plugin-detail-title").replaceChildren(...panel.querySelector(".plugin-detail-title").childNodes);return draft;});
      list.replaceChildren(...entries);panels.replaceChildren(...nextViews);if(!data.plugins.some(item=>item.id===selectedPlugin))selectedPlugin=null;showPlugin(selectedPlugin,{navigate:false});
      if(focused&&document.activeElement!==focused){if(focused.isConnected)focused.focus({preventScroll:true});else{const scope=(focusPanel?panels:list).querySelector(`[data-plugin="${focusPlugin}"]`);const replacement=[...(scope?.querySelectorAll("button,input,textarea")??[])].find(node=>focusLabel?node.getAttribute("aria-label")===focusLabel:node.textContent===focusText);replacement?.focus({preventScroll:true});}}
      if(content)content.scrollTop=scroll;
      if(!data.plugins.length)list.append(el("p","settings-hint","No plugins installed."));status.textContent="";
    }catch(error){status.textContent=error.message;}finally{refreshing=false;if(refreshAgain){refreshAgain=false;await refresh();}finish();}
  }
  window.scribePluginSettings={sections:[section],refresh,importFile,reviewPackage,chooseParts,exportChoices,init({confirm}){if(confirm)confirmRemove=confirm;}};
})();
