// ╔══════════════════════════════════════════════════════════════╗
// ║  FANTA F1 2026 — Live Proxy  v1.0                           ║
// ║  Vercel Serverless Function                                  ║
// ║  Legge F1 LiveTiming SignalR e restituisce JSON pulito       ║
// ╚══════════════════════════════════════════════════════════════╝

const F1_SIGNALR_BASE = 'https://livetiming.formula1.com';

// Cache in memoria per tutta la durata dell'istanza Vercel (warm)
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 4000; // 4 secondi — abbastanza fresco per il live

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  // CORS — permetti il tuo dominio GitHub Pages o qualsiasi origine
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Servi dalla cache se fresca
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL_MS) {
    return res.status(200).json({ ..._cache, cached: true });
  }

  try {
    const data = await fetchF1Live();
    _cache = data;
    _cacheTime = now;
    return res.status(200).json({ ...data, cached: false });
  } catch (err) {
    // Se fallisce e abbiamo cache vecchia, la usiamo
    if (_cache) return res.status(200).json({ ..._cache, cached: true, stale: true });
    return res.status(503).json({ error: err.message, ts: new Date().toISOString() });
  }
}

// ─── FETCH PRINCIPALE ───────────────────────────────────────────
async function fetchF1Live() {
  // 1. Negotiation (handshake SignalR legacy)
  const negotiateUrl = `${F1_SIGNALR_BASE}/signalr/negotiate?connectionData=[{"name":"Streaming"}]&clientProtocol=1.5`;
  const negRes = await fetchWithTimeout(negotiateUrl, {
    headers: { 'User-Agent': 'BestHTTP', 'Accept-Encoding': 'gzip, identity', 'Connection': 'keep-alive' }
  }, 8000);

  if (!negRes.ok) throw new Error(`Negotiate HTTP ${negRes.status}`);
  const neg = await negRes.json();
  const token = encodeURIComponent(neg.ConnectionToken);

  // 2. Connect — legge il feed SSE/longpoll
  const connectUrl = `${F1_SIGNALR_BASE}/signalr/connect?transport=serverSentEvents&clientProtocol=1.5&connectionToken=${token}&connectionData=[{"name":"Streaming"}]&tid=10`;
  const connectRes = await fetchWithTimeout(connectUrl, {
    headers: {
      'User-Agent': 'BestHTTP',
      'Accept': 'text/event-stream',
      'Accept-Encoding': 'gzip, identity',
    }
  }, 8000);

  if (!connectRes.ok) throw new Error(`Connect HTTP ${connectRes.status}`);
  const connectBody = await connectRes.text();

  // 3. Subscribe ai topics che ci servono
  const subscribeUrl = `${F1_SIGNALR_BASE}/signalr/send?transport=serverSentEvents&clientProtocol=1.5&connectionToken=${token}`;
  await fetchWithTimeout(subscribeUrl, {
    method: 'POST',
    headers: {
      'User-Agent': 'BestHTTP',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `data=${encodeURIComponent(JSON.stringify({
      H: 'Streaming',
      M: 'Subscribe',
      A: [['TimingData', 'TimingAppData', 'TrackStatus', 'RaceControlMessages', 'SessionInfo', 'SessionData', 'LapCount', 'DriverList', 'WeatherData', 'SessionStatus']],
      I: 1
    }))}`
  }, 5000);

  // 4. Poll per i dati
  const pollUrl = `${F1_SIGNALR_BASE}/signalr/poll?transport=serverSentEvents&clientProtocol=1.5&connectionToken=${token}&connectionData=[{"name":"Streaming"}]&tid=10`;
  const pollRes = await fetchWithTimeout(pollUrl, {
    headers: { 'User-Agent': 'BestHTTP', 'Accept-Encoding': 'gzip, identity' }
  }, 8000);

  if (!pollRes.ok) throw new Error(`Poll HTTP ${pollRes.status}`);
  const pollBody = await pollRes.text();

  // 5. Parse e normalizza
  return parseF1Data(pollBody);
}

// ─── PARSE ──────────────────────────────────────────────────────
function parseF1Data(raw) {
  let msgs = [];
  // Il feed può essere SSE (data: {...}\n\n) o JSON diretto
  if (raw.startsWith('data:')) {
    raw.split('\n').forEach(line => {
      if (line.startsWith('data:')) {
        try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    });
  } else {
    try { msgs = [JSON.parse(raw)]; } catch {}
  }

  // Stato output
  const out = {
    ts: new Date().toISOString(),
    sessionType: null,    // 'Race' | 'Qualifying' | 'Sprint' | 'Sprint Qualifying'
    sessionStatus: null,  // 'Started' | 'Finished' | 'Aborted' | 'Inactive'
    trackStatus: 'AllClear', // 'AllClear' | 'Yellow' | 'SCDeployed' | 'VSCDeployed' | 'Red'
    trackStatusMsg: null,
    lap: null,
    totalLaps: null,
    drivers: {},          // { [driverNum]: { pos, name, team, abbr, gap, interval, sectors, lastLap, pits, tyre, tyreAge, isKO, isRetired } }
    rcMessages: [],       // Race Control messages recenti
    weather: null,
    scCount: 0,
    rfCount: 0,
    dnfCount: 0,
  };

  for (const msg of msgs) {
    if (!msg?.M) continue;
    for (const m of msg.M) {
      if (!m?.A) continue;
      const [topicName, topicData] = m.A;
      applyTopic(out, topicName, topicData);
    }
    // Anche messaggi tipo snapshot iniziale
    if (msg.R) applySnapshot(out, msg.R);
  }

  return out;
}

function applySnapshot(out, snap) {
  if (snap.TimingData) applyTopic(out, 'TimingData', snap.TimingData);
  if (snap.TrackStatus) applyTopic(out, 'TrackStatus', snap.TrackStatus);
  if (snap.RaceControlMessages) applyTopic(out, 'RaceControlMessages', snap.RaceControlMessages);
  if (snap.SessionInfo) applyTopic(out, 'SessionInfo', snap.SessionInfo);
  if (snap.LapCount) applyTopic(out, 'LapCount', snap.LapCount);
  if (snap.DriverList) applyTopic(out, 'DriverList', snap.DriverList);
  if (snap.WeatherData) applyTopic(out, 'WeatherData', snap.WeatherData);
  if (snap.SessionStatus) applyTopic(out, 'SessionStatus', snap.SessionStatus);
  if (snap.TimingAppData) applyTopic(out, 'TimingAppData', snap.TimingAppData);
}

function applyTopic(out, name, data) {
  if (!data) return;

  if (name === 'SessionInfo') {
    out.sessionType = data.Type || data.Name || null;
  }

  if (name === 'SessionStatus') {
    out.sessionStatus = data.Status || null;
  }

  if (name === 'TrackStatus') {
    const statusMap = {
      '1': 'AllClear', '2': 'Yellow', '4': 'SCDeployed',
      '5': 'Red', '6': 'VSCDeployed', '7': 'VSCEnding'
    };
    out.trackStatus = statusMap[String(data.Status)] || data.Status || 'AllClear';
    out.trackStatusMsg = data.Message || null;
  }

  if (name === 'LapCount') {
    if (data.CurrentLap != null) out.lap = data.CurrentLap;
    if (data.TotalLaps != null) out.totalLaps = data.TotalLaps;
  }

  if (name === 'WeatherData') {
    out.weather = {
      airTemp: data.AirTemp,
      trackTemp: data.TrackTemp,
      windSpeed: data.WindSpeed,
      humidity: data.Humidity,
      rainfall: data.Rainfall === 'true' || data.Rainfall === true,
    };
  }

  if (name === 'DriverList') {
    for (const [num, d] of Object.entries(data)) {
      if (!out.drivers[num]) out.drivers[num] = {};
      out.drivers[num].num = num;
      out.drivers[num].name = d.FullName || d.BroadcastName || null;
      out.drivers[num].abbr = d.Tla || null;
      out.drivers[num].team = d.TeamName || null;
      out.drivers[num].teamColor = d.TeamColour || null;
    }
  }

  if (name === 'TimingData') {
    const lines = data.Lines || {};
    for (const [num, line] of Object.entries(lines)) {
      if (!out.drivers[num]) out.drivers[num] = { num };
      const d = out.drivers[num];
      if (line.Position != null) d.pos = parseInt(line.Position);
      if (line.GapToLeader != null) d.gap = line.GapToLeader;
      if (line.IntervalToPositionAhead?.Value != null) d.interval = line.IntervalToPositionAhead.Value;
      if (line.LastLapTime?.Value != null) d.lastLap = line.LastLapTime.Value;
      if (line.BestLapTime?.Value != null) d.bestLap = line.BestLapTime.Value;
      if (line.NumberOfPitStops != null) d.pits = parseInt(line.NumberOfPitStops);
      if (line.KnockedOut != null) d.isKO = line.KnockedOut; // qualifiche
      if (line.Retired != null) d.isRetired = line.Retired;
      if (line.Stopped != null) d.isStopped = line.Stopped;
      // Settori
      if (line.Sectors) {
        d.sectors = Object.entries(line.Sectors).map(([, s]) => ({
          value: s.Value,
          status: s.Status,
          previousValue: s.PreviousValue,
        }));
      }
      // Tempi Q (qualifying)
      if (line.Stats) d.stats = line.Stats;
      if (line.BestLapTimes) d.bestLapTimes = line.BestLapTimes;
    }
  }

  if (name === 'TimingAppData') {
    const lines = data.Lines || {};
    for (const [num, line] of Object.entries(lines)) {
      if (!out.drivers[num]) out.drivers[num] = { num };
      if (line.Stints) {
        const stints = Object.values(line.Stints);
        const last = stints[stints.length - 1];
        if (last) {
          out.drivers[num].tyre = last.Compound || null;
          out.drivers[num].tyreAge = last.TotalLaps || last.New != null ? (last.TotalLaps || 0) : null;
          out.drivers[num].tyreNew = last.New === 'true' || last.New === true;
        }
      }
    }
  }

  if (name === 'RaceControlMessages') {
    const msgs = data.Messages || {};
    const arr = Array.isArray(msgs) ? msgs : Object.values(msgs);
    // Prendi gli ultimi 30 messaggi
    out.rcMessages = arr.slice(-30).map(m => ({
      ts: m.Utc || m.Time,
      category: m.Category,
      flag: m.Flag,
      msg: m.Message,
      scope: m.Scope,
      sector: m.Sector,
    })).reverse(); // più recenti prima

    // Conta SC e RF
    let sc = 0, rf = 0, dnf = 0;
    const scSeen = new Set();
    arr.forEach(m => {
      const msg = (m.Message || '').toUpperCase();
      const flag = (m.Flag || '').toUpperCase();
      const c = msg + ' ' + flag;
      if ((c.includes('SAFETY CAR') && !c.includes('VIRTUAL')) && !scSeen.has(msg.substring(0, 30))) {
        sc++; scSeen.add(msg.substring(0, 30));
      }
      if (c.includes('RED FLAG') || flag === 'RED') rf++;
      if (c.includes('RETIRED') || c.includes('RETIRE')) dnf++;
    });
    out.scCount = sc;
    out.rfCount = rf;
    out.dnfCount = dnf;
  }
}

// ─── UTILITY ────────────────────────────────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
