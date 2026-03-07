// FANTA F1 2026 — Live Proxy v2
// Vercel Serverless Function — Node 18+

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const data = await fetchF1SignalR();
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({
      error: err.message,
      ts: new Date().toISOString(),
      sessionType: null,
      sessionStatus: null,
      trackStatus: 'AllClear',
      lap: null,
      totalLaps: null,
      scCount: 0,
      rfCount: 0,
      dnfCount: 0,
      drivers: {},
      rcMessages: [],
      weather: null,
      cached: false
    });
  }
}

async function fetchF1SignalR() {
  const BASE = 'https://livetiming.formula1.com';

  // Step 1: Negotiate
  const negUrl = `${BASE}/signalr/negotiate?connectionData=[{"name":"Streaming"}]&clientProtocol=1.5`;
  const negRes = await fetchTimeout(negUrl, { headers: { 'User-Agent': 'BestHTTP' } }, 8000);
  if (!negRes.ok) throw new Error(`Negotiate failed: ${negRes.status}`);
  const neg = await negRes.json();
  const token = encodeURIComponent(neg.ConnectionToken);

  // Step 2: Connect
  const conUrl = `${BASE}/signalr/connect?transport=serverSentEvents&clientProtocol=1.5&connectionToken=${token}&connectionData=[{"name":"Streaming"}]&tid=10`;
  const conRes = await fetchTimeout(conUrl, { headers: { 'User-Agent': 'BestHTTP', 'Accept': 'text/event-stream' } }, 8000);
  if (!conRes.ok) throw new Error(`Connect failed: ${conRes.status}`);

  // Step 3: Subscribe
  const subUrl = `${BASE}/signalr/send?transport=serverSentEvents&clientProtocol=1.5&connectionToken=${token}`;
  await fetchTimeout(subUrl, {
    method: 'POST',
    headers: { 'User-Agent': 'BestHTTP', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(JSON.stringify({
      H: 'Streaming', M: 'Subscribe',
      A: [['TimingData', 'TimingAppData', 'TrackStatus', 'RaceControlMessages', 'SessionInfo', 'LapCount', 'DriverList', 'WeatherData', 'SessionStatus']],
      I: 1
    }))}`
  }, 5000);

  // Step 4: Poll
  const pollUrl = `${BASE}/signalr/poll?transport=serverSentEvents&clientProtocol=1.5&connectionToken=${token}&connectionData=[{"name":"Streaming"}]&tid=10`;
  const pollRes = await fetchTimeout(pollUrl, { headers: { 'User-Agent': 'BestHTTP' } }, 8000);
  if (!pollRes.ok) throw new Error(`Poll failed: ${pollRes.status}`);
  const raw = await pollRes.text();

  return parse(raw);
}

function parse(raw) {
  const out = {
    ts: new Date().toISOString(),
    sessionType: null,
    sessionStatus: null,
    trackStatus: 'AllClear',
    trackStatusMsg: null,
    lap: null,
    totalLaps: null,
    scCount: 0,
    rfCount: 0,
    dnfCount: 0,
    drivers: {},
    rcMessages: [],
    weather: null,
    cached: false
  };

  let msgs = [];
  if (raw.startsWith('data:')) {
    raw.split('\n').forEach(line => {
      if (line.startsWith('data:')) {
        try { msgs.push(JSON.parse(line.slice(5).trim())); } catch {}
      }
    });
  } else {
    try { msgs = [JSON.parse(raw)]; } catch {}
  }

  for (const msg of msgs) {
    if (msg?.R) applySnap(out, msg.R);
    if (msg?.M) {
      for (const m of msg.M) {
        if (m?.A?.length >= 2) applyTopic(out, m.A[0], m.A[1]);
      }
    }
  }

  return out;
}

function applySnap(out, snap) {
  const topics = ['SessionInfo','SessionStatus','TrackStatus','LapCount','DriverList','WeatherData','TimingData','TimingAppData','RaceControlMessages'];
  topics.forEach(t => { if (snap[t]) applyTopic(out, t, snap[t]); });
}

function applyTopic(out, name, data) {
  if (!data) return;

  if (name === 'SessionInfo') out.sessionType = data.Type || data.Name || null;
  if (name === 'SessionStatus') out.sessionStatus = data.Status || null;

  if (name === 'TrackStatus') {
    const map = { '1':'AllClear','2':'Yellow','4':'SCDeployed','5':'Red','6':'VSCDeployed','7':'VSCEnding' };
    out.trackStatus = map[String(data.Status)] || 'AllClear';
    out.trackStatusMsg = data.Message || null;
  }

  if (name === 'LapCount') {
    if (data.CurrentLap != null) out.lap = data.CurrentLap;
    if (data.TotalLaps != null) out.totalLaps = data.TotalLaps;
  }

  if (name === 'WeatherData') {
    out.weather = { airTemp: data.AirTemp, trackTemp: data.TrackTemp, windSpeed: data.WindSpeed, humidity: data.Humidity, rainfall: data.Rainfall === 'true' || data.Rainfall === true };
  }

  if (name === 'DriverList') {
    Object.entries(data).forEach(([num, d]) => {
      if (!out.drivers[num]) out.drivers[num] = { num };
      Object.assign(out.drivers[num], { name: d.FullName || d.BroadcastName || null, abbr: d.Tla || null, team: d.TeamName || null, teamColor: d.TeamColour || null });
    });
  }

  if (name === 'TimingData') {
    Object.entries(data.Lines || {}).forEach(([num, line]) => {
      if (!out.drivers[num]) out.drivers[num] = { num };
      const d = out.drivers[num];
      if (line.Position != null) d.pos = parseInt(line.Position);
      if (line.GapToLeader != null) d.gap = line.GapToLeader;
      if (line.IntervalToPositionAhead?.Value != null) d.interval = line.IntervalToPositionAhead.Value;
      if (line.LastLapTime?.Value != null) d.lastLap = line.LastLapTime.Value;
      if (line.BestLapTime?.Value != null) d.bestLap = line.BestLapTime.Value;
      if (line.NumberOfPitStops != null) d.pits = parseInt(line.NumberOfPitStops);
      if (line.KnockedOut != null) d.isKO = line.KnockedOut;
      if (line.Retired != null) d.isRetired = line.Retired;
      if (line.Stopped != null) d.isStopped = line.Stopped;
      if (line.Sectors) {
        d.sectors = Object.values(line.Sectors).map(s => ({ value: s.Value, status: s.Status }));
      }
    });
  }

  if (name === 'TimingAppData') {
    Object.entries(data.Lines || {}).forEach(([num, line]) => {
      if (!out.drivers[num]) out.drivers[num] = { num };
      if (line.Stints) {
        const stints = Object.values(line.Stints);
        const last = stints[stints.length - 1];
        if (last) {
          out.drivers[num].tyre = last.Compound || null;
          out.drivers[num].tyreAge = last.TotalLaps || 0;
          out.drivers[num].tyreNew = last.New === 'true' || last.New === true;
        }
      }
    });
  }

  if (name === 'RaceControlMessages') {
    const arr = Array.isArray(data.Messages) ? data.Messages : Object.values(data.Messages || {});
    out.rcMessages = arr.slice(-30).map(m => ({
      ts: m.Utc || m.Time, category: m.Category, flag: m.Flag, msg: m.Message, scope: m.Scope
    })).reverse();

    let sc = 0, rf = 0, dnf = 0;
    const seen = new Set();
    arr.forEach(m => {
      const c = ((m.Message || '') + ' ' + (m.Flag || '')).toUpperCase();
      if (c.includes('SAFETY CAR') && !c.includes('VIRTUAL') && !seen.has(c.slice(0,30))) { sc++; seen.add(c.slice(0,30)); }
      if (c.includes('RED FLAG') || m.Flag === 'RED') rf++;
      if (c.includes('RETIRED') || c.includes('RETIRE')) dnf++;
    });
    out.scCount = sc; out.rfCount = rf; out.dnfCount = dnf;
  }
}

function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}
