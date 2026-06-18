,Pu("sitecode",async (u)=>{
  const bvH=(tag,props,...kids)=>{
    let el=document.createElement(tag);
    if(props)for(let k in props){
      if(k==="class")el.className=props[k];
      else if(k==="style")el.setAttribute("style",props[k]);
      else if(k.slice(0,2)==="on"&&typeof props[k]==="function")el.addEventListener(k.slice(2),props[k]);
      else if(props[k]!=null)el.setAttribute(k,props[k]);
    }
    for(let c of kids){if(c==null)continue;el.appendChild(typeof c==="string"?document.createTextNode(c):c);}
    return el;
  };
  const b64=(buf)=>{let b=new Uint8Array(buf),CH=0x8000,parts=[];for(let i=0;i<b.length;i+=CH)parts.push(String.fromCharCode.apply(null,b.subarray(i,i+CH)));return btoa(parts.join(""));};
  const fmt=(n)=>n<1024?n+" B":n<1048576?(n/1024).toFixed(1)+" KB":(n/1048576).toFixed(1)+" MB";
  const api=async(method,path,body)=>{
    let id=Mu(),token=id?await ce(id):null,headers={};
    if(token)headers.authorization="Bearer "+token;
    let opts={method,headers};
    if(body!==undefined){headers["content-type"]="application/json";opts.body=JSON.stringify(body);}
    let r;try{r=await fetch(path,opts);}catch(e){return{ok:false,status:0,data:{error:"network"}};}
    let data={};try{data=await r.json();}catch(e){}
    return{ok:r.ok,status:r.status,data};
  };
  const claimErr=(code,data)=>code==="invalid_handle"?"That handle is not allowed (3-32 chars; letters, numbers, hyphens; not a reserved word).":code==="handle_taken"?"That handle is already taken.":code==="already_have_site"?("You already have a site: "+(data.handle||"")):("Could not create site ("+(code||"error")+").");
  const insertAtCursor=(ta,text)=>{let s=ta.selectionStart||0,e=ta.selectionEnd||0,v=ta.value;ta.value=v.slice(0,s)+text+v.slice(e);let p=s+text.length;ta.selectionStart=ta.selectionEnd=p;ta.focus();};
  const BLOCKS=[
    {name:"Heading",html:"\n<h2>Section heading</h2>\n"},
    {name:"Paragraph",html:"\n<p>Your text goes here.</p>\n"},
    {name:"Image",html:'\n<img src="image.png" alt="Describe the image" style="max-width:100%;height:auto">\n'},
    {name:"Button / link",html:'\n<a href="https://example.com" style="display:inline-block;padding:.6rem 1.2rem;background:var(--accent,#2563eb);color:#fff;border-radius:.5rem;text-decoration:none;font-weight:600">Click here</a>\n'},
    {name:"Link list",html:'\n<ul>\n  <li><a href="https://example.com">Link one</a></li>\n  <li><a href="https://example.com">Link two</a></li>\n</ul>\n'},
    {name:"Divider",html:"\n<hr>\n"},
    {name:"Two columns",html:'\n<div style="display:flex;gap:1rem;flex-wrap:wrap">\n  <div style="flex:1;min-width:12rem">Left column</div>\n  <div style="flex:1;min-width:12rem">Right column</div>\n</div>\n'},
    {name:"Card",html:'\n<div style="border:1px solid #ddd;border-radius:.6rem;padding:1rem;margin:.5rem 0">\n  <h3 style="margin-top:0">Card title</h3>\n  <p>Card text.</p>\n</div>\n'},
    {name:"Contact block",html:'\n<p>Email: you@example.com<br>Phone: (555) 555-5555</p>\n'},
    {name:"Spacer",html:'\n<div style="height:2rem"></div>\n'}
  ];

  let root=document.createElement("section");
  root.className="bv-site";
  root.setAttribute("style","max-width:64rem;margin:0 auto;padding:1rem");
  u.appendChild(root);
  if(!Mu()){
    let p=bvH("p",null,"Please ");
    p.appendChild(bvH("a",{href:"#/login"},"sign in"));
    p.appendChild(document.createTextNode(" to create your website."));
    root.appendChild(p);
    return root;
  }
  root.appendChild(bvH("a",{href:"#/site",style:"display:inline-block;margin-bottom:.4rem;font-size:.9rem;color:var(--accent,#2563eb);text-decoration:none"},"← Back to the visual builder"));
  root.appendChild(bvH("h1",{style:"margin-top:0"},"Edit code (Advanced)"));
  root.appendChild(bvH("p",{style:"color:#666;margin:.2rem 0 .6rem;font-size:.9rem"},"Direct HTML/CSS and file editing. For most things the visual builder is easier — use the link above."));
  let statusEl=bvH("div",{style:"margin:.5rem 0;color:#666"},"Loading...");
  let bodyEl=bvH("div",null);
  root.appendChild(statusEl);root.appendChild(bodyEl);

  const renderClaim=()=>{
    let form=bvH("div",{style:"display:flex;flex-direction:column;gap:.75rem;max-width:30rem"});
    form.appendChild(bvH("p",null,"Pick a handle for your free website. It will live at:"));
    let preview=bvH("code",{style:"font-size:1.05rem"},"your-handle.yourdomain.com");
    form.appendChild(preview);
    let input=bvH("input",{type:"text",placeholder:"your-handle",maxlength:"32",autocapitalize:"none",autocorrect:"off",spellcheck:"false",style:"padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:.4rem"});
    input.addEventListener("input",()=>{let v=input.value.toLowerCase().replace(/[^a-z0-9-]/g,"");input.value=v;preview.textContent=(v||"your-handle")+".yourdomain.com";});
    form.appendChild(input);
    let msg=bvH("div",{style:"min-height:1.2rem;color:#b00"});
    let btn=bvH("button",{type:"button",style:"padding:.6rem 1rem;font-size:1rem;border-radius:.4rem;cursor:pointer"},"Create my site");
    btn.addEventListener("click",async()=>{
      let handle=input.value.trim().toLowerCase();
      if(handle.length<3){msg.style.color="#b00";msg.textContent="Handle must be at least 3 characters.";return;}
      btn.disabled=true;msg.style.color="#666";msg.textContent="Creating...";
      let r=await api("POST","/api/sites/claim",{handle});
      btn.disabled=false;
      if(r.ok){await refresh();}else{msg.style.color="#b00";msg.textContent=claimErr(r.data.error,r.data);}
    });
    form.appendChild(btn);form.appendChild(msg);
    bodyEl.appendChild(form);
  };

  const renderManage=async(me)=>{
    let url=me.url||("https://"+me.handle+".yourdomain.com/");
    let ed={ta:null,path:null};

    // containers (created up front so the functions below can close over them)
    let listWrap=bvH("div",{style:"flex:1 1 14rem;min-width:12rem"});
    let editWrap=bvH("div",{style:"flex:2 1 26rem;min-width:18rem"});

    const openFile=async(pth)=>{
      ed.path=pth;editWrap.replaceChildren();
      let r=await api("GET","/api/sites/file?path="+encodeURIComponent(pth));
      if(!r.ok){ed.ta=null;editWrap.appendChild(bvH("p",{style:"color:#b00"},"Could not open "+pth));return;}
      if(r.data.binary){ed.ta=null;editWrap.appendChild(bvH("p",null,"Binary file ("+fmt(r.data.bytes)+") - not editable here."));return;}
      editWrap.appendChild(bvH("div",{style:"font-weight:700;margin-bottom:.4rem"},pth));
      let ta=bvH("textarea",{spellcheck:"false",style:"width:100%;min-height:24rem;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem;padding:.6rem;border:1px solid #ccc;border-radius:.4rem;box-sizing:border-box"});
      ta.value=r.data.text||"";ed.ta=ta;
      editWrap.appendChild(ta);
      let saveMsg=bvH("span",{style:"margin-left:.6rem;color:#666"});
      let save=bvH("button",{type:"button",style:"margin-top:.5rem;padding:.5rem .9rem;cursor:pointer;border-radius:.4rem"},"Save");
      save.addEventListener("click",async()=>{save.disabled=true;saveMsg.style.color="#666";saveMsg.textContent="Saving...";let s=await api("PUT","/api/sites/file",{path:pth,text:ta.value});save.disabled=false;if(s.ok){saveMsg.style.color="#070";saveMsg.textContent="Saved. Publish to go live.";loadList();}else{saveMsg.style.color="#b00";saveMsg.textContent="Error: "+(s.data.error||s.status);}});
      editWrap.appendChild(bvH("div",null,save,saveMsg));
    };
    const loadList=async()=>{
      listWrap.replaceChildren();
      listWrap.appendChild(bvH("div",{style:"font-weight:700;margin-bottom:.4rem"},"Files"));
      let t=await api("GET","/api/sites/tree");
      let files=(t.ok&&t.data.files)?t.data.files:[];
      files.sort((a,b)=>a.path<b.path?-1:1);
      if(!files.length){listWrap.appendChild(bvH("p",{style:"color:#666"},"No files yet."));return;}
      for(let f of files){
        let row=bvH("div",{style:"display:flex;justify-content:space-between;align-items:center;gap:.4rem;padding:.15rem 0"});
        let name=bvH("button",{type:"button",title:f.path,style:"flex:1;min-width:0;text-align:left;background:none;border:none;color:var(--accent,#2563eb);cursor:pointer;padding:.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"},f.path);
        name.addEventListener("click",()=>openFile(f.path));
        let size=bvH("span",{style:"color:#999;font-size:.78rem;white-space:nowrap"},fmt(f.bytes));
        let del=bvH("button",{type:"button",title:"Delete "+f.path,style:"background:none;border:none;color:#b00;cursor:pointer"},"Delete");
        del.addEventListener("click",async()=>{if(!confirm("Delete "+f.path+"?"))return;let d=await api("DELETE","/api/sites/file",{path:f.path});if(d.ok){loadList();if(ed.path===f.path){editWrap.replaceChildren();ed.ta=null;}}});
        row.appendChild(name);row.appendChild(size);row.appendChild(del);listWrap.appendChild(row);
      }
    };

    // ---- header ----
    let head=bvH("div",{style:"display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;margin-bottom:.5rem"});
    head.appendChild(bvH("div",null,bvH("div",{style:"font-size:1.1rem;font-weight:700"},me.handle+".yourdomain.com"),bvH("a",{href:url,target:"_blank",rel:"noopener",style:"font-size:.9rem"},"Open site")));
    let usage=me.usage||{files:0,bytes:0};
    head.appendChild(bvH("div",{style:"font-size:.85rem;color:#666;text-align:right"},(me.published_at?"Published":"Not published yet"),bvH("br"),usage.files+" file(s), "+fmt(usage.bytes)));
    bodyEl.appendChild(head);

    let toolMsg=bvH("span",{style:"color:#666"});

    // ---- top actions: template picker + publish ----
    let actions=bvH("div",{style:"display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.4rem"});
    let tplSel=bvH("select",{style:"padding:.45rem;border-radius:.4rem;border:1px solid #ccc;max-width:18rem"});
    tplSel.appendChild(bvH("option",{value:""},"Start from a template..."));
    let tplApply=bvH("button",{type:"button",style:"padding:.5rem .9rem;cursor:pointer;border-radius:.4rem"},"Use template");
    let publishBtn=bvH("button",{type:"button",style:"padding:.5rem .9rem;font-weight:700;cursor:pointer;border-radius:.4rem;margin-left:auto"},"Publish changes");
    actions.appendChild(tplSel);actions.appendChild(tplApply);actions.appendChild(publishBtn);
    bodyEl.appendChild(actions);
    bodyEl.appendChild(bvH("div",{style:"margin:0 0 .7rem"},toolMsg));
    api("GET","/api/sites/templates").then(r=>{if(r.ok&&r.data.templates)for(let t of r.data.templates)tplSel.appendChild(bvH("option",{value:t.id},t.name));});
    tplApply.addEventListener("click",async()=>{
      let id=tplSel.value;if(!id){toolMsg.style.color="#b00";toolMsg.textContent="Pick a template first.";return;}
      if(!confirm("Apply this template? It will REPLACE your index.html."))return;
      toolMsg.style.color="#666";toolMsg.textContent="Applying template...";
      let r=await api("POST","/api/sites/apply-template",{id});
      if(r.ok){toolMsg.style.color="#070";toolMsg.textContent="Template applied. Publish to go live.";await loadList();await openFile("index.html");}
      else{toolMsg.style.color="#b00";toolMsg.textContent="Could not apply ("+(r.data.error||r.status)+").";}
    });
    publishBtn.addEventListener("click",async()=>{
      publishBtn.disabled=true;toolMsg.style.color="#666";toolMsg.textContent="Publishing...";
      let r=await api("POST","/api/sites/publish",{});publishBtn.disabled=false;
      if(r.ok){toolMsg.replaceChildren();toolMsg.style.color="#070";toolMsg.appendChild(document.createTextNode("Published. "));toolMsg.appendChild(bvH("a",{href:url,target:"_blank",rel:"noopener"},"View site"));}
      else{toolMsg.style.color="#b00";toolMsg.textContent="Publish error: "+(r.data.error||r.status);}
    });

    // ---- settings: page title + favicon ----
    let setWrap=bvH("div",{style:"border:1px solid #e5e7eb;border-radius:.6rem;padding:.75rem 1rem;margin-bottom:.9rem;display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end"});
    let titleField=bvH("label",{style:"display:flex;flex-direction:column;gap:.2rem;font-size:.82rem;flex:1;min-width:14rem;color:#555"},"Page title (browser tab)");
    let titleInput=bvH("input",{type:"text",maxlength:"200",placeholder:"My Website",style:"padding:.5rem;border:1px solid #ccc;border-radius:.4rem;font-size:.95rem"});
    titleField.appendChild(titleInput);
    let favField=bvH("label",{style:"display:flex;flex-direction:column;gap:.2rem;font-size:.82rem;color:#555"},"Favicon emoji");
    let favInput=bvH("input",{type:"text",maxlength:"4",placeholder:"icon",style:"width:4.5rem;padding:.5rem;border:1px solid #ccc;border-radius:.4rem;text-align:center;font-size:1.1rem"});
    favField.appendChild(favInput);
    let favUpField=bvH("label",{style:"display:flex;flex-direction:column;gap:.2rem;font-size:.82rem;color:#555"},"or upload icon");
    let favUp=bvH("input",{type:"file",accept:"image/*",style:"font-size:.78rem;width:9.5rem"});
    favUpField.appendChild(favUp);
    let setBtn=bvH("button",{type:"button",style:"padding:.5rem .9rem;cursor:pointer;border-radius:.4rem"},"Save settings");
    let setMsg=bvH("span",{style:"font-size:.82rem;color:#666"});
    setWrap.appendChild(titleField);setWrap.appendChild(favField);setWrap.appendChild(favUpField);setWrap.appendChild(setBtn);setWrap.appendChild(setMsg);
    bodyEl.appendChild(setWrap);
    api("GET","/api/sites/settings").then(r=>{if(r.ok){titleInput.value=r.data.title||"";if(r.data.favicon&&r.data.favicon.indexOf("favicon.svg")<0)favUpField.appendChild(bvH("span",{style:"font-size:.75rem;color:#888"},"current: "+r.data.favicon));}});
    setBtn.addEventListener("click",async()=>{
      setBtn.disabled=true;setMsg.style.color="#666";setMsg.textContent="Saving...";
      if(ed.path==="index.html"&&ed.ta){await api("PUT","/api/sites/file",{path:"index.html",text:ed.ta.value});}
      let body={title:titleInput.value};
      let f=favUp.files&&favUp.files[0];
      if(f){let ext=/\.[a-z0-9]+$/i.exec(f.name);body.favicon_b64=b64(await f.arrayBuffer());body.favicon_name="favicon"+(ext?ext[0].toLowerCase():".png");}
      else if(favInput.value.trim()){body.favicon_emoji=favInput.value.trim();}
      let r=await api("POST","/api/sites/settings",body);
      setBtn.disabled=false;
      if(r.ok){setMsg.style.color="#070";setMsg.textContent="Saved. Publish to go live.";favUp.value="";await loadList();await openFile("index.html");}
      else{setMsg.style.color="#b00";setMsg.textContent="Error: "+(r.data.error||r.status);}
    });

    // ---- toolbar: new file / upload / add section ----
    let bar=bvH("div",{style:"display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.6rem;align-items:center"});
    let newBtn=bvH("button",{type:"button",style:"padding:.5rem .9rem;cursor:pointer;border-radius:.4rem"},"New file");
    let uploadLabel=bvH("label",{style:"padding:.5rem .9rem;cursor:pointer;border:1px solid #ccc;border-radius:.4rem"},"Upload files/zip");
    let uploadInput=bvH("input",{type:"file",multiple:"",style:"display:none"});uploadLabel.appendChild(uploadInput);
    let addSel=bvH("select",{style:"padding:.45rem;border-radius:.4rem;border:1px solid #ccc"});
    addSel.appendChild(bvH("option",{value:""},"Add section..."));
    for(let i=0;i<BLOCKS.length;i++)addSel.appendChild(bvH("option",{value:String(i)},BLOCKS[i].name));
    addSel.addEventListener("change",()=>{let i=addSel.value;addSel.value="";if(i==="")return;if(!ed.ta){toolMsg.style.color="#b00";toolMsg.textContent="Open a file first, then add a section.";return;}insertAtCursor(ed.ta,BLOCKS[+i].html);toolMsg.style.color="#666";toolMsg.textContent="Section added - click Save under the editor, then Publish.";});
    bar.appendChild(newBtn);bar.appendChild(uploadLabel);bar.appendChild(addSel);
    bodyEl.appendChild(bar);
    newBtn.addEventListener("click",()=>{let nm=prompt("New file name (e.g. about.html or style.css):","");if(!nm)return;api("PUT","/api/sites/file",{path:nm,text:""}).then(r=>{if(r.ok){loadList();openFile(r.data.path);}else alert("Could not create: "+(r.data.error||r.status));});});
    uploadInput.addEventListener("change",async()=>{
      let all=Array.from(uploadInput.files||[]);if(!all.length)return;
      toolMsg.style.color="#666";toolMsg.textContent="Uploading...";
      let regular=[],zips=[],okCount=0,err=null;
      for(let f of all)(f.name.toLowerCase().endsWith(".zip")?zips:regular).push(f);
      try{
        for(let z of zips){let r=await api("POST","/api/sites/upload",{zip_b64:b64(await z.arrayBuffer())});if(r.ok)okCount++;else err=r.data.error||r.status;}
        if(regular.length){let pf=[];for(let f of regular)pf.push({path:f.name,data_b64:b64(await f.arrayBuffer())});let r=await api("POST","/api/sites/upload",{files:pf});if(r.ok)okCount+=pf.length;else err=r.data.error||r.status;}
      }catch(e){err=String(e&&e.message||e);}
      uploadInput.value="";
      if(err){toolMsg.style.color="#b00";toolMsg.textContent="Upload error: "+err;}else{toolMsg.style.color="#070";toolMsg.textContent="Uploaded. Publish to go live.";}
      loadList();
    });

    // ---- editor columns ----
    let cols=bvH("div",{style:"display:flex;gap:1rem;flex-wrap:wrap"});
    cols.appendChild(listWrap);cols.appendChild(editWrap);bodyEl.appendChild(cols);

    await loadList();
    await openFile("index.html");
  };

  async function refresh(){
    bodyEl.replaceChildren();
    statusEl.style.color="#666";statusEl.textContent="Loading...";
    let me=await api("GET","/api/sites/me");
    if(!me.ok){
      statusEl.textContent="";bodyEl.replaceChildren();
      let box=bvH("div",{style:"border:1px solid #fecaca;background:#fef2f2;border-radius:.6rem;padding:1rem;max-width:30rem"});
      if(me.status===401){
        box.appendChild(bvH("div",{style:"font-weight:700;margin-bottom:.3rem"},"Your session has expired"));
        box.appendChild(bvH("p",{style:"margin:.2rem 0 .7rem;color:#555"},"Please sign in again to edit your site."));
        box.appendChild(bvH("a",{href:"#/login",style:"display:inline-block;padding:.55rem 1rem;background:var(--accent,#2563eb);color:#fff;border-radius:.4rem;text-decoration:none;font-weight:600"},"Sign in"));
      }else{
        box.appendChild(bvH("div",{style:"font-weight:700;margin-bottom:.3rem"},me.status===0?"Can't reach the server":"Couldn't load your site"));
        box.appendChild(bvH("p",{style:"margin:.2rem 0 .7rem;color:#555"},me.status===0?"Check your connection, then try again.":("Something went wrong (status "+me.status+").")));
        let rb=bvH("button",{type:"button",style:"padding:.55rem 1rem;border-radius:.4rem;cursor:pointer;font-weight:600"},"Try again");rb.addEventListener("click",refresh);box.appendChild(rb);
      }
      bodyEl.appendChild(box);return;
    }
    statusEl.textContent="";
    if(!me.data.handle)renderClaim();
    else await renderManage(me.data);
  }

  refresh();
  return root;
})