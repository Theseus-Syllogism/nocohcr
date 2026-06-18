,Pu("site",async (u)=>{
  // "My Website" — smart loader: auth -> claim -> visual builder. Never dead-ends; the
  // old code editor lives at #/sitecode (Advanced). Graceful 401 / network handling.
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
  if(!document.getElementById("bv-entry-css")){
    let st=document.createElement("style");st.id="bv-entry-css";
    st.textContent=".bv-entry{max-width:34rem;margin:2.5rem auto;padding:0 1rem;font-family:system-ui,sans-serif}.bv-entry-card{background:#fff;border:1px solid #e5e7eb;border-radius:.9rem;padding:1.5rem;box-shadow:0 1px 6px rgba(0,0,0,.06)}.bv-entry h1{margin:.1rem 0 .4rem;font-size:1.45rem}.bv-entry-muted{color:#64748b}.bv-entry-btn{display:inline-block;padding:.6rem 1.1rem;border-radius:.5rem;font-weight:600;cursor:pointer;border:1px solid var(--accent,#2563eb);background:var(--accent,#2563eb);color:#fff;text-decoration:none;font:inherit;min-height:44px;box-sizing:border-box}.bv-entry-btn.sec{background:#fff;color:var(--accent,#2563eb)}.bv-entry-field{width:100%;padding:.65rem;font-size:1rem;border:1px solid #cbd5e1;border-radius:.5rem;box-sizing:border-box;min-height:44px}.bv-spin{width:30px;height:30px;border:3px solid var(--accent-soft,#dbeafe);border-top-color:var(--accent,#2563eb);border-radius:50%;animation:bvspin 1s linear infinite;margin:.6rem auto}@keyframes bvspin{to{transform:rotate(360deg)}}.bv-choice{display:flex;gap:.8rem;flex-wrap:wrap;margin-top:1rem}.bv-choice button{display:block;flex:1 1 14rem;min-width:12rem;text-align:left;padding:1rem;border:1px solid #cbd5e1;border-radius:.7rem;background:#fff;cursor:pointer;font:inherit}.bv-choice button:hover,.bv-choice button:focus-visible{border-color:var(--accent,#2563eb);outline:none;box-shadow:0 0 0 2px var(--accent-soft,#bfdbfe)}.bv-choice b{display:block;margin-bottom:.25rem;font-size:1rem;line-height:1.3}.bv-choice span{display:block;color:#64748b;font-size:.85rem;line-height:1.4}@media (prefers-reduced-motion:reduce){.bv-spin{animation:none}}";
    document.head.appendChild(st);
  }
  const screen=(node)=>{u.replaceChildren();let w=bvH("div",{class:"bv-entry"});w.appendChild(node);u.appendChild(w);};
  const card=(...kids)=>bvH("div",{class:"bv-entry-card"},...kids);

  function showLoading(msg){screen(card(bvH("div",{class:"bv-spin"}),bvH("p",{class:"bv-entry-muted",style:"text-align:center"},msg||"Loading your website…")));}
  function showAuth(expired){
    screen(card(
      bvH("h1",null,expired?"Your session has expired":"Sign in to build your website"),
      bvH("p",{class:"bv-entry-muted"},expired?"Please sign in again to keep editing your site.":"You need to be signed in to create and edit your free website."),
      bvH("div",{style:"display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.4rem"},
        bvH("a",{class:"bv-entry-btn",href:"#/login"},"Sign in"),
        expired?bvH("button",{class:"bv-entry-btn sec",type:"button",onclick:()=>load()},"Try again"):null)
    ));
  }
  function showError(status){
    screen(card(
      bvH("h1",null,status===0?"Can't reach the server":"Couldn't load your website"),
      bvH("p",{class:"bv-entry-muted"},status===0?"Check your connection, then try again.":("Something went wrong (status "+status+"). It's usually temporary.")),
      bvH("button",{class:"bv-entry-btn",type:"button",style:"margin-top:.4rem",onclick:()=>load()},"Try again")
    ));
  }
  function showClaim(){
    let body=card(bvH("h1",null,"Create your free website"),bvH("p",{class:"bv-entry-muted"},"Pick a handle. Your site will live at:"));
    let preview=bvH("div",{style:"font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1.05rem;margin:.3rem 0 .6rem;color:#0f172a"},"your-handle.yourdomain.com");
    let input=bvH("input",{class:"bv-entry-field",type:"text",placeholder:"your-handle",maxlength:"32",autocapitalize:"none",autocorrect:"off",spellcheck:"false","aria-label":"Site handle"});
    input.addEventListener("input",()=>{let v=input.value.toLowerCase().replace(/[^a-z0-9-]/g,"");input.value=v;preview.textContent=(v||"your-handle")+".yourdomain.com";});
    let msg=bvH("div",{style:"min-height:1.2rem;color:#b00;margin:.5rem 0",role:"status","aria-live":"polite"});
    let btn=bvH("button",{class:"bv-entry-btn",type:"button",style:"margin-top:.2rem"},"Create my site");
    btn.addEventListener("click",async()=>{
      let handle=input.value.trim().toLowerCase();
      if(handle.length<3){msg.style.color="#b00";msg.textContent="Handle must be at least 3 characters.";input.focus();return;}
      btn.disabled=true;msg.style.color="#64748b";msg.textContent="Creating your site…";
      let r=await api("POST","/api/sites/claim",{handle});
      if(r.ok){let me=await api("GET","/api/sites/me");launchBuilder((me.ok&&me.data)||{handle});return;}
      btn.disabled=false;msg.style.color="#b00";msg.textContent=claimErr(r.data.error,r.data);input.focus();
    });
    body.appendChild(preview);body.appendChild(input);body.appendChild(msg);body.appendChild(btn);
    let alt=bvH("p",{class:"bv-entry-muted",style:"margin-top:1rem;font-size:.85rem"});
    alt.appendChild(document.createTextNode("Prefer to write HTML/CSS yourself? "));
    alt.appendChild(bvH("a",{href:"#/sitecode",style:"color:var(--accent,#2563eb)"},"Use the code editor"));
    body.appendChild(alt);
    screen(body);
  }
  function showChooser(me){
    let body=card(bvH("h1",null,"Edit your website"),bvH("p",{class:"bv-entry-muted"},"Your site is at "+me.handle+".yourdomain.com. How would you like to edit it?"));
    let choice=bvH("div",{class:"bv-choice"});
    let visual=bvH("button",{type:"button"},bvH("b",null,"✨ Visual builder (recommended)"),bvH("span",null,"Drag-and-drop blocks, sections, themes — no code. Starts a fresh visual design; your current files stay safe under the code editor until you publish."));
    visual.addEventListener("click",()=>launchBuilder(me));
    let code=bvH("button",{type:"button"},bvH("b",null,"</> Code editor (Advanced)"),bvH("span",null,"Edit your existing HTML, CSS and files directly, upload assets, manage everything by hand."));
    code.addEventListener("click",()=>{location.hash="#/sitecode";});
    choice.appendChild(visual);choice.appendChild(code);body.appendChild(choice);
    screen(body);
  }
  async function launchBuilder(me){
    showLoading("Opening the builder…");
    let mod;
    try{mod=await import("./chunks/__BUILDER_HASH__");}
    catch(e){
      screen(card(bvH("h1",null,"The builder just updated"),bvH("p",{class:"bv-entry-muted"},"Reload to get the latest version."),bvH("button",{class:"bv-entry-btn",type:"button",style:"margin-top:.4rem",onclick:()=>location.reload()},"Reload")));
      return;
    }
    u.replaceChildren();
    try{await mod.renderBuilder(u,{api,me:me||{}});}
    catch(e){screen(card(bvH("h1",null,"Builder error"),bvH("p",{class:"bv-entry-muted"},String(e&&e.message||e)),bvH("button",{class:"bv-entry-btn",type:"button",style:"margin-top:.4rem",onclick:()=>load()},"Try again")));}
  }
  async function load(){
    if(!Mu()){showAuth(false);return;}
    showLoading();
    let me=await api("GET","/api/sites/me");
    if(me.status===401){showAuth(true);return;}
    if(!me.ok){showError(me.status);return;}
    if(!me.data.handle){showClaim();return;}
    let sj=await api("GET","/api/sites/file?path=site.json");
    if(sj.ok&&sj.data&&typeof sj.data.text==="string"){launchBuilder(me.data);return;}
    showChooser(me.data);
  }
  load();
})
