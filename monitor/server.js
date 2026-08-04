'use strict';
//
// monitor/server.js -- read-only web view of the recorder's output.
//
// Binds loopback only; nginx terminates TLS and basic auth in front. This
// process NEVER writes to the data tree -- unlike the survey monitor it has no
// Start button, because starting the recorder is a deliberate act gated by the
// ENABLED sentinel and preflight interlock.
//
// Serves:
//   GET  /                 the page
//   GET  /api/status       recorder status.json
//   GET  /api/events       recent events (index.json)
//   GET  /api/coverage     recent coverage rows
//   GET  /api/authz        whether start/stop are permitted right now
//   POST /api/control      {action:'start'|'stop'}
//   GET  /audio/<day>/<f>  a capture, with Range support so a browser can seek
//                          inside a long EAM without pulling the whole file
//
// CONTROL IS DELIBERATELY ASYMMETRIC
// ----------------------------------
// STOP is always available: it releases KiwiSDR slots, which is strictly good
// for the sysops whose receivers we borrow.
//
// START consumes other people's resources, and basic auth is a single shared
// password. So START is offered ONLY when config/ENABLED exists -- and that
// file is deliberately not reachable from here. It is created at a shell, by a
// human, on the box.
//
// This is not the real gate. preflight.sh runs as ExecStartPre, so `systemctl
// start` cannot bypass it no matter who asks; without ENABLED the unit refuses
// regardless. The button can only ever restart something already authorised.
// Hiding it is defence in depth, not the defence.
//
// CSRF: control requires a custom header. Browsers will not send one
// cross-origin without a CORS preflight the server never answers, so a
// malicious page cannot ride the operator's basic-auth session.
//
// Path handling is deliberately paranoid: day and filename are matched against
// strict patterns and the resolved path must sit inside the events root. A
// read-only server that will hand out any file on the box is not read-only in
// any sense that matters.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const configUi = require('./config-ui');
const labels = require('./labels');

const CONTROL_HEADER = 'x-hfgcs-control';
const CONTROL_MIN_INTERVAL_MS = 5000;   // no rapid start/stop churn
const SUDO = '/usr/bin/sudo';
const SYSTEMCTL = '/usr/bin/systemctl';

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    if (m) out[m[1]] = m[2] === '' ? true : m[2];
  }
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.(wav|opus|png)$/;

/**
 * Existence check with a short cache. The page polls every 5s and a day of
 * captures is hundreds of entries; re-stat'ing all of them on every poll is
 * pointless when files change rarely.
 */
const _existCache = new Map();
function fileExists(p) {
  const now = Date.now();
  const hit = _existCache.get(p);
  if (hit && now - hit.at < 4000) return hit.ok;
  let ok = false;
  try { fs.accessSync(p, fs.constants.F_OK); ok = true; } catch (_) { ok = false; }
  _existCache.set(p, { at: now, ok });
  if (_existCache.size > 5000) _existCache.clear();
  return ok;
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function tailJsonl(file, limit) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i])); } catch (_) { /* torn line */ }
  }
  return out;
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveAudio(req, res, eventsRoot) {
  const m = /^\/audio\/([^/]+)\/([^/]+)$/.exec(decodeURIComponent(req.url.split('?')[0]));
  if (!m) { res.writeHead(404); return res.end('not found'); }
  const [, day, file] = m;
  if (!DAY_RE.test(day) || !FILE_RE.test(file)) {
    res.writeHead(400); return res.end('bad path');
  }

  const full = path.resolve(eventsRoot, day, file);
  // Belt and braces: even with the patterns above, refuse anything that
  // resolves outside the events tree.
  if (!full.startsWith(path.resolve(eventsRoot) + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }

  let st;
  try { st = fs.statSync(full); } catch (_) { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }

  const type = file.endsWith('.opus') ? 'audio/ogg'
             : file.endsWith('.png') ? 'image/png'
             : 'audio/wav';
  const range = req.headers.range;

  if (range) {
    const rm = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (rm) {
      let start = rm[1] === '' ? null : parseInt(rm[1], 10);
      let end = rm[2] === '' ? null : parseInt(rm[2], 10);
      if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1; }
      if (start === null) start = 0;
      if (end === null || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
        'Accept-Ranges': 'bytes'
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    // Audio never changes once written, but a THUMBNAIL can be re-rendered when
    // the renderer improves. With no cache header at all the browser applies
    // heuristic caching and keeps serving the old image, which looks exactly
    // like the new renderer having done nothing.
    'Cache-Control': file.endsWith('.png') ? 'no-cache' : 'public, max-age=86400',
    'ETag': '"' + Math.round(st.mtimeMs).toString(36) + '-' + st.size.toString(36) + '"'
  });
  fs.createReadStream(full).pipe(res);
}

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HFGCS recorder</title>
<style>
 :root{--bg:#0d1117;--fg:#c9d1d9;--dim:#8b949e;--line:#21262d;--accent:#58a6ff;--warn:#d29922}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
 header{padding:16px 20px;border-bottom:1px solid var(--line)}
 h1{margin:0;font-size:16px;font-weight:600}
 .sub{color:var(--dim);font-size:12px;margin-top:4px}
 .wrap{padding:20px;max-width:1100px}
 .chans{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:22px}
 .ch{border:1px solid var(--line);border-radius:6px;padding:10px 12px;min-width:250px}
 .ch b{color:var(--accent);font-size:15px}
 .kv{color:var(--dim);font-size:12px}
 table{width:100%;border-collapse:collapse}
 th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:12px;vertical-align:middle}
 th{color:var(--dim);font-weight:500}
 audio{height:30px;vertical-align:middle}
 .empty{color:var(--dim);padding:24px 0}
 .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px}
 .rx{color:#c9d1d9}
 .none{color:#6e7681;font-style:italic}
 .sub{color:#6e7681;font-size:11px}
 .open{color:#3fb950}
 .closed{color:#8b949e}
 .ctl{margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 button{font:inherit;font-size:12px;padding:5px 12px;border-radius:5px;cursor:pointer;
        background:#21262d;color:var(--fg);border:1px solid #30363d}
 button:hover:not(:disabled){background:#30363d}
 button:disabled{opacity:.4;cursor:not-allowed}
 button.stop{border-color:#6e2f2f}
 button.stop:hover:not(:disabled){background:#3d1f1f}
 .note{color:var(--dim);font-size:11px}
 .msg{font-size:11px}
 .msg.err{color:#f85149}
 .msg.ok{color:#3fb950}
 details#settings{margin-top:28px;border:1px solid var(--line);border-radius:6px}
 summary{cursor:pointer;padding:10px 12px;font-weight:600;user-select:none}
 .sbody{padding:4px 14px 16px}
 .grp{margin-top:16px;color:var(--accent);font-size:12px;border-bottom:1px solid var(--line);padding-bottom:4px}
 .f{display:flex;align-items:flex-start;gap:10px;padding:7px 0;flex-wrap:wrap}
 .f label{flex:0 0 230px;font-size:12px}
 .f input[type=number],.f input[type=text],.f select{background:#0d1117;color:var(--fg);border:1px solid #30363d;
        border-radius:4px;padding:3px 6px;font:inherit;font-size:12px;width:120px}
 .f .meta{flex:1 1 100%;color:var(--dim);font-size:11px;padding-left:240px}
 .f .meas{color:#d29922}
 .f .err{color:#f85149;font-size:11px}
 .fq{display:inline-flex;align-items:center;gap:6px;margin-right:18px;font-size:12px}
 .srow{margin-top:18px;display:flex;gap:10px;align-items:center}
 .footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--line);
         color:var(--dim);font-size:11px;line-height:1.9}
 code{background:#161b22;border:1px solid var(--line);border-radius:4px;padding:2px 7px;color:#c9d1d9}
 .toolbar{display:flex;align-items:center;gap:14px;margin:14px 0 6px;flex-wrap:wrap}
 .lbtn{font-size:11px;padding:2px 7px;margin-right:3px;border-radius:4px;background:#161b22;
       border:1px solid #30363d;color:var(--dim);cursor:pointer}
 .lbtn:hover{background:#21262d}
 .lbtn.on{color:#0d1117;font-weight:600}
 .lbtn.on.voice{background:#3fb950;border-color:#3fb950}
 .lbtn.on.static{background:#8b949e;border-color:#8b949e}
 .lbtn.on.data{background:#58a6ff;border-color:#58a6ff}
 .lbtn.on.unsure{background:#d29922;border-color:#d29922}
 tr.sel{background:#161b22}
 .thumb{display:block;width:360px;height:auto;max-height:144px;border-radius:4px;
        border:1px solid var(--line);background:#0d1117}
 .sig-strong{color:#3fb950;font-weight:600}
 .sig-mid{color:#d29922}
 .sig-weak{color:#6e7681}
 .legend{color:var(--dim);font-size:11px;margin:6px 0 0}
</style></head><body>
<header>
  <h1>HFGCS recorder</h1>
  <div class="sub" id="sub">loading...</div>
  <div id="ctl" class="ctl"></div>
</header>
<div class="wrap">
  <div class="chans" id="chans"></div>
  <div class="toolbar">
    <label class="fq"><input type="checkbox" id="selall"> select all</label>
    <button id="btrash" class="stop" disabled>Delete selected</button>
    <span id="trashmsg" class="msg"></span>
    <span class="note" id="lstats"></span>
  </div>
  <div class="legend">
    <span class="sig-strong">strong</span> = harmonicity &ge;0.50 (confirmed voice measured 0.50-0.84) &nbsp;|&nbsp;
    <span class="sig-mid">marginal</span> = 0.35-0.50 &nbsp;|&nbsp;
    <span class="sig-weak">weak</span> = &lt;0.35 (confirmed static measured 0.24-0.27).
    Bands are from 3 confirmed-voice and 69 confirmed-static captures &mdash; provisional.
  </div>
  <table>
    <thead><tr><th></th><th>UTC</th><th>kHz</th><th>dur</th>
    <th title="waterfall: time left-to-right, frequency low-to-high">signal</th>
    <th title="peak of the rolling window at trigger - directly comparable to the Minimum voiced fraction setting">voiced</th>
    <th title="peak autocorrelation in the 70-300 Hz pitch range">harm</th>
    <th title="how often the spectrum went peaky">dip</th>
    <th>receiver</th><th>listen</th><th>label</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">No captures yet.</div>

  <details id="settings">
    <summary>Settings</summary>
    <div class="sbody">
      <div class="note" style="margin-bottom:12px">
        Changes are written to hfgcs.json and take effect on the <b>next recorder start</b>.
        Enable/disable is deliberately not here &mdash; see the footer.
      </div>
      <div id="freqs"></div>
      <div id="fields"></div>
      <div class="srow">
        <button id="bsave">Save settings</button>
        <span id="savemsg" class="msg"></span>
      </div>
    </div>
  </details>

  <div class="footer">
    <b>Authorisation is a shell act.</b> The recorder cannot start without it, whatever this page says.<br>
    enable&nbsp;&nbsp;<code>sudo -u hfgcs touch /opt/hfgcs/config/ENABLED</code><br>
    disable&nbsp;<code>sudo rm -f /opt/hfgcs/config/ENABLED</code>
  </div>
</div>
<script>
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function col(s){return s==='streaming'?'#3fb950':s==='backoff'?'#d29922':s==='rotating'?'#58a6ff':'#8b949e';}
async function tick(){
  try{
    await loadLabels();
    const [st,ev,cv,az] = await Promise.all([
      // 503 carries a JSON body, so r.json() SUCCEEDS and returns a truthy
      // {error:...} object. Without the r.ok guard that object flows straight
      // into new Date(undefined) and the page dies with "Invalid time value"
      // whenever the recorder simply is not running -- which is the normal
      // resting state before Phase 1.
      fetch('api/status').then(r=>r.ok?r.json():null).catch(()=>null),
      fetch('api/events').then(r=>r.json()).catch(()=>({events:[]})),
      fetch('api/coverage').then(r=>r.json()).catch(()=>({rows:[]})),
      fetch('api/authz').then(r=>r.ok?r.json():null).catch(()=>null)
    ]);
    const covBy = {};
    for(const r of (cv.rows||[])) if(covBy[r.freqKHz]==null) covBy[r.freqKHz]=r.fraction;

    if(st){
      const upd = st.updatedAt ? new Date(st.updatedAt) : null;
      const updTxt = (upd && !isNaN(upd)) ? upd.toISOString().replace('T',' ').slice(0,19)+'Z' : 'unknown';
      document.getElementById('sub').textContent =
        'pid '+st.pid+' | up '+Math.floor((st.uptimeSec||0)/60)+' min | updated '+updTxt;
      document.getElementById('chans').innerHTML = (st.channels||[]).map(c=>{
        const d=c.detector||{};
        const cov = covBy[c.freqKHz]!=null ? (covBy[c.freqKHz]*100).toFixed(0)+'%' : '--';
        const dur = s => s==null ? null : (s<90 ? s+'s' : Math.round(s/60)+'m');

        // Only claim a receiver when one is actually connected. A parked or
        // reconnecting channel holds NO slot and must not appear to.
        let rxLine, subLine='';
        if (c.connectedSite) {
          rxLine = '<span class="rx">'+esc(c.connectedSite)+'</span>';
          const bits=[];
          if (c.connectedSinceSec!=null) bits.push('held '+dur(c.connectedSinceSec));
          if (c.rotateInSec!=null) bits.push('rotates in '+dur(c.rotateInSec));
          subLine = bits.join(' | ');
        } else if (c.state==='parked') {
          rxLine = '<span class="none">no receiver - band closed</span>';
          subLine = 'recheck ~'+(c.parkRecheckMin||15)+'m';
        } else {
          rxLine = '<span class="none">no receiver</span>';
          if (c.lastSite) subLine = 'last: '+esc(c.lastSite);
        }
        const gate = c.gateOpen===false
          ? '<span class="closed">closed</span>' : '<span class="open">open</span>';

        return '<div class="ch"><b>'+c.freqKHz+' kHz</b>'
          +'<div class="kv"><span class="dot" style="background:'+col(c.state)+'"></span>'+esc(c.state)
          +(c.capturing?' | <b style="color:#f85149">RECORDING</b>':'')+'</div>'
          +'<div class="kv">'+rxLine+'</div>'
          +(subLine?'<div class="kv sub">'+subLine+'</div>':'')
          +'<div class="kv">path '+(c.propagation!=null?c.propagation.toFixed(2):'--')+' '+gate
          +' | coverage '+cov+'</div>'
          +'<div class="kv">kept '+c.kept+' | sessions '+c.sessions
          +' | parks '+(c.parks||0)+' | refusals '+c.refusals+'</div>'
          +'<div class="kv">mod '+(d.modFraction!=null?d.modFraction.toFixed(3):'--')
          +' / thr '+(d.threshold!=null?d.threshold.toFixed(3):'--')+'</div></div>';
      }).join('');
    } else {
      document.getElementById('sub').textContent =
        (az && az.running) ? 'starting...' : 'recorder not running';
      document.getElementById('chans').innerHTML='';
    }
    // Liveness comes from systemd via /api/authz. Using !!st here was the bug:
    // status.json survives the process, so a stopped recorder kept Start greyed.
    if(!busy) renderCtl(az, !!(az && az.running));

    const rows=(ev.events||[]);
    document.getElementById('empty').style.display = rows.length?'none':'block';
    const LB=['voice','static','data','unsure'];

    // Re-rendering the table on every poll wiped the checkboxes a second after
    // "select all" was clicked, and cut off any clip that was playing. Only
    // rebuild when the event set actually changes; labels are applied to the
    // DOM directly when clicked, so they do not need a rebuild either.
    const sig = rows.map(e=>e.id).join('|');
    if (sig === lastRowSig) return;

    // A rebuild is genuinely needed, so carry the current selection across it.
    const keep = new Set(picked().map(c=>c.dataset.day+'/'+c.dataset.file));
    lastRowSig = sig;

    document.getElementById('rows').innerHTML = rows.map(e=>{
      const f=e.features||{};
      const dip = f.flatDipFraction!=null ? (100*f.flatDipFraction).toFixed(0)+'%' : '--';

      // Measured bands, not taste:
      //   confirmed voice        harmP90 0.50-0.84
      //   marginal / uncertain   harmP90 0.28-0.45
      //   confirmed static       harmP90 0.24-0.27
      // The gate itself decides on voicedFraction (threshold 0.03), so show
      // that too -- it was previously invisible even though it is the number
      // that determines whether a capture exists at all.
      const hv = f.harmonicityP90;
      const harmCls = hv==null ? '' : hv>=0.50 ? 'sig-strong' : hv>=0.35 ? 'sig-mid' : 'sig-weak';
      const harm = hv==null ? '--' : '<span class="'+harmCls+'">'+hv.toFixed(2)+'</span>';

      // Show the value the GATE tested, not the whole-file average. The two
      // differ a lot -- one capture triggered at 21.5% and averaged 8.4% once
      // pre-roll and pauses were folded in, which looked like a capture below
      // the configured minimum when nothing was wrong.
      // Older captures predate thumbnails; show a placeholder rather than a
      // broken image.
      const thumb = e.thumb
        ? '<img class="thumb" loading="lazy" src="audio/'+encodeURIComponent(e.day)
          +'/'+encodeURIComponent(e.thumb)+'?v='+encodeURIComponent(e.startedAt||'')+'" alt="waterfall">'
        : '<span class="none">--</span>';

      const vt = e.peakVoicedFraction != null ? e.peakVoicedFraction : e.voicedAtTrigger;
      const vf = f.harmonicVoicedFraction;
      const shown = vt != null ? vt : vf;
      const vfCls = shown==null ? '' : shown>=0.15 ? 'sig-strong' : shown>=0.05 ? 'sig-mid' : 'sig-weak';
      const avgTxt = vf!=null ? ', whole-file avg '+(100*vf).toFixed(1)+'%' : '';
      const voiced = shown==null ? '--'
        : '<span class="'+vfCls+'" title="peak of the rolling window - this is what the threshold tests'
          +avgTxt+'">'+(100*shown).toFixed(1)+'%</span>';
      const cur = (labelMap[e.id]||{}).label || '';
      const btns = LB.map(l=>'<button class="lbtn '+l+(cur===l?' on':'')+'" data-id="'+esc(e.id)
        +'" data-l="'+l+'">'+l+'</button>').join('');
      return '<tr'+(cur?' class="sel"':'')+'>'
        +'<td><input type="checkbox" class="pick"'+(keep.has(e.day+'/'+e.file)?' checked':'')
        +' data-day="'+esc(e.day)+'" data-file="'+esc(e.file)+'"></td>'
        +'<td>'+esc((e.startedAt||'').replace('T',' ').slice(0,19))+'</td>'
        +'<td>'+esc(e.freqKHz)+'</td>'
        +'<td>'+(e.durationSec!=null?e.durationSec.toFixed(1)+'s':'--')+'</td>'
        +'<td>'+thumb+'</td>'
        +'<td>'+voiced+'</td><td>'+harm+'</td><td>'+dip+'</td>'
        +'<td>'+esc(e.site)+'</td>'
        +'<td><audio controls preload="none" src="audio/'+encodeURIComponent(e.day)+'/'+encodeURIComponent(e.file)+'"></audio></td>'
        +'<td>'+btns+'</td></tr>';
    }).join('');
    wireRows();
  }catch(err){ document.getElementById('sub').textContent='error: '+err.message; }
}
let busy=false;
async function control(action){
  if(busy) return;
  const verb = action==='start' ? 'START' : 'STOP';
  if(!confirm(verb+' the recorder?\\n\\n'+(action==='start'
      ? 'This will begin connecting to volunteer-run KiwiSDR receivers.'
      : 'This releases any receiver slots currently held.'))) return;
  busy=true; msg('working...','');
  try{
    const r = await fetch('api/control',{method:'POST',
      headers:{'Content-Type':'application/json','X-HFGCS-Control':'1'},
      body:JSON.stringify({action})});
    const j = await r.json().catch(()=>({}));
    if(r.ok) msg(verb.toLowerCase()+' sent','ok');
    else msg((j.error||('HTTP '+r.status))+(j.reason?' - '+j.reason:''),'err');
  }catch(e){ msg('request failed: '+e.message,'err'); }
  busy=false;
  setTimeout(tick,1200);
}
function msg(t,cls){
  const m=document.getElementById('ctlmsg');
  if(m){ m.textContent=t; m.className='msg '+(cls||''); }
}
function renderCtl(authz, running){
  const el=document.getElementById('ctl');
  if(!authz){ el.innerHTML=''; return; }
  let h='';
  if(authz.canStart){
    h+='<button id="bstart"'+(running?' disabled':'')+'>Start recorder</button>';
  }else{
    h+='<button disabled title="'+esc(authz.reason||'')+'">Start recorder</button>'
      +'<span class="note">'+esc(authz.reason||'')+'</span>';
  }
  h+='<button id="bstop" class="stop"'+(running?'':' disabled')+'>Stop recorder</button>';
  h+='<span id="ctlmsg" class="msg"></span>';
  el.innerHTML=h;
  const bs=document.getElementById('bstart');
  if(bs && !bs.disabled) bs.onclick=()=>control('start');
  const bt=document.getElementById('bstop');
  if(bt && !bt.disabled) bt.onclick=()=>control('stop');
}
// ---- settings ------------------------------------------------------------
// ---- labels + delete ------------------------------------------------------
let labelMap={};
let lastRowSig=null;   // skip table rebuilds that would clobber selection/audio
async function loadLabels(){
  try{
    const d=await fetch('api/labels').then(r=>r.ok?r.json():null);
    if(d){ labelMap=d.labels||{};
      const c=d.stats.counts;
      document.getElementById('lstats').textContent =
        d.stats.total+' labelled  (voice '+c.voice+' | static '+c.static+' | data '+c.data+' | unsure '+c.unsure+')';
    }
  }catch(e){}
}
async function setLabel(id,label,btn){
  try{
    const r=await fetch('api/label',{method:'POST',
      headers:{'Content-Type':'application/json','X-HFGCS-Control':'1'},
      body:JSON.stringify({id,label})});
    if(r.ok){
      labelMap[id]={label};
      const row=btn.closest('tr');
      row.classList.add('sel');
      row.querySelectorAll('.lbtn').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on');
      const j=await r.json();
      if(j.stats){const c=j.stats.counts;
        document.getElementById('lstats').textContent =
          j.stats.total+' labelled  (voice '+c.voice+' | static '+c.static+' | data '+c.data+' | unsure '+c.unsure+')';}
    }
  }catch(e){}
}
function picked(){ return Array.from(document.querySelectorAll('.pick:checked')); }
function wireRows(){
  document.querySelectorAll('.lbtn').forEach(b=>{
    b.onclick=()=>setLabel(b.dataset.id,b.dataset.l,b);
  });
  document.querySelectorAll('.pick').forEach(c=>{
    c.onchange=()=>{ document.getElementById('btrash').disabled = picked().length===0; };
  });
  document.getElementById('btrash').disabled = picked().length===0;
}
document.getElementById('selall').onchange=function(){
  document.querySelectorAll('.pick').forEach(c=>{c.checked=this.checked;});
  document.getElementById('btrash').disabled = picked().length===0;
};
document.getElementById('btrash').onclick=async function(){
  const items=picked().map(c=>({day:c.dataset.day,file:c.dataset.file}));
  if(!items.length) return;
  if(!confirm('Move '+items.length+' capture(s) to trash?\\n\\nFiles move to data/trash/ and are pruned by the retention sweep. Not immediately unrecoverable.')) return;
  const m=document.getElementById('trashmsg');
  m.className='msg'; m.textContent='deleting...';
  try{
    const r=await fetch('api/trash',{method:'POST',
      headers:{'Content-Type':'application/json','X-HFGCS-Control':'1'},
      body:JSON.stringify({items})});
    const j=await r.json().catch(()=>({}));
    if(r.ok){ m.className='msg ok'; m.textContent=j.moved+' moved to trash';
      document.getElementById('selall').checked=false;
      lastRowSig=null;                 // force a rebuild: rows really did change
      setTimeout(tick,400); }
    else { m.className='msg err'; m.textContent=j.error||('HTTP '+r.status); }
  }catch(e){ m.className='msg err'; m.textContent='failed: '+e.message; }
};

let cfgLoaded=false;
async function loadCfg(){
  let d;
  try{ d = await fetch('api/config').then(r=>r.ok?r.json():null); }catch(e){ d=null; }
  if(!d){ document.getElementById('fields').innerHTML='<div class="note">config unavailable</div>'; return; }

  document.getElementById('freqs').innerHTML =
    '<div class="grp">Frequencies</div><div style="padding:8px 0">'
    + d.frequencies.map(f=>
        '<span class="fq"><input type="checkbox" id="fq_'+f.khz+'"'+(f.active?' checked':'')+'>'
        +'<label for="fq_'+f.khz+'">'+f.khz+' kHz</label></span>').join('')
    + '</div><div class="note">Each active frequency holds one receiver slot while its band is open.</div>';

  const groups=[];
  for(const f of d.fields){ if(!groups.includes(f.group)) groups.push(f.group); }
  document.getElementById('fields').innerHTML = groups.map(g=>{
    const rows = d.fields.filter(f=>f.group===g).map(f=>{
      // NOT .replace(/\./g) -- inside a template literal the backslash is
      // dropped and the regex becomes /./g, which replaces EVERY character and
      // gives every field the same element id. split/join has no escape to lose.
      const id='cf_'+f.key.split('.').join('_');
      let input;
      if(f.type==='bool'){
        input='<input type="checkbox" id="'+id+'"'+(f.value?' checked':'')+'>';
      }else if(f.type==='enum'){
        input='<select id="'+id+'">'+f.values.map(v=>
          '<option value="'+v+'"'+(v===f.value?' selected':'')+'>'+v+'</option>').join('')+'</select>';
      }else if(f.type==='csv'){
        const v=Array.isArray(f.value)?f.value.join(','):(f.value||'');
        input='<input type="text" id="'+id+'" value="'+esc(v)+'" style="width:300px" '
          +'placeholder="'+esc((f.values||[]).slice(0,2).join(','))+'">';
      }else if(f.type==='text'){
        input='<input type="text" id="'+id+'" value="'+esc(f.value)+'" style="width:220px"'
          +(f.maxLength?' maxlength="'+f.maxLength+'"':'')+'>';
      }else{
        const step=f.type==='int'?'1':'any';
        input='<input type="number" id="'+id+'" step="'+step+'" value="'+esc(f.value)+'"'
          +(f.min!=null?' min="'+f.min+'"':'')+(f.max!=null?' max="'+f.max+'"':'')+'>';
      }
      let meta='';
      if(f.help) meta+=esc(f.help)+' ';
      if(f.measured) meta+='<span class="meas">'+esc(f.measured)+'</span>';
      return '<div class="f" data-key="'+f.key+'" data-type="'+f.type+'">'
        +'<label for="'+id+'">'+esc(f.label)+'</label>'+input
        +'<span class="err" id="err_'+id+'"></span>'
        +(meta?'<span class="meta">'+meta+'</span>':'')+'</div>';
    }).join('');
    return '<div class="grp">'+esc(g)+'</div>'+rows;
  }).join('');

  document.getElementById('bsave').onclick=saveCfg;
  cfgLoaded=true;
}

async function saveCfg(){
  document.querySelectorAll('.err').forEach(e=>e.textContent='');
  const settings={};
  document.querySelectorAll('.f').forEach(row=>{
    const key=row.dataset.key, type=row.dataset.type;
    const el=row.querySelector('input,select');
    settings[key] = (type==='bool') ? el.checked
                  : (type==='enum'||type==='text'||type==='csv') ? el.value
                  : Number(el.value);
  });
  const freqs=[];
  document.querySelectorAll('[id^=fq_]').forEach(el=>{
    freqs.push({khz:Number(el.id.slice(3)), active:el.checked});
  });
  const on=freqs.filter(f=>f.active).length;
  if(on===0 && !confirm('No frequencies active. The recorder will refuse to start. Continue?')) return;

  const m=document.getElementById('savemsg');
  m.className='msg'; m.textContent='saving...';
  try{
    const r=await fetch('api/config',{method:'POST',
      headers:{'Content-Type':'application/json','X-HFGCS-Control':'1'},
      body:JSON.stringify({settings, frequencies:freqs})});
    const j=await r.json().catch(()=>({}));
    if(r.ok){
      m.className='msg ok';
      m.textContent = j.changed && j.changed.length
        ? j.changed.length+' change(s) saved - applies on next recorder start'
        : 'no changes';
    }else{
      m.className='msg err'; m.textContent=j.error||('HTTP '+r.status);
      for(const [k,v] of Object.entries(j.errors||{})){
        const e=document.getElementById('err_cf_'+k.split('.').join('_'));
        if(e) e.textContent=v;
      }
    }
  }catch(e){ m.className='msg err'; m.textContent='request failed: '+e.message; }
}

document.getElementById('settings').addEventListener('toggle', function(){
  if(this.open && !cfgLoaded) loadCfg();
});

tick(); setInterval(tick, 5000);
</script></body></html>`;
}

/**
 * Run one systemctl verb via sudo.
 *
 * sudo matches the FULL command line, so these argv arrays must correspond
 * exactly to /etc/sudoers.d/hfgcs. Adding or reordering a flag here fails with
 * a bare "permission denied" and no other clue.
 */
function defaultExec(action, unit, cb) {
  const argv = action === 'start'
    ? [SYSTEMCTL, 'start', '--no-block', unit]
    : [SYSTEMCTL, 'stop', unit];
  execFile(SUDO, argv, { timeout: 20000 }, (err, stdout, stderr) => {
    cb(err, String(stdout || '') + String(stderr || ''));
  });
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createServer(dataRoot, opts) {
  opts = opts || {};
  const eventsRoot = path.join(dataRoot, 'events');
  const enabledFile = opts.enabledFile || '/opt/hfgcs/config/ENABLED';
  const configFile = opts.configFile || '/opt/hfgcs/config/hfgcs.json';
  const backupDir = opts.backupDir || '/opt/hfgcs/backups';
  const unit = opts.unit || 'hfgcs-recorder';
  const exec = opts.exec || defaultExec;
  let lastControlAt = 0;

  // status.json OUTLIVES the process that wrote it, so its existence says
  // nothing about whether the recorder is running -- a stopped recorder left a
  // stale pid and uptime on the page and kept Start greyed out. systemd is the
  // only authoritative answer. `is-active` needs no privileges.
  let liveCache = { at: 0, active: false };
  const unitActive = (cb) => {
    const now = Date.now();
    if (now - liveCache.at < 2000) return cb(liveCache.active);
    if (opts.unitActive) {
      return opts.unitActive(unit, (a) => { liveCache = { at: now, active: a }; cb(a); });
    }
    execFile(SYSTEMCTL, ['is-active', unit], { timeout: 5000 }, (err, stdout) => {
      const a = String(stdout || '').trim() === 'active';
      liveCache = { at: now, active: a };
      cb(a);
    });
  };

  const authz = () => {
    let enabled = false;
    try { fs.accessSync(enabledFile, fs.constants.F_OK); enabled = true; } catch (_) {}
    return {
      enabled,
      canStart: enabled,
      canStop: true,
      enabledFile,
      unit,
      // Surfaced so the page can explain WHY start is unavailable rather than
      // silently hiding a button.
      reason: enabled ? null : 'config/ENABLED absent - authorise on the box'
    };
  };

  const handleControl = (req, res) => {
    if (!req.headers[CONTROL_HEADER]) {
      return sendJson(res, 403, { error: 'missing control header' });
    }
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let action;
      try { action = JSON.parse(body || '{}').action; } catch (_) {
        return sendJson(res, 400, { error: 'bad JSON' });
      }
      if (action !== 'start' && action !== 'stop') {
        return sendJson(res, 400, { error: "action must be 'start' or 'stop'" });
      }

      const now = Date.now();
      if (now - lastControlAt < CONTROL_MIN_INTERVAL_MS) {
        return sendJson(res, 429, {
          error: 'too soon', retryAfterMs: CONTROL_MIN_INTERVAL_MS - (now - lastControlAt)
        });
      }

      const a = authz();
      if (action === 'start' && !a.canStart) {
        // The unit would refuse anyway via preflight; failing here just gives
        // a readable reason instead of an opaque systemd error.
        return sendJson(res, 409, { error: 'not authorised', reason: a.reason });
      }

      lastControlAt = now;
      const who = clientIp(req);
      console.log('[control] ' + action + ' ' + unit + ' requested by ' + who);

      exec(action, unit, (err, output) => {
        if (err) {
          console.error('[control] ' + action + ' FAILED: ' + (err.message || err));
          return sendJson(res, 500, { error: 'command failed', detail: String(output).slice(0, 500) });
        }
        console.log('[control] ' + action + ' ok');
        sendJson(res, 200, { ok: true, action, unit });
      });
    });
  };

  const handleConfig = (req, res) => {
    if (!req.headers[CONTROL_HEADER]) {
      return sendJson(res, 403, { error: 'missing control header' });
    }
    let body = '';
    let tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return sendJson(res, 400, { error: 'bad JSON' }); }

      let result;
      try { result = configUi.apply(configFile, parsed, backupDir); }
      catch (e) {
        console.error('[config] write failed: ' + (e.code || '') + ' ' + e.message);
        return sendJson(res, 500, { error: 'write failed', code: e.code || null, detail: e.message });
      }

      if (!result.ok) return sendJson(res, 400, { error: 'validation failed', errors: result.errors });

      const who = clientIp(req);
      if (result.changed.length) {
        console.log('[config] ' + who + ' changed: ' + result.changed.join('; '));
      }
      sendJson(res, 200, { ok: true, changed: result.changed, appliesOnRestart: true });
    });
  };

  const readBody = (req, res, limit, cb) => {
    if (!req.headers[CONTROL_HEADER]) {
      return sendJson(res, 403, { error: 'missing control header' });
    }
    let body = '', tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > limit) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return;
      // Parse and handler are caught SEPARATELY. Wrapping both meant an EROFS
      // from a blocked filesystem write surfaced to the operator as "bad JSON",
      // which sent me looking at the request instead of the sandbox.
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return sendJson(res, 400, { error: 'bad JSON' }); }
      try { cb(parsed); }
      catch (e) {
        console.error('[api] handler failed: ' + (e.code || '') + ' ' + e.message);
        sendJson(res, 500, { error: 'handler failed', code: e.code || null, detail: e.message });
      }
    });
  };

  const handleLabel = (req, res) => readBody(req, res, 8 * 1024, (b) => {
    const r = labels.putLabel(dataRoot, b.id, b.label, clientIp(req));
    if (!r.ok) return sendJson(res, 400, r);
    sendJson(res, 200, Object.assign({ ok: true }, r, { stats: labels.labelStats(dataRoot) }));
  });

  const handleTrash = (req, res) => readBody(req, res, 256 * 1024, (b) => {
    const r = labels.trashCaptures(dataRoot, b.items, clientIp(req));
    console.log('[trash] ' + clientIp(req) + ' moved ' + r.moved + ' capture(s) to trash');
    sendJson(res, 200, Object.assign({ ok: true }, r));
  });

  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'POST' && url === '/api/control') return handleControl(req, res);
    if (req.method === 'POST' && url === '/api/config') return handleConfig(req, res);
    if (req.method === 'POST' && url === '/api/label') return handleLabel(req, res);
    if (req.method === 'POST' && url === '/api/trash') return handleTrash(req, res);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end('method not allowed');
    }
    if (url === '/api/authz') {
      return unitActive((running) =>
        sendJson(res, 200, Object.assign({ running }, authz())));
    }
    if (url === '/api/labels') {
      return sendJson(res, 200, {
        labels: labels.readLabels(dataRoot),
        stats: labels.labelStats(dataRoot),
        valid: labels.VALID_LABELS
      });
    }
    if (url === '/api/config') {
      try { return sendJson(res, 200, configUi.describe(configFile)); }
      catch (e) { return sendJson(res, 500, { error: 'cannot read config: ' + e.message }); }
    }
    if (url === '/' || url === '/index.html') {
      const body = Buffer.from(page());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
      });
      return res.end(body);
    }
    if (url === '/api/status') {
      const st = readJsonSafe(path.join(dataRoot, 'status.json'), null);
      if (!st) return sendJson(res, 503, { error: 'recorder not running' });
      return unitActive((running) => {
        if (!running) {
          // The file is a corpse. Say so rather than serving a stale pid.
          return sendJson(res, 503, { error: 'recorder not running', stale: true });
        }
        sendJson(res, 200, st);
      });
    }
    if (url === '/api/events') {
      const idx = readJsonSafe(path.join(dataRoot, 'index.json'), { events: [] });
      // index.json is written by the RECORDER and the monitor must not touch
      // it -- one writer per file. But deleting a capture leaves a stale row
      // behind, and if the recorder is stopped the index is never refreshed at
      // all: 55 files were trashed and all 56 rows stayed on the page, which
      // looked exactly like delete being broken.
      //
      // So filter on serve against what is actually on disk. That covers
      // trashed, retention-pruned and manually removed files alike, without
      // writing to anything we do not own.
      const events = (idx.events || []).filter((e) => {
        if (!e || !e.day || !e.file) return false;
        return fileExists(path.join(eventsRoot, e.day, e.file));
      });
      return sendJson(res, 200, {
        generatedAt: idx.generatedAt || null,
        count: events.length,
        hiddenMissing: (idx.events || []).length - events.length,
        events
      });
    }
    if (url === '/api/coverage') {
      return sendJson(res, 200, { rows: tailJsonl(path.join(dataRoot, 'coverage.jsonl'), 240) });
    }
    if (url.startsWith('/audio/')) return serveAudio(req, res, eventsRoot);

    res.writeHead(404); res.end('not found');
  });
}

function main() {
  const args = parseArgs(process.argv);
  const dataRoot = args.data || '/opt/hfgcs/data';
  const port = parseInt(args.port, 10) || 8898;
  const host = args.host || '127.0.0.1';
  const enabledFile = args['enabled-file'] ||
    (args.config ? path.join(path.dirname(args.config), 'ENABLED')
                 : '/opt/hfgcs/config/ENABLED');

  const server = createServer(dataRoot, {
    enabledFile,
    configFile: args.config || '/opt/hfgcs/config/hfgcs.json',
    backupDir: args['backup-dir'] || '/opt/hfgcs/backups',
    unit: args.unit || 'hfgcs-recorder'
  });
  server.listen(port, host, () => {
    console.log('[monitor] listening on http://' + host + ':' + port + ' data=' + dataRoot);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { createServer, parseArgs, page };
