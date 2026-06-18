import{V as r,X as n}from"./chunk-KJX3AKK6.js";import"./chunk-DXB73IDG.js";r.workerSrc="/dist/pdf.worker.js";async function m(o){let s=await o.arrayBuffer(),t=await n({data:s,isEvalSupported:!1}).promise,a=[];for(let e=1;e<=t.numPages;e++){let i=(await(await t.getPage(e)).getTextContent()).items.map(c=>c.str??"").join(" ").replace(/\s+\n/g,`
`).replace(/[ \t]+/g," ").trim();a.push(`--- page ${e} ---
${i}`)}return a.join(`

`)}export{m as extractPdfText};
