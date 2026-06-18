import{a as b}from"./chunk-WYWL5TK3.js";import"./chunk-DXB73IDG.js";var v=595,h=842,U=56,A=72,$=14,S=11,C=90;function F(s){return s.replace(/[^\x20-\x7e]/g,"?").replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)")}function _(s,e){if(s.length<=e)return[s];let a=[],r=s.split(/(\s+)/),n="";for(let o of r)for((n+o).length>e&&n.length>0?(a.push(n.trimEnd()),n=o.trimStart()):n+=o;n.length>e;)a.push(n.slice(0,e)),n=n.slice(e);return n.length&&a.push(n),a}async function I(s){let e=(await import("./lib-7UDCJ7D2.js")).default,a=new ArrayBuffer(s.length);new Uint8Array(a).set(s);let{value:r}=await e.extractRawText({arrayBuffer:a}),n=r.replace(/\r\n?/g,`
`).split(`
`);return j(n)}function j(s){let e=[];for(let t of s){if(t.length===0){e.push("");continue}for(let i of _(t,C))e.push(i)}let a=Math.floor((h-2*A)/$),r=[];for(let t=0;t<e.length;t+=a)r.push(e.slice(t,t+a));r.length===0&&r.push([""]);let n=r.length,o=[];o.push("<< /Type /Catalog /Pages 2 0 R >>");let f=Array.from({length:n},(t,i)=>`${3+i} 0 R`).join(" ");o.push(`<< /Type /Pages /Count ${n} /Kids [${f}] >>`);let m=3+n,u=m+n;for(let t=0;t<n;t++)o.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${v} ${h}] /Resources << /Font << /F1 ${u} 0 R >> >> /Contents ${m+t} 0 R >>`);for(let t=0;t<n;t++){let i=[],R=h-A;i.push("BT"),i.push(`/F1 ${S} Tf`),i.push(`${U} ${R} Td`);let T=!0;for(let k of r[t])T||i.push(`0 -${$} Td`),T=!1,i.push(`(${F(k)}) Tj`);i.push("ET");let P=i.join(`
`);o.push(`<< /Length ${P.length} >>
stream
${P}
endstream`)}o.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");let c=new TextEncoder,l=[],p=0,d=[0],g=t=>{let i=c.encode(t);l.push(i),p+=i.length};g(`%PDF-1.4
%\xE2\xE3\xCF\xD3
`);for(let t=0;t<o.length;t++)d[t+1]=p,g(`${t+1} 0 obj
${o[t]}
endobj
`);let E=p;g(`xref
0 ${o.length+1}
0000000000 65535 f 
`);for(let t=1;t<=o.length;t++)g(`${String(d[t]).padStart(10,"0")} 00000 n 
`);g(`trailer
<< /Size ${o.length+1} /Root 1 0 R >>
startxref
${E}
%%EOF
`);let w=0;for(let t of l)w+=t.length;let x=new Uint8Array(w),y=0;for(let t of l)x.set(t,y),y+=t.length;return x}async function N(s){let e=await import("./pdf-7ZTEG357.js");e.GlobalWorkerOptions.workerSrc="/dist/pdf.worker.js";let a=new ArrayBuffer(s.length);new Uint8Array(a).set(s);let r=await e.getDocument({data:a,isEvalSupported:!1}).promise,n=[];for(let o=1;o<=r.numPages;o++){let m=await(await r.getPage(o)).getTextContent(),u=[],c="";for(let l of m.items)c+=l.str??"",l.hasEOL?(u.push(c),c=""):c+=" ";c.trim().length&&u.push(c);for(let l of u){let p=l.replace(/\s+/g," ").trim();p.length?n.push(p):n.push("")}o<r.numPages&&n.push("")}return O(n)}function D(s){return s.replace(/[&<>"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[e])}function O(s){let e=new TextEncoder,r=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${s.map(f=>f.length===0?"<w:p/>":`<w:p><w:r><w:t xml:space="preserve">${D(f)}</w:t></w:r></w:p>`).join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;return b([{name:"[Content_Types].xml",bytes:e.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)},{name:"_rels/.rels",bytes:e.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)},{name:"word/document.xml",bytes:e.encode(r)}])}export{O as buildDocx,I as docxToPdf,N as pdfToDocx,j as renderTextPdf};
