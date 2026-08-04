'use strict';
//
// public.js -- the read-only view, served without authentication.
//
// WHAT THIS DELIBERATELY DOES NOT HAVE
// ------------------------------------
// No settings, no start/stop, no delete, no labelling, no receiver health, no
// blocklist. It answers GET and HEAD and nothing else. The operator interface
// stays behind basic auth on /hfgcs/; this is a separate handler rather than
// the same page with things hidden, because "hidden" is not "absent" and a
// stray fetch() would still reach a control endpoint.
//
// It also does not name the receivers. A KiwiSDR is somebody's hardware in
// somebody's house, and publishing "this address was recording HFGCS at 03:00"
// to anyone who wanders past is not a thing to do without asking them. The map
// shows approximate locations because that is the interesting part; the
// endpoint stays on the private page.

const fs = require('fs');
const path = require('path');
const http = require('http');

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.(wav|opus|png)$/;

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=30'
  });
  res.end(body);
}

/** Round to ~11 km so a receiver's exact street is not published. */
function coarse(v) {
  return (v == null || !Number.isFinite(v)) ? null : Math.round(v * 10) / 10;
}

/**
 * Strip a capture record down to what a stranger should see.
 * Receiver endpoint, internal ids and detector diagnostics are all withheld.
 */
function publicEvent(e) {
  const f = e.features || {};
  return {
    day: e.day,
    file: e.file,
    thumb: e.thumb || null,
    freqKHz: e.freqKHz,
    startedAt: e.startedAt,
    durationSec: e.durationSec,
    lat: coarse(e.lat),
    lon: coarse(e.lon),
    // Kept because they are the honest measure of what the detector thought,
    // and a reader deserves to see that rather than a bare "voice" claim.
    voiced: e.peakVoicedFraction != null ? e.peakVoicedFraction
          : (f.harmonicVoicedFraction != null ? f.harmonicVoicedFraction : null),
    harmonicity: f.harmonicityP90 != null ? f.harmonicityP90 : null
  };
}

function serveAudio(req, res, eventsRoot) {
  const m = /^\/audio\/([^/]+)\/([^/]+)$/.exec(decodeURIComponent(req.url.split('?')[0]));
  if (!m) { res.writeHead(404); return res.end('not found'); }
  const [, day, file] = m;
  if (!DAY_RE.test(day) || !FILE_RE.test(file)) { res.writeHead(400); return res.end('bad path'); }

  const full = path.resolve(eventsRoot, day, file);
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
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    // Audio never changes once written; a thumbnail can be re-rendered when the
    // renderer improves, and a day-long cache made those invisible.
    'Cache-Control': file.endsWith('.png') ? 'no-cache' : 'public, max-age=86400',
    'ETag': '"' + Math.round(st.mtimeMs).toString(36) + '-' + st.size.toString(36) + '"'
  });
  fs.createReadStream(full).pipe(res);
}

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HFGCS Monitor</title>
<style>
 :root{--bg:#0d1117;--fg:#c9d1d9;--dim:#8b949e;--line:#21262d;--accent:#58a6ff}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);
      font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
 header{padding:20px;border-bottom:1px solid var(--line)}
 h1{margin:0;font-size:18px}
 .sub{color:var(--dim);font-size:12px;margin-top:6px;max-width:70ch}
 a{color:var(--accent)}
 .wrap{padding:20px;max-width:1200px}
 h2{font-size:13px;color:var(--accent);margin:26px 0 8px;font-weight:600}
 svg.map{width:100%;height:auto;background:#0b1622;border:1px solid var(--line);border-radius:6px}
 .grat{stroke:#182534;stroke-width:.5;fill:none}
 .term{fill:#000;opacity:.28}
 .path{stroke:#2f6f4f;stroke-width:.7;fill:none;opacity:.55}
 .stn{fill:#d29922}
 .stn.off{fill:#39414d}
 .rx{fill:#58a6ff}
 .lbl{fill:#6e7681;font:3.4px ui-monospace,monospace}
 table{width:100%;border-collapse:collapse;margin-top:6px}
 th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);font-size:12px;vertical-align:middle}
 th{color:var(--dim);font-weight:500}
 .thumb{display:block;width:360px;height:auto;max-height:144px;border-radius:4px;
        border:1px solid var(--line);background:#0d1117}
 audio{height:30px}
 .note{color:var(--dim);font-size:11px}
 .legend{color:var(--dim);font-size:11px;margin:8px 0 0}
 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle}
 footer{margin-top:36px;padding:16px 20px;border-top:1px solid var(--line);
        color:var(--dim);font-size:11px;line-height:1.9}
 .empty{color:var(--dim);padding:20px 0}
</style></head><body>
<header>
  <h1>HFGCS Monitor</h1>
  <div class="sub">
    Automatic recordings of USAF High Frequency Global Communications System voice
    transmissions, captured through volunteer-run <a href="http://kiwisdr.com/">KiwiSDR</a>
    receivers around the world. Detection is automatic and imperfect &mdash; some of
    what is below is static.
  </div>
</header>
<div class="wrap">

  <h2>Receivers and ground stations</h2>
  <svg class="map" id="map" viewBox="0 0 360 180" preserveAspectRatio="xMidYMid meet"></svg>
  <div class="legend">
    <span class="dot" style="background:#d29922"></span>ground station, scheduled on air now &nbsp;
    <span class="dot" style="background:#39414d"></span>ground station, off schedule &nbsp;
    <span class="dot" style="background:#58a6ff"></span>receiver that produced a capture &nbsp;
    <span style="color:#2f6f4f">&mdash;</span> great-circle path &nbsp;|&nbsp; shaded = night
  </div>
  <div class="note" id="mapnote" style="margin-top:6px"></div>

  <h2>Recent captures</h2>
  <table>
    <thead><tr><th>UTC</th><th>kHz</th><th>dur</th><th>signal</th><th>voiced</th><th>listen</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">No captures yet.</div>
</div>

<footer>
  Runs on receivers other people pay for and maintain. Sessions are capped and
  rotated, one slot at a time, and any operator who would rather not take part is
  excluded on request &mdash; see
  <a href="https://github.com/Chipensaw/HFGCS-Monitor-KiwiSDR">the source</a>.<br>
  Receiver positions are rounded and endpoints are not published.
  Detection thresholds are provisional; this is a sampling recorder and it misses
  transmissions.
</footer>

<script>
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const X = lon => (lon + 180);
const Y = lat => (90 - lat);

function greatCircle(a, b, n){
  const rad = Math.PI/180, dg = 180/Math.PI;
  const p1 = [a.lat*rad, a.lon*rad], p2 = [b.lat*rad, b.lon*rad];
  const d = 2*Math.asin(Math.sqrt(Math.pow(Math.sin((p1[0]-p2[0])/2),2)
        + Math.cos(p1[0])*Math.cos(p2[0])*Math.pow(Math.sin((p1[1]-p2[1])/2),2)));
  if(!d) return [];
  const pts=[];
  for(let i=0;i<=n;i++){
    const f=i/n;
    const A=Math.sin((1-f)*d)/Math.sin(d), B=Math.sin(f*d)/Math.sin(d);
    const x=A*Math.cos(p1[0])*Math.cos(p1[1])+B*Math.cos(p2[0])*Math.cos(p2[1]);
    const y=A*Math.cos(p1[0])*Math.sin(p1[1])+B*Math.cos(p2[0])*Math.sin(p2[1]);
    const z=A*Math.sin(p1[0])+B*Math.sin(p2[0]);
    pts.push([Math.atan2(z,Math.sqrt(x*x+y*y))*dg, Math.atan2(y,x)*dg]);
  }
  return pts;
}

// Solar declination and the subsolar longitude, for the night shading.
function subsolar(now){
  const d = now/86400000 + 2440587.5 - 2451545.0;
  const g = ((357.528 + 0.9856003*d) % 360) * Math.PI/180;
  const L = (280.460 + 0.9856474*d) % 360;
  const lam = (L + 1.915*Math.sin(g) + 0.020*Math.sin(2*g)) * Math.PI/180;
  const eps = 23.439 * Math.PI/180;
  const dec = Math.asin(Math.sin(eps)*Math.sin(lam)) * 180/Math.PI;
  let gmst = (18.697374558 + 24.06570982441908*d) % 24;
  if(gmst<0) gmst+=24;
  return { dec, lon: -(gmst*15) % 360 };
}

function nightPath(now){
  const s = subsolar(now);
  const rad=Math.PI/180;
  const pts=[];
  for(let lon=-180; lon<=180; lon+=2){
    // terminator latitude for this longitude
    const h=(lon - s.lon)*rad;
    const lat = Math.atan(-Math.cos(h)/Math.tan(s.dec*rad || 1e-6))/rad;
    pts.push([lon, lat]);
  }
  const top = s.dec > 0 ? -90 : 90;
  let d='M '+pts.map(p=>X(p[0]).toFixed(1)+' '+Y(p[1]).toFixed(1)).join(' L ');
  d += ' L '+X(180)+' '+Y(top)+' L '+X(-180)+' '+Y(top)+' Z';
  return d;
}

function schedActive(spec, hour){
  if(spec==='24h') return true;
  const [a,b]=spec.split('-').map(v=>parseInt(v,10)/100);
  return a<b ? (hour>=a && hour<b) : (hour>=a || hour<b);
}

async function draw(){
  let d;
  try{ d = await fetch('api/public').then(r=>r.json()); }catch(e){ return; }
  const now = Date.now();
  const hour = new Date(now).getUTCHours();
  const svg = document.getElementById('map');
  let out = '';

  out += '<path class="term" d="'+nightPath(now)+'"/>';
  for(let lat=-60; lat<=60; lat+=30) out += '<line class="grat" x1="0" y1="'+Y(lat)+'" x2="360" y2="'+Y(lat)+'"/>';
  for(let lon=-120; lon<=120; lon+=60) out += '<line class="grat" x1="'+X(lon)+'" y1="0" x2="'+X(lon)+'" y2="180"/>';

  // receiver -> station paths, for the frequencies that actually produced captures
  const rx = d.receivers||[];
  const stations = d.stations||[];
  for(const r of rx){
    for(const st of stations){
      const spec = st.schedule[String(r.freqKHz)];
      if(!spec || !schedActive(spec, hour)) continue;
      const pts = greatCircle(r, st, 48);
      if(!pts.length) continue;
      // split where the path crosses the antimeridian
      let seg=[], segs=[];
      let prev=null;
      for(const p of pts){
        if(prev!==null && Math.abs(p[1]-prev)>180){ segs.push(seg); seg=[]; }
        seg.push(p); prev=p[1];
      }
      segs.push(seg);
      for(const s of segs){
        if(s.length<2) continue;
        out += '<path class="path" d="M '+s.map(p=>X(p[1]).toFixed(1)+' '+Y(p[0]).toFixed(1)).join(' L ')+'"/>';
      }
    }
  }

  for(const st of stations){
    const anyOn = Object.values(st.schedule).some(v=>schedActive(v,hour));
    out += '<circle class="stn'+(anyOn?'':' off')+'" cx="'+X(st.lon)+'" cy="'+Y(st.lat)+'" r="1.6"/>';
    out += '<text class="lbl" x="'+(X(st.lon)+2.4)+'" y="'+(Y(st.lat)+1.2)+'">'+esc(st.name)+'</text>';
  }
  for(const r of rx){
    out += '<circle class="rx" cx="'+X(r.lon)+'" cy="'+Y(r.lat)+'" r="1.3"/>';
  }
  svg.innerHTML = out;

  document.getElementById('mapnote').textContent =
    stations.length+' ground stations, '+rx.length+' receiver location(s) with captures. '
    +'Paths are drawn to stations scheduled on air at '+String(hour).padStart(2,'0')+':00 UTC.';

  const rows = d.events||[];
  document.getElementById('empty').style.display = rows.length?'none':'block';
  document.getElementById('rows').innerHTML = rows.map(e=>{
    const thumb = e.thumb
      ? '<img class="thumb" loading="lazy" src="audio/'+encodeURIComponent(e.day)+'/'+encodeURIComponent(e.thumb)+'?v='+encodeURIComponent(e.startedAt||'')+'" alt="waterfall">'
      : '<span class="note">--</span>';
    const v = e.voiced!=null ? (100*e.voiced).toFixed(1)+'%' : '--';
    return '<tr><td>'+esc((e.startedAt||'').replace('T',' ').slice(0,19))+'</td>'
      +'<td>'+esc(e.freqKHz)+'</td>'
      +'<td>'+(e.durationSec!=null?e.durationSec.toFixed(1)+'s':'--')+'</td>'
      +'<td>'+thumb+'</td><td>'+v+'</td>'
      +'<td><audio controls preload="none" src="audio/'+encodeURIComponent(e.day)+'/'+encodeURIComponent(e.file)+'"></audio></td></tr>';
  }).join('');
}
draw();
setInterval(draw, 60000);
</script></body></html>`;
}

function createServer(dataRoot, opts) {
  opts = opts || {};
  const eventsRoot = path.join(dataRoot, 'events');
  const stationsFile = opts.stationsFile || path.join(__dirname, '..', 'scheduler', 'stations.json');
  const limit = opts.limit || 100;

  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // Read-only, absolutely. No POST handler exists to be reached.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end('method not allowed');
    }

    if (url === '/' || url === '/index.html') {
      const body = Buffer.from(page());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=60'
      });
      return res.end(body);
    }

    if (url === '/api/public') {
      const idx = readJsonSafe(path.join(dataRoot, 'index.json'), { events: [] });
      const st = readJsonSafe(stationsFile, { stations: [] });

      const events = (idx.events || [])
        .filter((e) => e && e.day && e.file)
        .filter((e) => {
          try { fs.accessSync(path.join(eventsRoot, e.day, e.file), fs.constants.F_OK); return true; }
          catch (_) { return false; }
        })
        .slice(0, limit)
        .map(publicEvent);

      // Distinct receiver positions that actually produced something, so the
      // map shows where captures came from rather than the whole cohort.
      const seen = new Set();
      const receivers = [];
      for (const e of events) {
        if (e.lat == null || e.lon == null) continue;
        const k = e.lat + ',' + e.lon + ',' + e.freqKHz;
        if (seen.has(k)) continue;
        seen.add(k);
        receivers.push({ lat: e.lat, lon: e.lon, freqKHz: e.freqKHz });
      }

      return sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        count: events.length,
        events,
        receivers,
        stations: st.stations || []
      });
    }

    if (url.startsWith('/audio/')) return serveAudio(req, res, eventsRoot);

    res.writeHead(404); res.end('not found');
  });
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    if (m) out[m[1]] = m[2] === '' ? true : m[2];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const dataRoot = args.data || '/opt/hfgcs/data';
  const port = parseInt(args.port, 10) || 8899;
  const host = args.host || '127.0.0.1';
  const server = createServer(dataRoot, { stationsFile: args.stations });
  server.listen(port, host, () => {
    console.log('[public] listening on http://' + host + ':' + port + ' data=' + dataRoot);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { createServer, page, publicEvent, coarse, parseArgs };
