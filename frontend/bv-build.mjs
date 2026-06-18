// bv-build v2 — patches the pristine esbuild entry to add the #/site editor +
// #/studio builder routes, ships the builder as a CONTENT-HASHED chunk
// (rehash-on-change = the permanent fix for the in-place-overwrite cache skew),
// and bakes in the renamed session chunk. It writes the new main + chunk but
// does NOT deploy (caller updates index.html + bumps the SW).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIST = '/var/www/blindvault/dist';
const PRISTINE = `${DIST}/main-023E1787.js`;          // pristine entry (base for every build)
const hash8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8).toUpperCase();

// 1) Builder chunk — content-hashed filename so it can never go stale in cache.
const builderSrc = readFileSync('/root/bv-builder.src.js', 'utf8');
const builderName = `bv-builder-${hash8(builderSrc)}.js`;
writeFileSync(`${DIST}/chunks/${builderName}`, builderSrc);

// 1b) Resume Builder chunk (content-hashed, loaded by the #/resume route).
const resumeSrc = readFileSync('/root/bv-resume.src.js', 'utf8');
const resumeName = `bv-resume-${hash8(resumeSrc)}.js`;
writeFileSync(`${DIST}/chunks/${resumeName}`, resumeSrc);

// 1c) Films & TV chunk (content-hashed, mounted into the #/library page).
const filmsSrc = readFileSync('/root/bv-films.src.js', 'utf8');
const filmsName = `bv-films-${hash8(filmsSrc)}.js`;
writeFileSync(`${DIST}/chunks/${filmsName}`, filmsSrc);

// 2) Route snippets: #/site editor + #/studio builder + #/explore + #/resume (substitute hashes).
let routes = readFileSync('/root/bv-site-route.js', 'utf8').trim()
  + '\n' + readFileSync('/root/bv-sitecode-route.js', 'utf8').trim()
  + '\n' + readFileSync('/root/bv-studio-route.js', 'utf8').trim()
  + '\n' + readFileSync('/root/bv-explore-route.js', 'utf8').trim()
  + '\n' + readFileSync('/root/bv-resume-route.js', 'utf8').trim()
  + '\n' + readFileSync('/root/bv-films-mount.js', 'utf8').trim();
routes = routes.split('__BUILDER_HASH__').join(builderName).split('__RESUME_HASH__').join(resumeName).split('__FILMS_HASH__').join(filmsName);
if (routes.includes('__BUILDER_HASH__')) throw new Error('GUARD: __BUILDER_HASH__ not substituted');
if (routes.includes('__RESUME_HASH__')) throw new Error('GUARD: __RESUME_HASH__ not substituted');
if (routes.includes('__FILMS_HASH__')) throw new Error('GUARD: __FILMS_HASH__ not substituted');
const nav = readFileSync('/root/bv-site-nav.txt', 'utf8').trim();

// 3) Pristine base. DO NOT rename the session chunk: ES modules are singletons
// PER URL, so importing chunk-7Y2BX7P2R.js here (while auth-state/inbox/library
// still import chunk-7Y2BX7P2.js) FORKS the in-memory session into two separate
// `var e` instances — login fills one, the UI tier getter reads the other, and
// the user stays "anonymous" forever (sidebar logged-out, inbox preview). The
// session chunk is pristine and never overwritten in place, so it has no cache
// skew to fix; only the (already content-hashed) builder chunk does.
let s = readFileSync(PRISTINE, 'utf8');
if (!s.includes('chunk-7Y2BX7P2.js')) throw new Error('GUARD: base missing expected session-chunk ref');
if (s.includes('chunk-7Y2BX7P2R.js')) throw new Error('GUARD: base must not reference the forked session chunk');

// 4) Inject nav + routes + M9 entries (idempotent anchors with guards).
const NAV_ANCHOR = '{id:"library",label:"Library",labelKey:"nav.library",href:"#/library",iconId:"book",visibleWhen:u=>Mu()?.kind!=="worker",gatedWhen:u=>u!=="authenticated",section:"personal"}';
const ROUTE_ANCHOR = 'Pu("emergency",u=>Qw(u))';
const insertAfter = (str, anchor, ins, name) => {
  const i = str.indexOf(anchor);
  if (i < 0) throw new Error('GUARD: anchor missing: ' + name);
  if (str.indexOf(anchor, i + 1) >= 0) throw new Error('GUARD: anchor not unique: ' + name);
  return str.slice(0, i + anchor.length) + ins + str.slice(i + anchor.length);
};
s = insertAfter(s, NAV_ANCHOR, nav, 'nav');
s = insertAfter(s, ROUTE_ANCHOR, routes, 'routes');
if (!s.includes('M9=new Set(["')) throw new Error('GUARD: M9 anchor missing');
// NOTE: check the M9-specific token "site","studio" (not a bare "sitecode", which also appears
// in the route registration Pu("sitecode") and would make the guard skip injection).
if (!s.includes('"site","studio","sitecode","explore","resume"')) s = s.replace('M9=new Set(["', 'M9=new Set(["site","studio","sitecode","explore","resume","');

// 4.5) Auto-login after account creation. The setup wizard registers the identity
// but never establishes the in-memory session, then the "done" screen routes to
// #/login — so a new user has to sign in again. Fix: (a) set the session right
// after register, mirroring the login success path's D6({...}); (b) send the
// "Open my vault" button to the dashboard instead of login. Idempotent + guarded.
const replaceOnce = (str, find, repl, name) => {
  const i = str.indexOf(find);
  if (i < 0) throw new Error('GUARD: patch anchor missing: ' + name);
  if (str.indexOf(find, i + 1) >= 0) throw new Error('GUARD: patch anchor not unique: ' + name);
  return str.slice(0, i) + repl + str.slice(i + find.length);
};
// (a) establish the session (same shape as the login D6 call); values are in scope
// at finalize: T=identityId, e.handle, P=pubkey, N=privSeed, S.key=masterKey, S.kdf.
const SESS_ANCHOR = 'await o6(H),Uo(S.key,gu(T),N)';
const SESS_SET = 'await o6(H),D6({identityIdB64:gu(T),handle:e.handle,kind:"user",pubkey:P,privSign:N,masterKey:S.key,kdf:S.kdf,unlockedAt:Date.now()}),Uo(S.key,gu(T),N)';
if (!s.includes(SESS_SET)) s = replaceOnce(s, SESS_ANCHOR, SESS_SET, 'auto-login session-set');
// (b) done screen: open the dashboard (now that we're logged in) instead of login.
const DONE_ANCHOR = 'removeItem("bv.print.handle"),Lu("login",!0)';
const DONE_FIX = 'removeItem("bv.print.handle"),Lu("dashboard",!0)';
if (!s.includes(DONE_FIX)) s = replaceOnce(s, DONE_ANCHOR, DONE_FIX, 'done-screen route');

// 4.6) Films & TV section. Wrap the library handler so it renders LC(u) exactly as before,
// then calls the injected global mounter (defined by bv-films-mount.js in the route block).
const LIB_ANCHOR = 'Pu("library",u=>LC(u))';
const LIB_WRAP = 'Pu("library",u=>{let _flr=LC(u);try{self.bvFilmsMount&&self.bvFilmsMount(u)}catch(_e){console.error("bv-films",_e)}return _flr})';
if (!s.includes(LIB_WRAP)) s = replaceOnce(s, LIB_ANCHOR, LIB_WRAP, 'films library-wrap');

// 4.7) Register the service worker as a CLASSIC worker, not a module. The shim sw.js uses
// importScripts (supported in classic SWs on every browser); module service workers threw
// during script evaluation on some browsers (Firefox read the import shim as classic). The
// real worker (sw.4S6XREUY.js) has no import/export, so it runs fine via importScripts.
const SW_MOD = '{type:"module",scope:"/"}';
const SW_CLASSIC = '{scope:"/"}';
if (s.includes(SW_MOD)) s = replaceOnce(s, SW_MOD, SW_CLASSIC, 'sw classic registration');

// 4.8) Rebrand the "Digital library" quick tile to "Download Books & Videos" with a download icon.
const TILE_OLD = '{id:"digital",href:"#/digital-resources",iconId:"document",labelKey:"nav.digital_resources",fallback:"Digital library"}';
const TILE_NEW = '{id:"digital",href:"#/digital-resources",iconId:"download",labelKey:"nav.digital_resources",fallback:"Download Books & Videos"}';
if (s.includes(TILE_OLD)) s = s.replace(TILE_OLD, TILE_NEW);

// 5) Hash + write main (NOT deployed here).
const mainName = `main-${hash8(s)}.js`;
writeFileSync(`${DIST}/${mainName}`, s);
console.log('BUILDER_CHUNK=' + builderName);
console.log('RESUME_CHUNK=' + resumeName);
console.log('FILMS_CHUNK=' + filmsName);
console.log('NEW_MAIN=' + mainName);
console.log('TO DEPLOY: point index.html at ' + mainName + ' and bump the SW version.');
