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
  // Plugins another device copied here (#907): not installed until reviewed.
  const incoming=el("div","plugin-list plugin-incoming");incoming.hidden=true;
  overview.append(incoming,list);
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
    info.append(title,meta);if(item.updateAvailable){const update=button(`Review update ${item.updateAvailable}…`,()=>reviewBundled(item.id));update.className="plugin-update";info.append(update);}return info;
  }
  function pluginRow(parent,view,label,control,hint){
    const line=row(parent,`${view.name} · ${label}`,control,hint);
    line.querySelector("label").replaceChildren(el("span","plugin-field-context",`${view.name} · `),document.createTextNode(label));
    return line;
  }
  const base64=async file=>{const bytes=new Uint8Array(await file.arrayBuffer());let text="";for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};

  // Changes (diff) and Source, switched in place rather than hidden in collapsed sections.
  function codeView(preview,m){
    const wrap=el("div","plugin-code"),bar=el("div","plugin-code-bar"),seg=el("div","ag-seg"),view=el("div","plugin-code-view");
    const render=window.AgentRender,files=preview.diff&&render?render.parsePatch(preview.diff):[];
    const sources=Object.entries(preview.source??{"plugin.json":JSON.stringify(m,null,2)});
    const fileHead=(path,extra)=>{const line=el("div","plugin-code-file");line.append(el("span","plugin-code-path",path));if(extra)line.append(extra);return line;};
    const tabs={
      changes:()=>{
        if(!files.length){view.append(preview.diff?el("pre","plugin-source",preview.diff):el("p","plugin-code-empty","No file changes."));return;}
        for(const file of files){const sum=el("span","plugin-code-sum");sum.append(el("span","plugin-code-add",`+${file.added}`),el("span","plugin-code-del",`−${file.removed}`));view.append(fileHead(file.path,sum),render.renderDiffFile(file,{collapsedAfter:300}));}
      },
      source:()=>{
        for(const [path,text] of sources)view.append(fileHead(path),el("pre","plugin-code-text",text));
        if(preview.sourceTruncated)view.append(el("p","plugin-code-empty","Source preview is limited; inspect the original archive for the complete source."));
      },
    };
    const show=key=>{for(const b of seg.children)b.classList.toggle("on",b.dataset.tab===key);view.replaceChildren();view.scrollTop=0;tabs[key]();};
    const tab=(key,label)=>{const b=el("button","ag-seg-btn",label);b.type="button";b.dataset.tab=key;b.addEventListener("click",()=>show(key));seg.append(b);};
    if(preview.previous)tab("changes",files.length?`Changes · ${files.length} ${files.length===1?"file":"files"}`:"Changes");
    tab("source",`Source · ${sources.length} ${sources.length===1?"file":"files"}`);
    bar.append(seg);wrap.append(bar,view);show(preview.previous?"changes":"source");return wrap;
  }

  async function reviewPackage(preview,archive,{allowOlder=false}={}) {
    if(preview.same&&!preview.parts?.settings&&!preview.parts?.state&&!preview.parts?.data)return false;
    if(preview.versionStatus==="older"&&!allowOlder)return false;
    const m=preview.manifest,dialog=el("dialog","confirm plugin-consent"),form=el("form");form.method="dialog";
    let approvePaths=!(preview.parts?.paths?.length);
    const head=el("header","plugin-consent-head"),body=el("div","plugin-consent-body");
    head.append(el("h2","",`${preview.versionStatus==="older"?"Downgrade":preview.previous?"Update":"Install"} ${m.name}?`));
    const version=el("p","plugin-consent-version");version.append(preview.previous?`${preview.previous.version} → `:"",el("strong","",m.version));head.append(version);
    if(m.summary)head.append(el("p","plugin-consent-summary",m.summary));
    form.append(head,body);
    if(m.backend)body.append(el("p","plugin-consent-warn","Runs code on this PC as you."));
    if(preview.previous?.author!==m.author && preview.previous)body.append(el("p","plugin-consent-note","The author differs from the installed package."));
    const customized=preview.previous?.edited||preview.previous?.customized;
    if(customized)body.append(el("p","plugin-consent-note","This plugin may have local source changes. Keep mine leaves them as they are, Take theirs replaces them, and Merge with an agent combines both."));
    // Facts: one labeled row each, so the dialog reads as a list rather than loose paragraphs.
    const facts=el("dl","plugin-consent-facts"),fact=(label,lines)=>{if(!lines.length)return;const dd=el("dd");for(const line of lines)dd.append(el("div","",line));facts.append(el("dt","",label),dd);};
    fact("Access",[...m.access.files.map(folder=>`Files: ${folder}`),...m.access.network.map(host=>`Network: ${host}`)].concat(m.access.files.length||m.access.network.length?[]:["None declared"]));
    const count=(n,word)=>`${n} ${word}${n===1?"":"s"}`;
    fact("Contents",[`${count(m.templates.length,"template")} · ${count(Object.keys(m.methods).length,"method")}`,m.risky?"Resets page grants after agent edits":"Keeps page grants after agent edits"]);
    if(preview.changes){const lines=[];for(const key of ["methods","settings","templates","components"])if(preview.changes[key]?.length)lines.push(`${key[0].toUpperCase()}${key.slice(1)}: ${preview.changes[key].join(", ")}`);if(preview.changes.access)lines.push("Declared file or network access changed");if(preview.changes.risky)lines.push("Page grant reset behavior changed");fact("Changed",lines);}
    if(preview.parts?.state)fact("State",[`Replaces shared state with ${count(preview.parts.stateKeys.length,"imported key")}`]);
    if(preview.parts?.data)fact("Data",[`Replaces the data folder with ${count(preview.parts.dataFiles.length,"imported file")}`]);
    body.append(facts);
    if(preview.parts?.settings)body.append(el("h4","","Imported settings"),el("pre","plugin-source",JSON.stringify(preview.parts.settings,null,2)));
    body.append(codeView(preview,m));
    const controls=el("div","confirm-actions");
    const cancel=el("button","",preview.previous?"Keep mine":"Cancel");cancel.value="cancel";
    const install=el("button","primary",preview.previous?"Take theirs":"Install");install.value="install";
    install.disabled=!approvePaths;
    if(!approvePaths){const paths=el("ul","plugin-consent-paths");for(const item of preview.parts.paths)for(const folder of item.paths)paths.append(el("li","",`${item.label}: ${folder}`));body.append(paths);const allow=button("",()=>{approvePaths=!approvePaths;allow.setAttribute("aria-checked",String(approvePaths));install.disabled=!approvePaths;});allow.className="pill-toggle";allow.setAttribute("role","switch");allow.setAttribute("aria-checked","false");row(body,"Allow imported folders",allow);}
    controls.append(cancel);
    let mergeWith=null;
    if(customized&&window.scribeChat?.pickModel){
      // Pick the merge agent's model from the chat's model menu; the pick closes the dialog.
      const merge=el("button","","Merge with an agent…");merge.type="button";
      merge.addEventListener("click",async()=>{const choice=await window.scribeChat.pickModel(merge,{placeholder:"Model for the merge"});if(choice){mergeWith=choice;dialog.close("merge");}});
      controls.append(merge);
    }
    dialog.addEventListener("cancel",event=>{if(window.scribeChat?.closeMenu?.())event.preventDefault();});
    let copyId;
    if(preview.previous&&preview.previous.author!==m.author){copyId=el("input","ag-input");copyId.value=`${m.id.slice(0,58)}-copy`;row(body,"Copy id",copyId);const copy=el("button","","Install as a renamed copy");copy.value="copy";controls.append(copy);}
    controls.append(install);form.append(controls);dialog.append(form);document.body.append(dialog);dialog.showModal();
    const choice=await new Promise(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue),{once:true}));dialog.remove();
    if(choice==="merge"&&mergeWith){const result=await request("/merge","POST",{archive,id:m.id,...mergeWith});if(result.thread)window.scribeChat?.openThread(result.thread);return false;}
    if(choice==="copy"){const result=await request("/copy","POST",{archive,id:copyId.value});return reviewPackage(result.preview,result.archive);}
    if(choice!=="install")return false;
    await request("/install","POST",{archive,hash:preview.hash,replace:!!preview.previous,approvePaths});return true;
  }
  async function importFile(file){if(file.size>64*1024**2)throw new Error("Plugin packages must be under 64 MiB");const archive=await base64(file),preview=await request("/preview","POST",{archive});const installed=await reviewPackage(preview,archive,{allowOlder:true});await refresh();return installed;}
  async function copyRequest(path,method="GET"){const res=await fetch(`/api/copy/plugins${path}`,{method,cache:"no-store"});const data=await res.json();if(!res.ok)throw new Error(data.error||"Plugin request failed");return data;}
  async function reviewCopied(id){const {preview,archive}=await copyRequest(`/${encodeURIComponent(id)}`);if(await reviewPackage(preview,archive,{allowOlder:true}))await copyRequest(`/${encodeURIComponent(id)}`,"DELETE");await refresh();}
  async function renderIncoming(){
    const {plugins}=await copyRequest("");incoming.hidden=!plugins.length;
    incoming.replaceChildren(...plugins.map(item=>{
      const entry=el("div","plugin-entry setting-row"),info=el("span","plugin-identity"),title=el("span","plugin-name");
      title.append(el("strong","",item.name),el("span","plugin-version",item.version));info.append(title,el("span","plugin-meta",`From ${item.from.name} · not installed`));
      const review=button("Review…",()=>reviewCopied(item.id));
      const dismiss=button("Dismiss",async()=>{await copyRequest(`/${encodeURIComponent(item.id)}`,"DELETE");await refresh();});
      entry.append(pluginMark(),info,review,dismiss);return entry;
    }));
  }
  async function reviewBundled(id){const {preview,archive}=await request(`/${id}/bundled-update`);await reviewPackage(preview,archive);await refresh();}
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
    const controls=el("div","settings-actions"),logs=el("pre","plugin-source");logs.hidden=true;logs.dataset.pluginLogs="";
    const remove=button("Remove",async()=>{if(await confirmRemove(`Remove “${view.name}”? Its source and data stay on disk.`,"Remove")){await request(`/${view.id}`,"DELETE");form.dataset.dirty="false";await refresh();}});remove.classList.add("plugin-remove");
    controls.append(button("Restart",async()=>{await request(`/${view.id}/restart`,"POST",{});await refresh();}),button("Logs",async()=>{const result=await request(`/${view.id}/logs`),current=panels.querySelector(`[data-plugin="${view.id}"] [data-plugin-logs]`);if(current){current.textContent=result.logs.join("\n")||"No backend log yet.";current.hidden=!current.hidden;}}),button("Export…",()=>exportPlugin(view.id)),...(window.scribeCopy?.available()?[copyButton(view.id)]:[]),button("Update from file…",()=>picker.click()),remove);parent.append(controls,logs);
    if(view.readme){const readme=el("details"),summary=el("summary","","README"),text=el("pre","plugin-source",view.readme);readme.dataset.pluginView="readme";readme.append(summary,text);parent.append(readme);}
    const methods=Object.entries(view.methods).filter(([,def])=>def.agent);
    if(methods.length){const methodsView=el("details","plugin-methods");methodsView.dataset.pluginView="methods";methodsView.append(el("summary","","Agent methods"));for(const [name,def]of methods)methodsView.append(el("p","settings-hint",`${name} · ${def.agent} — ${def.description}`));parent.append(methodsView);}
  }
  function copyButton(id){const node=button("Copy to device…",()=>window.scribeCopy.menu(node,{plugins:[id]}));return node;}
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
    try{await renderIncoming().catch(()=>{incoming.hidden=true;});const data=await request("/");enabled.setAttribute("aria-checked",String(data.enabled));
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
      const previousPanels=new Map([...panels.children].map(panel=>[panel.dataset.plugin,panel]));
      const nextViews=views.map(panel=>{
        const previous=previousPanels.get(panel.dataset.plugin);if(!previous)return panel;
        if(previous.querySelector('form[data-dirty="true"]')){previous.querySelector(".plugin-detail-title").replaceChildren(...panel.querySelector(".plugin-detail-title").childNodes);return previous;}
        for(const disclosure of previous.querySelectorAll("details[data-plugin-view]"))panel.querySelector(`details[data-plugin-view="${disclosure.dataset.pluginView}"]`)?.toggleAttribute("open",disclosure.open);
        const oldLogs=previous.querySelector("[data-plugin-logs]"),newLogs=panel.querySelector("[data-plugin-logs]");
        if(oldLogs&&newLogs){newLogs.hidden=oldLogs.hidden;newLogs.textContent=oldLogs.textContent;}
        return panel;
      });
      list.replaceChildren(...entries);panels.replaceChildren(...nextViews);if(!data.plugins.some(item=>item.id===selectedPlugin))selectedPlugin=null;showPlugin(selectedPlugin,{navigate:false});
      if(focused&&document.activeElement!==focused){if(focused.isConnected)focused.focus({preventScroll:true});else{const scope=(focusPanel?panels:list).querySelector(`[data-plugin="${focusPlugin}"]`);const replacement=[...(scope?.querySelectorAll("button,input,textarea")??[])].find(node=>focusLabel?node.getAttribute("aria-label")===focusLabel:node.textContent===focusText);replacement?.focus({preventScroll:true});}}
      if(content)content.scrollTop=scroll;
      if(!data.plugins.length)list.append(el("p","settings-hint","No plugins installed."));status.textContent="";
    }catch(error){status.textContent=error.message;}finally{refreshing=false;if(refreshAgain){refreshAgain=false;await refresh();}finish();}
  }
  window.scribePluginSettings={sections:[section],refresh,importFile,reviewPackage,chooseParts,exportChoices,init({confirm}){if(confirm)confirmRemove=confirm;}};
})();
