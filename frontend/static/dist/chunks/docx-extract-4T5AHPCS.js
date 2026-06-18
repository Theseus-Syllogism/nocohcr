import{a as n}from"./chunk-YQCXV6YM.js";import{e}from"./chunk-DXB73IDG.js";var a=e(n(),1);async function m(t){let r=await t.arrayBuffer();return(await a.default.extractRawText({arrayBuffer:r})).value.replace(/\n{3,}/g,`

`).trim()}export{m as extractDocxText};
