// Deurbel — eigen app voor je Eufy-deurbel
// Praat met eufy-security-ws via WebSocket. Geen npm-pakketten nodig (Node 22+), wel ffmpeg.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

// ================= Instellingen =================
const ENV = {
  port: Number(process.env.PORT || 8080),
  eufyWs: process.env.EUFY_WS || "ws://127.0.0.1:3000",
  dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
  pin: (process.env.APP_PIN || "").trim(),
  deviceSerial: (process.env.DEVICE_SERIAL || "").trim(),
  ntfyUrl: (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, ""),
  ntfyTopic: (process.env.NTFY_TOPIC || "").trim(),
  ntfyToken: (process.env.NTFY_TOKEN || "").trim(),
  publicUrl: (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, ""),
  maxEvents: Number(process.env.MAX_EVENTS || 1000),
  tz: process.env.TZ || "Europe/Amsterdam",
};
const SCHEMA = 21;
const SNAP_DIR = path.join(ENV.dataDir, "snapshots");
const REC_DIR = path.join(ENV.dataDir, "recordings");
const TMP_DIR = path.join(ENV.dataDir, "tmp");
const TL_DIR = path.join(ENV.dataDir, "timelapse");
for (const d of [SNAP_DIR, REC_DIR, TMP_DIR, TL_DIR]) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, f), { force: true });

const log = (...a) => console.log(new Date().toLocaleTimeString("nl-NL", { timeZone: ENV.tz }), ...a);

function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; } }
const writers = {};
function writeJson(file, data) {
  clearTimeout(writers[file]);
  writers[file] = setTimeout(() => {
    fs.writeFile(file + ".tmp", JSON.stringify(data), (err) => { if (!err) fs.rename(file + ".tmp", file, () => {}); });
  }, 400);
}

// Instellingen die je in het dashboard kunt aanpassen (env = beginwaarde)
const SETTINGS_FILE = path.join(ENV.dataDir, "settings.json");
const settings = Object.assign({
  storageGb: Number(process.env.STORAGE_GB || 10),
  autoDownload: process.env.AUTO_DOWNLOAD || "important", // all | important | off
  keepDays: Number(process.env.KEEP_DAYS || 0),            // 0 = alleen GB-limiet
  notifyRing: true,
  notifyPerson: (process.env.NOTIFY_PERSON || "true") === "true",
  notifyMotion: (process.env.NOTIFY_MOTION || "false") === "true",
  notifyPackage: true,
  ntfySnapshot: (process.env.NTFY_SNAPSHOT || "true") === "true",
  motionCooldown: Number(process.env.MOTION_COOLDOWN_SECONDS || 120),
  liveMaxSeconds: Number(process.env.LIVE_MAX_SECONDS || 300),
  recordOn: { ring: true, person: true, motion: false, package: true },
  recordSeconds: Number(process.env.RECORD_SECONDS || 30),
  snapshotMinutes: Number(process.env.SNAPSHOT_MINUTES ?? 60),
  snapshotOnEvent: true,
  quiet: { enabled: false, from: "23:00", to: "07:00", allow: ["ring"] },
  notifyOnlyAway: false,
  muteUntil: 0,
  timelapse: true,
  timelapseDays: Number(process.env.TIMELAPSE_DAYS || 30),
  useEufyPicture: false,
}, readJson(SETTINGS_FILE, {}));
if (!settings.recordOn) settings.recordOn = { ring: true, person: true, motion: false, package: true };

let secret;
try { secret = fs.readFileSync(path.join(ENV.dataDir, "secret"), "utf8"); }
catch { secret = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(path.join(ENV.dataDir, "secret"), secret); }
// ================= Pincodes =================
// security.json bewaart de pincode van de app en per camera (gehasht). De eerste keer
// wordt APP_PIN uit .env overgenomen; daarna pas je hem aan in het dashboard.
// Pincode vergeten? Verwijder deurbel-data/security.json, dan geldt weer APP_PIN uit .env.
const SEC_FILE = path.join(ENV.dataDir, "security.json");
const sec = readJson(SEC_FILE, {});
const hashPin = (pin, salt = crypto.randomBytes(8).toString("hex")) => ({ salt, hash: crypto.scryptSync(String(pin), salt, 32).toString("hex") });
const checkPin = (pin, h) => { if (!h) return false; const a = Buffer.from(hashPin(String(pin ?? ""), h.salt).hash, "hex"); return crypto.timingSafeEqual(a, Buffer.from(h.hash, "hex")); };
if (sec.appPin === undefined) sec.appPin = ENV.pin ? hashPin(ENV.pin) : null;
sec.camPins = sec.camPins || {};
function saveSec() { fs.writeFileSync(SEC_FILE, JSON.stringify(sec, null, 1), { mode: 0o600 }); }
saveSec();
const hmac = (x) => crypto.createHmac("sha256", secret).update(x).digest("hex");
// Huisgenoten: elke gebruiker heeft een eigen pincode, rol en cameratoegang.
// Bestaande app-pincode wordt de eerste beheerder.
if (!Array.isArray(sec.users)) {
  sec.users = sec.appPin ? [{ id: "owner", name: "Eigenaar", pin: sec.appPin, role: "admin", cams: "all", notify: true }] : [];
  saveSec();
}
const OPEN_USER = { id: "open", name: "Iedereen", role: "admin", cams: "all" };
const userToken = (u) => u.id + "." + hmac("user:" + u.id + ":" + u.pin.hash).slice(0, 40);
function currentUser(req) {
  if (!sec.users.length) return OPEN_USER; // geen pincodes = iedereen is beheerder
  const t = parseCookies(req).dt || "";
  const u = sec.users.find((x) => t.startsWith(x.id + ".") && t === userToken(x));
  return u || null;
}
const userSeesCam = (u, sn) => !!u && (u.cams === "all" || (Array.isArray(u.cams) && u.cams.includes(sn)));
const isAdmin = (req) => currentUser(req)?.role === "admin";
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, cams: u.cams, topic: u.topic || null, notify: u.notify !== false });
const camToken = (sn) => (sec.camPins[sn] ? hmac("cam:" + sn + ":" + sec.camPins[sn].hash) : "");

// ================= Status =================
const state = {
  eufyConnected: false,
  cloudConnected: false,
  auth: null,
  lastError: null,
  devices: {},   // serial -> { serial, props, meta, picture, pictureAt, voices }
  stations: {},  // serial -> { serial, props, meta }
};
const DOORBELL_TYPES = new Set([5, 7, 16, 91, 93, 94, 95, 96]);
const camCfg = (sn) => settings.cams?.[sn] || {};
function isDoorbell(sn) {
  const k = camCfg(sn).kind;
  if (k === "doorbell") return true;
  if (k === "camera") return false;
  const p = state.devices[sn]?.props || {};
  return DOORBELL_TYPES.has(Number(p.type)) || /^T82/.test(p.model || "");
}
// Timelapse-interval in seconden voor deze camera (0 = uit)
function tlSeconds(sn) {
  const c = camCfg(sn).tlSeconds;
  if (c === -1) return 0;
  if (c > 0) return c;
  return (settings.snapshotMinutes || 0) * 60;
}
// Continu: de stream blijft open en er wordt elke N seconden een beeld uit gehaald (voor camera's op netstroom)
const isContinuous = (sn) => { const c = camCfg(sn).tlSeconds; return c > 0 && c <= 120; };
const displayName = (sn) => settings.names?.[sn] || state.devices[sn]?.props?.name || sn;
const deviceAllowed = (sn) => !ENV.deviceSerial || ENV.deviceSerial === sn;

let events = readJson(path.join(ENV.dataDir, "events.json"), []);
const saveEvents = () => writeJson(path.join(ENV.dataDir, "events.json"), events);
let recordings = readJson(path.join(ENV.dataDir, "recordings.json"), []);
const saveRecordings = () => writeJson(path.join(ENV.dataDir, "recordings.json"), recordings);
for (const r of recordings) if (r.status === "downloading") r.status = r.file ? "done" : "remote";
recordings = recordings.filter((r) => r.status !== "recording"); // half afgemaakte opnames van voor een herstart
// omzetten onderbroken door een herstart? origineel terugzetten
for (const r of recordings) {
  if (!r.file) continue;
  const f = path.join(REC_DIR, r.file);
  try { if (fs.existsSync(f + ".orig")) { if (fs.existsSync(f)) fs.rmSync(f + ".orig"); else fs.renameSync(f + ".orig", f); } fs.rmSync(f + ".tmp.mp4", { force: true }); } catch {}
}

// ================= Server-Sent Events =================
const sseClients = new Map(); // res -> req
const lockedView = (d) => ({ serial: d.serial, name: d.name, model: d.model, isDoorbell: d.isDoorbell, locked: true, hasPin: true });
function filterFor(req, msg) {
  const u = currentUser(req);
  if (msg.type === "state") msg = { ...msg, me: u ? { id: u.id, name: u.name, role: u.role } : null, devices: msg.devices.filter((d) => !camHidden(req, d.serial)) };
  if (msg.type === "device" && camHidden(req, msg.device.serial)) return null;
  if (!Object.keys(sec.camPins).length && (!u || u.cams === "all")) return msg;
  const L = (sn) => sn && camLocked(req, sn);
  switch (msg.type) {
    case "state": return { ...msg, devices: msg.devices.map((d) => (L(d.serial) ? lockedView(d) : d)) };
    case "device": return L(msg.device.serial) ? { type: "device", device: lockedView(msg.device) } : msg;
    case "event": case "event-update": return L(msg.event.serial) ? null : msg;
    case "recording": return L(msg.recording.serial) ? null : msg;
    case "live-ended": return L(msg.serial) ? null : msg;
    case "download-progress": return L(serialOfId(msg.id)) ? null : msg;
    default: return msg;
  }
}
function broadcast(msg) {
  let plain = null;
  for (const [res, req] of sseClients) {
    const out = filterFor(req, msg);
    if (!out) continue;
    if (out === msg) { plain = plain || "data: " + JSON.stringify(msg) + "\n\n"; res.write(plain); }
    else res.write("data: " + JSON.stringify(out) + "\n\n");
  }
}
function publicState() {
  return {
    type: "state",
    eufyConnected: state.eufyConnected,
    cloudConnected: state.cloudConnected,
    auth: state.auth,
    lastError: state.lastError,
    devices: Object.values(state.devices).map(publicDevice),
    notificationsEnabled: !!ENV.ntfyTopic,
    settings,
    download: downloader.current ? { id: downloader.current.rec.id, progress: downloader.current.bytes } : null,
    queue: downloader.queue.length,
  };
}

// Instellingen die we niet tonen (alleen-lezen, intern of riskant)
const HIDE = new Set(["picture", "name", "rtspStream", "rtspStreamUrl", "lightSettingsBrightnessManual", "enabled"]);
function settingList(props, meta) {
  const out = [];
  for (const [name, m] of Object.entries(meta || {})) {
    if (!m || m.writeable !== true || HIDE.has(name) || name.startsWith("hidden") || !(name in props)) continue;
    if (!["boolean", "number", "string"].includes(m.type)) continue;
    out.push({ name, label: m.label || name, type: m.type, min: m.min, max: m.max, states: m.states, unit: m.unit, value: props[name] });
  }
  return out;
}
function publicDevice(d) {
  const p = d.props || {};
  const st = state.stations[p.stationSerialNumber] || null;
  return {
    serial: d.serial,
    name: displayName(d.serial),
    eufyName: p.name || null,
    isDoorbell: isDoorbell(d.serial),
    cfg: camCfg(d.serial),
    continuous: continuous.has(d.serial),
    model: p.model,
    type: p.type,
    battery: p.battery,
    batteryLow: p.batteryLow,
    batteryTemperature: p.batteryTemperature,
    charging: p.chargingStatus,
    wifiRssi: p.wifiRssi,
    wifiSignalLevel: p.wifiSignalLevel,
    enabled: p.enabled,
    state: p.state,
    snooze: p.snooze,
    softwareVersion: p.softwareVersion,
    hardwareVersion: p.hardwareVersion,
    stationSerial: p.stationSerialNumber,
    station: st ? { serial: st.serial, name: st.props.name, model: st.props.model, guardMode: st.props.guardMode, currentMode: st.props.currentMode, guardStates: st.meta?.guardMode?.states || null, settings: settingList(st.props, st.meta).filter((s) => s.name !== "guardMode") } : null,
    hasPin: !!sec.camPins[d.serial],
    hasPicture: !!d.picture,
    pictureAt: d.pictureAt || null,
    live: live.get(d.serial)?.status || "idle",
    talking: talk.get(d.serial)?.active || false,
    voices: d.voices || [],
    settings: settingList(p, d.meta),
  };
}

// ================= WebSocket naar eufy-security-ws =================
let ws = null;
let msgId = 0;
const pending = new Map();
let reconnectDelay = 2000;

function send(command, extra = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("Niet verbonden met eufy-security-ws"));
    const messageId = "m" + ++msgId;
    const t = setTimeout(() => { pending.delete(messageId); reject(new Error("Time-out: " + command)); }, timeoutMs);
    pending.set(messageId, { resolve, reject, t, command });
    ws.send(JSON.stringify({ messageId, command, ...extra }));
  });
}

function connectEufy() {
  log("Verbinden met", ENV.eufyWs);
  try { ws = new WebSocket(ENV.eufyWs); } catch (e) { log("WebSocket-fout:", e.message); return scheduleReconnect(); }
  // Blijft de verbinding hangen (bv. omdat eufy-security-ws nog aan het opstarten is)? Dan opnieuw proberen.
  const me = ws;
  const connectTimer = setTimeout(() => {
    if (me.readyState !== 1) { log("Geen antwoord van eufy-security-ws, opnieuw proberen"); me._dead = true; try { me.close(); } catch {} scheduleReconnect(); }
  }, 15000);
  ws.addEventListener("open", async () => {
    clearTimeout(connectTimer);
    reconnectDelay = 2000;
    state.eufyConnected = true;
    log("Verbonden met eufy-security-ws");
    try {
      await send("set_api_schema", { schemaVersion: SCHEMA });
      const res = await send("start_listening", {}, 60000);
      await loadState(res.state || {});
    } catch (e) { state.lastError = e.message; log("Opstartfout:", e.message); }
    broadcast(publicState());
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    try { handleMessage(msg); } catch (e) { log("Fout bij verwerken bericht:", e.message); }
  });
  ws.addEventListener("close", () => {
    clearTimeout(connectTimer);
    if (me._dead || ws !== me) return; // oude verbinding, al vervangen
    if (state.eufyConnected) log("Verbinding met eufy-security-ws verbroken");
    state.eufyConnected = false;
    for (const p of pending.values()) { clearTimeout(p.t); p.reject(new Error("Verbinding verbroken")); }
    pending.clear();
    for (const l of live.values()) l.shutdown("verbinding verbroken");
    for (const t of talk.values()) t.stop(true);
    downloader.abort("verbinding verbroken");
    broadcast(publicState());
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {});
}
function scheduleReconnect() { setTimeout(connectEufy, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30000); }

// Apparatenlijst opnieuw ophalen (nieuwe of verwijderde camera's)
let reloadTimer = null;
function scheduleReload(ms = 3000) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      const before = Object.keys(state.devices).length;
      const r = await send("start_listening", {}, 60000);
      await loadState(r.state || {});
      const after = Object.keys(state.devices).length;
      if (after !== before) log(`Apparaten: ${before} → ${after}`);
      broadcast(publicState());
    } catch (e) { log("Apparatenlijst vernieuwen mislukt:", e.message); }
  }, ms);
}
// elk half uur kijken of er camera's bij zijn gekomen
setInterval(() => { if (state.eufyConnected) send("driver.poll_refresh", {}, 60000).then(() => scheduleReload(5000)).catch(() => {}); }, 30 * 60000);

async function loadState(st) {
  state.cloudConnected = !!(st.driver && st.driver.connected);
  const devs = (st.devices || []).map((d) => (typeof d === "string" ? d : d.serialNumber)).filter(Boolean);
  const stations = new Set((st.stations || []).map((s) => (typeof s === "string" ? s : s.serialNumber)).filter(Boolean));
  if (devs.length) for (const sn of Object.keys(state.devices)) if (!devs.includes(sn)) { log("Apparaat verdwenen:", displayName(sn)); delete state.devices[sn]; }
  for (const serial of devs) {
    if (!deviceAllowed(serial)) continue;
    const d = state.devices[serial] || (state.devices[serial] = { serial, props: {}, meta: {}, voices: [] });
    if (!d.picture) { try { const f = path.join(ENV.dataDir, `latest-${serial}.jpg`); d.picture = fs.readFileSync(f); d.pictureAt = fs.statSync(f).mtimeMs; } catch {} }
    await refreshDevice(serial);
    try { d.meta = unwrapProps(await send("device.get_properties_metadata", { serialNumber: serial })); } catch {}
    if (d.props.stationSerialNumber) stations.add(d.props.stationSerialNumber);
    loadVoices(serial).catch(() => {});
    log("Apparaat:", d.props.name || serial, d.props.model || "");
  }
  for (const sn of stations) {
    if (!Object.values(state.devices).some((d) => d.props.stationSerialNumber === sn)) continue;
    const s = state.stations[sn] || (state.stations[sn] = { serial: sn, props: {}, meta: {} });
    try { s.props = unwrapProps(await send("station.get_properties", { serialNumber: sn })); } catch {}
    try { s.meta = unwrapProps(await send("station.get_properties_metadata", { serialNumber: sn })); } catch {}
  }
  setTimeout(manageContinuous, 8000);
  if (!devs.length) log("Nog geen apparaten gevonden (inloggen nog bezig?)");
  else {
    setTimeout(() => syncRecordings().catch((e) => log("Opnames ophalen mislukt:", e.message)), 5000);
    // nog een keer als de verbinding met de HomeBase er zeker is
    setTimeout(() => syncRecordings().catch(() => {}), 90000);
  }
}
const unwrapProps = (r) => (r && r.properties) || r || {};
async function refreshDevice(serial) {
  const d = state.devices[serial];
  if (!d) return;
  try {
    d.props = unwrapProps(await send("device.get_properties", { serialNumber: serial }));
    if (d.props.picture) storePicture(d, d.props.picture, false);
    delete d.props.picture;
  } catch (e) { log("Eigenschappen ophalen mislukt", serial, e.message); }
}
async function loadVoices(serial) {
  const r = await send("device.get_voices", { serialNumber: serial });
  const v = r.voices || {};
  state.devices[serial].voices = Object.values(v).map((x) => ({ id: x.voice_id, name: x.desc || "Bericht " + x.voice_id }));
  broadcastDevice(serial);
}

function handleMessage(msg) {
  if (msg.type === "result") {
    const p = pending.get(msg.messageId);
    if (!p) return;
    pending.delete(msg.messageId);
    clearTimeout(p.t);
    if (msg.success) p.resolve(msg.result || {});
    else p.reject(new Error(`${p.command}: ${msg.errorCode || "mislukt"}${msg.message ? " — " + msg.message : ""}`));
    return;
  }
  if (msg.type === "version") { log(`eufy-security-ws ${msg.serverVersion}, schema ${msg.minSchemaVersion}-${msg.maxSchemaVersion}`); return; }
  if (msg.type !== "event" || !msg.event) return;
  const e = msg.event;
  if (e.source === "driver") return handleDriverEvent(e);
  if (["device added", "device removed", "station added", "station removed"].includes(e.event)) {
    log(`Eufy meldt: ${e.event} (${e.serialNumber || e.device?.serialNumber || "?"})`);
    return scheduleReload();
  }
  if (e.source === "station") return handleStationEvent(e);
  if (e.source !== "device" || !e.serialNumber || !deviceAllowed(e.serialNumber)) return;
  const d = state.devices[e.serialNumber];

  switch (e.event) {
    case "livestream video data": return live.get(e.serialNumber)?.video(e.buffer, e.metadata);
    case "livestream audio data": return live.get(e.serialNumber)?.audio(e.buffer, e.metadata);
    case "livestream started": return broadcastDevice(e.serialNumber);
    case "livestream stopped":
      live.get(e.serialNumber)?.shutdown("deurbel stopte de stream");
      return broadcastDevice(e.serialNumber);
    case "download started": return;
    case "download video data": return downloader.data("video", e);
    case "download audio data": return downloader.data("audio", e);
    case "download finished": return downloader.finished(e.serialNumber);
    case "talkback started": return broadcastDevice(e.serialNumber);
    case "talkback stopped": talk.get(e.serialNumber)?.stop(true); return broadcastDevice(e.serialNumber);
    case "property changed":
      if (!d) return;
      if (e.name === "picture") storePicture(d, e.value, true);
      else d.props[e.name] = e.value;
      return broadcastDevice(e.serialNumber);
    case "rings": if (e.state) addEvent(e.serialNumber, "ring"); return;
    case "person detected": if (e.state) addEvent(e.serialNumber, "person", e.person); return;
    case "stranger person detected": if (e.state) addEvent(e.serialNumber, "person", "Onbekend persoon"); return;
    case "motion detected": if (e.state) addEvent(e.serialNumber, "motion"); return;
    case "radar motion detected": if (e.state) addEvent(e.serialNumber, "motion"); return;
    case "package delivered": if (e.state) addEvent(e.serialNumber, "package"); return;
    case "package taken": if (e.state) addEvent(e.serialNumber, "package", "Pakket opgehaald"); return;
    case "someone loitering": if (e.state) addEvent(e.serialNumber, "person", "Iemand blijft rondhangen"); return;
  }
}
const dbWaiters = new Map(); // stationSN -> resolve
function handleStationEvent(e) {
  if (e.event === "database query by date") {
    const fn = dbWaiters.get(e.serialNumber);
    if (fn) { dbWaiters.delete(e.serialNumber); fn(e); }
    return;
  }
  const s = state.stations[e.serialNumber];
  if (!s) return;
  if (e.event === "property changed") s.props[e.name] = e.value;
  else if (e.event === "guard mode changed") s.props.guardMode = e.guardMode;
  else if (e.event === "current mode changed") s.props.currentMode = e.currentMode;
  else return;
  for (const d of Object.values(state.devices)) if (d.props.stationSerialNumber === s.serial) broadcastDevice(d.serial);
}
function handleDriverEvent(e) {
  switch (e.event) {
    case "verify code": state.auth = { kind: "code" }; log("Eufy vraagt om een verificatiecode, vul die in op het dashboard"); break;
    case "captcha request": state.auth = { kind: "captcha", captchaId: e.captchaId, captcha: e.captcha }; log("Eufy vraagt om een captcha, vul die in op het dashboard"); break;
    case "connected":
      state.cloudConnected = true; state.auth = null; state.lastError = null;
      log("Ingelogd bij Eufy");
      send("start_listening", {}, 60000).then((r) => loadState(r.state || {})).then(() => broadcast(publicState())).catch(() => {});
      break;
    case "disconnected": state.cloudConnected = false; break;
    case "connection error": state.lastError = "Inloggen bij Eufy mislukt"; break;
    default: return;
  }
  broadcast(publicState());
}
function broadcastDevice(serial) {
  const d = state.devices[serial];
  if (d) broadcast({ type: "device", device: publicDevice(d) });
}

// ================= Hulpjes =================
function toBuffer(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data);
  if (Array.isArray(v)) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v, "base64");
  return null;
}
function hasKeyframeHeader(buf, codec) {
  // zoekt naar SPS (H.264) of VPS (H.265) na een startcode
  for (let i = 0; i + 4 < buf.length && i < 4096; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const b = buf[buf[i + 2] === 1 ? i + 3 : i + 4];
      if (codec === "hevc" ? ((b >> 1) & 0x3f) === 32 : (b & 0x1f) === 7) return true;
    }
  }
  return false;
}

// ================= Foto's =================
const pictureWaiters = new Map();
// Foto's van Eufy zelf zijn bij een HomeBase 2 vaak (deels) versleuteld en dus kapot.
// Standaard gebruiken we daarom alleen eigen foto's uit het live beeld.
function storePicture(d, value, fresh) {
  if (!settings.useEufyPicture) return;
  storePictureBuf(d, toBuffer(value && value.data), fresh);
}
function storePictureBuf(d, buf, fresh) {
  if (!buf || buf.length < 100) return;
  d.picture = buf;
  d.pictureAt = Date.now();
  fs.writeFile(path.join(ENV.dataDir, `latest-${d.serial}.jpg`), buf, () => {});
  if (!fresh) return;
  const file = `${d.serial}-${d.pictureAt}.jpg`;
  fs.writeFile(path.join(SNAP_DIR, file), buf, () => {});
  const ev = events.find((x) => x.serial === d.serial && !x.snapshot && d.pictureAt - x.time < 90000);
  if (ev) { ev.snapshot = file; saveEvents(); broadcast({ type: "event-update", event: ev }); }
  const waiters = pictureWaiters.get(d.serial) || [];
  pictureWaiters.delete(d.serial);
  waiters.forEach((fn) => fn(buf));
}
function waitForPicture(serial, ms) {
  return new Promise((resolve) => {
    const list = pictureWaiters.get(serial) || [];
    let done = false;
    list.push((buf) => { if (!done) { done = true; resolve(buf); } });
    pictureWaiters.set(serial, list);
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
  });
}

// ================= Gebeurtenissen + meldingen =================
const LABELS = { ring: "Er wordt aangebeld", person: "Persoon bij de deur", motion: "Beweging bij de deur", package: "Pakket bij de deur" };
const lastNotified = {};
function addEvent(serial, kind, detail) {
  const now = Date.now();
  if (events.find((x) => x.serial === serial && x.kind === kind && now - x.time < 15000)) return;
  // beweging en persoon komen vaak tegelijk binnen: één gebeurtenis van maken
  const rank = { motion: 1, person: 2, package: 2, ring: 3 };
  const near = events.find((x) => x.serial === serial && now - x.time < 15000 && rank[x.kind] && rank[kind]);
  if (near && kind === "motion") return; // er is al iets belangrijkers
  if (near && near.kind === "motion" && rank[kind] > 1) {
    near.kind = kind; if (detail && typeof detail === "string" && detail !== "Unknown") near.detail = detail;
    saveEvents(); broadcast({ type: "event-update", event: near });
    notify(near).catch(() => {});
    startRecording(serial, kind, near).catch(() => {});
    return;
  }
  const d = state.devices[serial];
  const ev = { id: crypto.randomUUID(), serial, device: displayName(serial), kind, time: now };
  if (detail && typeof detail === "string" && detail !== "Unknown") ev.detail = detail;
  events.unshift(ev);
  while (events.length > ENV.maxEvents) {
    const old = events.pop();
    if (old.snapshot) fs.unlink(path.join(SNAP_DIR, old.snapshot), () => {});
  }
  saveEvents();
  log("Gebeurtenis:", LABELS[kind] || kind, ev.device);
  broadcast({ type: "event", event: ev });
  notify(ev).catch((e) => log("Melding mislukt:", e.message));
  startRecording(serial, kind, ev).catch((e) => log("Opnemen mislukt:", e.message));
  if (settings.snapshotOnEvent !== false && kind !== "motion" || settings.recordOn?.motion) grabSnapshot(serial, LABELS[kind] || kind, true);
  // Opname komt meestal binnen een minuut in de lijst van Eufy
  scheduleSync(serial, 45000);
}

// ---- slimme meldingen ----
const inQuietHours = (t = new Date()) => {
  const q = settings.quiet;
  if (!q || !q.enabled || !q.from || !q.to) return false;
  const hm = t.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ENV.tz });
  return q.from <= q.to ? hm >= q.from && hm < q.to : hm >= q.from || hm < q.to; // ook over middernacht
};
function guardModeOf(serial) {
  const st = state.stations[state.devices[serial]?.props?.stationSerialNumber] || state.stations[serial];
  return st?.props?.guardMode;
}
// Mag er een melding komen voor deze gebeurtenis? Geeft een reden terug als het niet mag.
function notifyBlocked(ev) {
  const kind = ev.kind;
  const camN = camCfg(ev.serial).notify || {};
  const glob = { ring: settings.notifyRing, person: settings.notifyPerson, motion: settings.notifyMotion, package: settings.notifyPackage }[kind];
  if (!(camN[kind] ?? glob)) return "uitgezet";
  if (settings.muteUntil && Date.now() < settings.muteUntil) return "gepauzeerd";
  if (inQuietHours(new Date(ev.time)) && !(settings.quiet.allow || ["ring"]).includes(kind)) return "rustige uren";
  if (settings.notifyOnlyAway && kind !== "ring" && guardModeOf(ev.serial) !== undefined && guardModeOf(ev.serial) !== 0) return "niet op Afwezig";
  return null;
}
// Wie krijgt de melding: jijzelf (NTFY_TOPIC) en huisgenoten met een eigen kanaal en toegang tot de camera
function recipients(serial) {
  const out = [];
  if (ENV.ntfyTopic) out.push(ENV.ntfyTopic);
  for (const u of sec.users || []) if (u.topic && u.notify !== false && userSeesCam(u, serial) && !out.includes(u.topic)) out.push(u.topic);
  return out;
}
async function notify(ev) {
  const topics = recipients(ev.serial);
  if (!topics.length) return;
  const why = notifyBlocked(ev);
  if (why) { log(`Geen melding (${why}):`, LABELS[ev.kind] || ev.kind); return; }
  if (ev.kind !== "ring") {
    const key = ev.serial + ":" + ev.kind;
    if (lastNotified[key] && ev.time - lastNotified[key] < settings.motionCooldown * 1000) return;
    lastNotified[key] = ev.time;
  }
  const title = LABELS[ev.kind] || "Deurbel";
  const time = new Date(ev.time).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: ENV.tz });
  const message = `${displayName(ev.serial)} - ${time}${ev.detail ? " - " + ev.detail : ""}`;
  const tags = { ring: "bell", person: "bust_in_silhouette", motion: "eyes", package: "package" }[ev.kind] || "bell";
  const quiet = inQuietHours(new Date(ev.time));
  const priority = ev.kind === "ring" ? (quiet ? "4" : "5") : ev.kind === "person" ? "4" : "3";
  const sendAll = (o) => Promise.all(topics.map((t) => ntfy({ ...o, topic: t }).catch((e) => log("Melding mislukt:", e.message))));
  if (ev.kind === "ring") {
    await sendAll({ title, message, tags, priority });
    if (settings.ntfySnapshot) {
      const pic = await waitForPicture(ev.serial, 20000);
      if (pic) await sendAll({ title: "Wie staat er voor de deur", message, tags: "camera", priority: "3", image: pic });
    }
  } else {
    const pic = settings.ntfySnapshot ? await waitForPicture(ev.serial, 12000) : null;
    await sendAll({ title, message, tags, priority, image: pic });
  }
}
const muteKey = () => hmac("mute").slice(0, 24);
async function ntfy({ title, message, tags, priority, image, topic }) {
  const headers = { Title: title, Tags: tags, Priority: priority };
  if (ENV.ntfyToken) headers.Authorization = "Bearer " + ENV.ntfyToken;
  if (ENV.publicUrl) {
    headers.Click = ENV.publicUrl;
    headers.Actions = `view, Live bekijken, ${ENV.publicUrl}/#live; http, Stil 1 uur, ${ENV.publicUrl}/api/public/mute?h=1&k=${muteKey()}, method=POST, clear=true`;
  }
  let body = message;
  if (image) { headers.Filename = "deurbel.jpg"; headers.Message = message; body = image; }
  const r = await fetch(`${ENV.ntfyUrl}/${encodeURIComponent(topic || ENV.ntfyTopic)}`, { method: image ? "PUT" : "POST", headers, body });
  if (!r.ok) throw new Error("ntfy " + r.status + " " + (await r.text()).slice(0, 200));
}

// ================= Live beeld + geluid (fragmented MP4) =================
// De deurbel stuurt losse H.264/H.265- en AAC-stukjes. Per kijker maakt ffmpeg
// daar een MP4-stroom van die een <video>-element direct kan afspelen.
const live = new Map();
class LiveStream {
  constructor(serial) {
    this.serial = serial;
    this.status = "idle";
    this.viewers = new Set();
    this.gop = [];          // video sinds het laatste keyframe, voor nieuwe kijkers
    this.gopBytes = 0;
    this.codec = null;
    this.audioSeen = false;
    this.timers = {};
  }
  async addViewer(res, req) {
    const v = { res, ff: null };
    this.viewers.add(v);
    clearTimeout(this.timers.idle);
    req.on("close", () => this.removeViewer(v));
    if (this.status === "idle") await this.start();
    if (this.status === "running" && this.codec) this.spawnFor(v, this.audioSeen ? 0 : 1500);
  }
  removeViewer(v) {
    this.viewers.delete(v);
    if (v.pendingSpawn) { clearTimeout(v.pendingSpawn); v.pendingSpawn = null; }
    if (v.recorder) {
      // netjes afsluiten zodat het mp4-bestand compleet is
      if (v.ff) { const ff = v.ff; try { ff.stdin.end(); ff.stdio[3].end(); } catch {} setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} }, 3000); }
      else { try { v.res.end(); } catch {} }
    } else if (v.ff) { try { v.ff.kill("SIGKILL"); } catch {} }
    if (!this.viewers.size) { clearTimeout(this.timers.idle); this.timers.idle = setTimeout(() => this.stop("geen kijkers meer"), 6000); }
  }
  async start() {
    this.status = "starting";
    this.gop = []; this.gopBytes = 0; this.audioSeen = false; this.codec = null;
    broadcastDevice(this.serial);
    log("Live beeld starten", this.serial);
    this.timers.start = setTimeout(() => { if (this.status === "starting") this.shutdown("deurbel reageerde niet (slaapt hij of is de batterij leeg?)"); }, 30000);
    try {
      if (downloader.current && downloader.current.rec.serial === this.serial) downloader.abort("live beeld heeft voorrang");
      await send("device.start_livestream", { serialNumber: this.serial }, 30000);
    } catch (e) { this.shutdown(e.message); return; }
    clearTimeout(this.timers.max);
    const maxCheck = () => {
      if ([...this.viewers].some((v) => v.cont || v.recorder)) { this.timers.max = setTimeout(maxCheck, 60000); return; } // continue timelapse / opname loopt nog
      this.stop("maximale kijktijd bereikt");
    };
    this.timers.max = setTimeout(maxCheck, settings.liveMaxSeconds * 1000);
  }
  video(buffer, meta) {
    if (this.status === "idle") return;
    const chunk = toBuffer(buffer);
    if (!chunk) return;
    if (!this.codec) {
      this.codec = meta && meta.videoCodec === "H265" ? "hevc" : "h264";
      this.fps = meta && meta.videoFPS > 0 ? meta.videoFPS : 15;
      log(`Live: ${meta?.videoWidth || "?"}x${meta?.videoHeight || "?"} ${this.codec} ${this.fps}fps`);
    }
    if (hasKeyframeHeader(chunk, this.codec) || this.gopBytes > 8_000_000) { this.gop = []; this.gopBytes = 0; }
    this.gop.push(chunk); this.gopBytes += chunk.length;
    if (this.status === "starting") {
      if (!this.gop.length || !hasKeyframeHeader(this.gop[0], this.codec)) return; // wacht op een keyframe
      clearTimeout(this.timers.start);
      this.status = "running";
      broadcastDevice(this.serial);
      for (const v of this.viewers) this.spawnFor(v, 1500);
      return;
    }
    for (const v of this.viewers) if (v.ff && v.ff.stdin.writable) v.ff.stdin.write(chunk);
  }
  audio(buffer) {
    if (this.status === "idle") return;
    const chunk = toBuffer(buffer);
    if (!chunk) return;
    if (!this.audioSeen) { this.audioSeen = true; for (const v of this.viewers) if (v.pendingSpawn) { clearTimeout(v.pendingSpawn); v.pendingSpawn = null; this.spawnNow(v); } }
    for (const v of this.viewers) if (v.ff && v.ff.stdio[3] && v.ff.stdio[3].writable) v.ff.stdio[3].write(chunk);
  }
  spawnFor(v, waitAudioMs) {
    if (v.ff || v.pendingSpawn) return;
    if (v.snapshot || v.cont) return this.spawnNow(v);
    if (this.audioSeen || !waitAudioMs) return this.spawnNow(v);
    v.pendingSpawn = setTimeout(() => { v.pendingSpawn = null; this.spawnNow(v); }, waitAudioMs);
  }
  spawnNow(v) {
    if (v.ff || !this.viewers.has(v)) return;
    if (v.cont) {
      // continu: elke N seconden één beeld uit de lopende stream
      const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-use_wallclock_as_timestamps", "1", "-f", this.codec, "-i", "pipe:0",
        "-vf", `fps=1/${v.sec},scale='min(1600,iw)':-2`, "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
      v.ff = ff;
      ff.stdin.on("error", () => {}); ff.stdout.on("error", () => {}); ff.stderr.on("error", () => {});
      ff.stdout.on("data", (d) => v.res.write(d));
      ff.on("close", () => { if (v.ff === ff) { v.ff = null; v.res.end(); } });
      for (const c of this.gop) ff.stdin.write(c);
      return;
    }
    if (v.snapshot) {
      // één scherp beeld, ruim een seconde na het keyframe (dan is de belichting goed)
      const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", this.codec, "-i", "pipe:0",
        "-vf", "select=gte(n\\,20),scale='min(1600,iw)':-2", "-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
        { stdio: ["pipe", "pipe", "pipe"] });
      v.ff = ff;
      ff.stdin.on("error", () => {}); ff.stdout.on("error", () => {}); ff.stderr.on("error", () => {});
      ff.stdout.on("data", (d) => v.res.write(d));
      ff.on("close", () => { if (v.ff === ff) { v.ff = null; v.res.end(); } });
      for (const c of this.gop) ff.stdin.write(c);
      return;
    }
    const withAudio = this.audioSeen;
    const args = ["-hide_banner", "-loglevel", "error", "-fflags", "+genpts+nobuffer", "-flags", "low_delay",
      "-probesize", "64000", "-analyzeduration", "0",
      "-use_wallclock_as_timestamps", "1", "-f", this.codec, "-i", "pipe:0"];
    if (withAudio) args.push("-use_wallclock_as_timestamps", "1", "-f", "aac", "-i", "pipe:3");
    args.push("-map", "0:v:0");
    if (withAudio) args.push("-map", "1:a:0", "-c:a", "aac", "-b:a", "64k", "-ac", "1");
    if (this.codec === "hevc") args.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "30", "-crf", "26", "-vf", "scale='min(1600,iw)':-2");
    else args.push("-c:v", "copy");
    args.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "300000", "pipe:1");
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    v.ff = ff;
    ff.stdin.on("error", () => {});
    ff.stdio[3].on("error", () => {}); ff.stdout.on("error", () => {}); ff.stderr.on("error", () => {});
    ff.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) log("ffmpeg live:", s.slice(0, 300)); });
    ff.stdout.on("data", (d) => { if (v.res.writableLength < 4_000_000) v.res.write(d); });
    ff.on("close", () => { if (v.ff === ff) { v.ff = null; try { v.res.end(); } catch {} } });
    for (const c of this.gop) ff.stdin.write(c); // vanaf het laatste keyframe, zodat het beeld meteen klopt
  }
  async stop(reason) {
    if (this.status === "idle") return;
    log("Live beeld stoppen:", reason);
    try { await send("device.stop_livestream", { serialNumber: this.serial }, 10000); } catch {}
    this.shutdown(reason);
  }
  shutdown(reason) {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    const was = this.status !== "idle";
    this.status = "idle";
    for (const v of this.viewers) {
      if (v.pendingSpawn) clearTimeout(v.pendingSpawn);
      if (v.recorder && v.ff) { const ff = v.ff; try { ff.stdin.end(); ff.stdio[3].end(); } catch {} setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} }, 3000); continue; }
      if (v.ff) { try { v.ff.stdin.end(); v.ff.kill("SIGKILL"); } catch {} }
      try { v.res.end(); } catch {}
    }
    this.viewers.clear();
    this.gop = []; this.gopBytes = 0;
    if (was) { log("Live beeld gestopt:", reason); broadcast({ type: "live-ended", serial: this.serial, reason }); downloader.kick(); }
    broadcastDevice(this.serial);
  }
}
const getLive = (sn) => live.get(sn) || live.set(sn, new LiveStream(sn)).get(sn);
const anyLive = () => [...live.values()].some((l) => l.status !== "idle");



// ================= Eigen foto's =================
const snapInflight = new Map();
function grabSnapshot(serial, reason, forEvent = false) {
  if (snapInflight.has(serial)) return snapInflight.get(serial);
  const d = state.devices[serial];
  if (!d) return Promise.resolve(null);
  const p = new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const l = getLive(serial);
    const v = { snapshot: true, ff: null, res: { writableLength: 0, write: (c) => chunks.push(c), end: () => finish() } };
    const timer = setTimeout(() => finish(), 40000);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (l.viewers.has(v)) l.removeViewer(v);
      const buf = Buffer.concat(chunks);
      if (buf.length > 1000) { storePictureBuf(d, buf, forEvent); saveTimelapse(serial, buf, forEvent ? reason : null); broadcastDevice(serial); log("Foto bijgewerkt", `(${reason})`); resolve(buf); }
      else { log("Foto maken mislukt", `(${reason})`); resolve(null); }
    }
    l.viewers.add(v);
    clearTimeout(l.timers.idle);
    if (l.status === "idle") l.start().catch(() => {});
    else if (l.status === "running" && l.codec) l.spawnNow(v);
  }).finally(() => snapInflight.delete(serial));
  snapInflight.set(serial, p);
  return p;
}
// elke X minuten een nieuwe foto (instelbaar, per camera)
setInterval(() => {
  if (!state.eufyConnected) return;
  for (const d of Object.values(state.devices)) {
    const sec = tlSeconds(d.serial);
    if (!sec || isContinuous(d.serial)) continue;
    if (Date.now() - (d.pictureAt || 0) < sec * 1000 - 20000) continue;
    if (recorders.has(d.serial) || (live.get(d.serial) && live.get(d.serial).status !== "idle")) continue;
    if (d.props.battery != null && d.props.battery < 15 && !d.props.chargingStatus) continue; // batterij sparen
    grabSnapshot(d.serial, sec >= 3600 ? `elke ${sec / 3600} uur` : `elke ${Math.round(sec / 60)} min`);
  }
}, 30000);

// ---- continue timelapse ----
const continuous = new Map(); // serial -> { v, restartTimer }
function startContinuous(serial) {
  if (continuous.has(serial)) return;
  const d = state.devices[serial];
  if (!d) return;
  const sec = tlSeconds(serial);
  let buf = Buffer.alloc(0);
  const c = { sec };
  const v = {
    cont: true, sec, ff: null,
    res: {
      writableLength: 0,
      write: (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          const a = buf.indexOf(Buffer.from([0xff, 0xd8]));
          if (a < 0) { buf = Buffer.alloc(0); return; }
          const b = buf.indexOf(Buffer.from([0xff, 0xd9]), a + 2);
          if (b < 0) { if (a > 0) buf = buf.subarray(a); return; }
          const jpg = Buffer.from(buf.subarray(a, b + 2));
          buf = buf.subarray(b + 2);
          storePictureBuf(d, jpg, false);
          saveTimelapse(serial, jpg, null);
          broadcastDevice(serial);
        }
      },
      end: () => {
        if (continuous.get(serial) !== c) return;
        continuous.delete(serial);
        log("Continue timelapse onderbroken:", displayName(serial), "- over 20 s opnieuw");
        broadcastDevice(serial);
        setTimeout(manageContinuous, 20000);
      },
    },
  };
  c.v = v;
  continuous.set(serial, c);
  log(`Continue timelapse gestart: ${displayName(serial)} (elke ${sec} s)`);
  const l = getLive(serial);
  l.viewers.add(v);
  clearTimeout(l.timers.idle);
  if (l.status === "idle") l.start().catch(() => {});
  else if (l.status === "running" && l.codec) l.spawnNow(v);
  broadcastDevice(serial);
}
function stopContinuous(serial) {
  const c = continuous.get(serial);
  if (!c) return;
  continuous.delete(serial);
  const l = live.get(serial);
  if (l && l.viewers.has(c.v)) l.removeViewer(c.v);
  log("Continue timelapse gestopt:", displayName(serial));
  broadcastDevice(serial);
}
function manageContinuous() {
  if (!state.eufyConnected) return;
  for (const d of Object.values(state.devices)) {
    const want = isContinuous(d.serial) && settings.timelapse !== false;
    const c = continuous.get(d.serial);
    if (want && c && c.sec !== tlSeconds(d.serial)) { stopContinuous(d.serial); startContinuous(d.serial); }
    else if (want && !c) startContinuous(d.serial);
    else if (!want && c) stopContinuous(d.serial);
  }
  for (const sn of continuous.keys()) if (!state.devices[sn]) stopContinuous(sn);
}
setInterval(manageContinuous, 60000);

// ================= Zelf opnemen =================
// Eufy geeft opgeslagen clips van een HomeBase 2 niet (meer) vrij aan andere programma's.
// Daarom neemt de server bij een gebeurtenis zelf op via de livestream.
const recorders = new Map(); // serial -> { v, until, timer, kind, start }
async function startRecording(serial, kind, eventRef) {
  if (!settings.recordOn?.[kind]) return;
  const now = Date.now();
  const cur = recorders.get(serial);
  if (cur) { // loopt al: verlengen
    cur.until = Math.min(cur.start + 180000, now + settings.recordSeconds * 1000);
    if (kind === "ring" || (kind === "person" && cur.kind === "motion")) { cur.kind = kind; if (cur.placeholder) cur.placeholder.kind = kind; }
    clearTimeout(cur.timer); cur.timer = setTimeout(() => stopRecording(serial), cur.until - now);
    return;
  }
  const id = `${serial}-${now}`;
  const tmp = path.join(TMP_DIR, id + ".frag.mp4");
  const out = fs.createWriteStream(tmp);
  const v = { res: out, ff: null, recorder: true };
  const r = { v, id, tmp, kind, start: now, until: now + settings.recordSeconds * 1000, snapshot: eventRef?.snapshot, event: eventRef };
  recorders.set(serial, r);
  // meteen zichtbaar in de lijst als "bezig met opnemen"
  r.placeholder = { id, serial, device: displayName(serial), start: now, kind, status: "recording", source: "server" };
  recordings.unshift(r.placeholder);
  broadcast({ type: "recordings-changed" });
  out.on("close", () => finishRecording(serial, r).catch((e) => log("Opname afronden mislukt:", e.message)));
  r.timer = setTimeout(() => stopRecording(serial), settings.recordSeconds * 1000);
  log("Opname gestart", serial, `(${kind})`);
  const l = getLive(serial);
  l.viewers.add(v);
  clearTimeout(l.timers.idle);
  if (l.status === "idle") await l.start();
  else if (l.status === "running" && l.codec) l.spawnFor(v, l.audioSeen ? 0 : 1500);
}
function stopRecording(serial) {
  const r = recorders.get(serial);
  if (!r) return;
  clearTimeout(r.timer);
  const l = live.get(serial);
  if (l && l.viewers.has(r.v)) l.removeViewer(r.v);
  else { try { r.v.res.end(); } catch {} }
}
// Zet een opname om naar een mp4 die elke telefoon afspeelt (H.264 main, gewone tijdstempels).
// Het ruwe beeld van de deurbel (2K, wisselende tijdstempels) speelt op mobiel vaak niet af.
const ffQueue = [];
let ffBusy = false;
function makeWebMp4(input, out) {
  return new Promise((resolve) => { ffQueue.push({ input, out, resolve }); pumpFf(); });
}
async function pumpFf() {
  if (ffBusy || !ffQueue.length) return;
  ffBusy = true;
  const { input, out, resolve } = ffQueue.shift();
  let ok = await runNice("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-fflags", "+genpts", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1600,iw)':-2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-threads", "2",
    "-profile:v", "main", "-level", "4.1", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", out + ".tmp.mp4"]);
  if (!ok) ok = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-c", "copy", "-movflags", "+faststart", out + ".tmp.mp4"]);
  if (ok) fs.renameSync(out + ".tmp.mp4", out); else fs.rm(out + ".tmp.mp4", () => {});
  ffBusy = false;
  resolve(ok);
  pumpFf();
}
// Oudere opnames (van voor deze versie) één keer omzetten zodat ze ook op mobiel afspelen
setTimeout(async () => {
  for (const rec of recordings.filter((x) => x.file && x.source === "server" && !x.web)) {
    const f = path.join(REC_DIR, rec.file);
    if (!fs.existsSync(f)) continue;
    const tmp = f + ".orig";
    fs.renameSync(f, tmp);
    log("Oudere opname omzetten voor mobiel:", rec.id);
    const ok = await makeWebMp4(tmp, f);
    if (ok) { fs.rm(tmp, () => {}); rec.web = true; rec.size = fs.statSync(f).size; rec.duration = await probeDuration(f); }
    else fs.renameSync(tmp, f);
    saveRecordings();
  }
  broadcast({ type: "recordings-changed" });
}, 20000);

async function finishRecording(serial, r) {
  if (recorders.get(serial) === r) recorders.delete(serial);
  if (r.placeholder) { r.placeholder.status = "processing"; broadcast({ type: "recording", recording: r.placeholder }); }
  let size = 0;
  try { size = fs.statSync(r.tmp).size; } catch {}
  const dropPlaceholder = () => { const i = recordings.indexOf(r.placeholder); if (i >= 0) recordings.splice(i, 1); broadcast({ type: "recordings-changed" }); };
  if (size < 20000) { fs.rm(r.tmp, () => {}); log("Opname leeg, niet bewaard"); dropPlaceholder(); return; }
  const file = r.id + ".mp4";
  const out = path.join(REC_DIR, file);
  const ok = await makeWebMp4(r.tmp, out);
  fs.rm(r.tmp, () => {});
  if (!ok) { dropPlaceholder(); return; }
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", path.join(REC_DIR, r.id + ".jpg")]);
  const ev = r.event && events.find((e) => e.id === r.event.id);
  const rec = {
    id: r.id, serial, device: displayName(serial), start: r.start,
    end: Date.now(), kind: r.kind, status: "done", source: "server", file, web: true,
    size: fs.statSync(out).size, duration: await probeDuration(out), codec: "h264",
    thumb: fs.existsSync(path.join(REC_DIR, r.id + ".jpg")), snapshot: ev?.snapshot || r.snapshot, downloadedAt: Date.now(),
  };
  const pi = recordings.indexOf(r.placeholder);
  if (pi >= 0) recordings[pi] = rec; else recordings.push(rec);
  recordings.sort((a, b) => b.start - a.start);
  saveRecordings();
  log(`Opname opgeslagen: ${rec.duration}s, ${(rec.size / 1e6).toFixed(1)} MB`);
  broadcast({ type: "recordings-changed" });
  await enforceStorage();
}

// ================= Terugpraten =================
// De browser stuurt microfoongeluid (webm/opus) in stukjes; ffmpeg zet het om naar AAC voor de deurbel.
const talk = new Map();
class Talkback {
  constructor(serial) { this.serial = serial; this.active = false; this.ff = null; this.timer = null; }
  async start() {
    if (this.active) return;
    await send("device.start_talkback", { serialNumber: this.serial }, 15000);
    this.active = true;
    this.ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "-f", "adts", "pipe:1"]);
    this.ff.stdin.on("error", () => {});
    this.ff.stderr.on("data", (d) => log("ffmpeg talk:", d.toString().trim().slice(0, 200)));
    this.ff.stdout.on("data", (d) => {
      if (this.active) send("device.talkback_audio_data", { serialNumber: this.serial, buffer: [...d] }, 5000).catch(() => {});
    });
    log("Terugpraten gestart");
    broadcastDevice(this.serial);
    this.touch();
  }
  touch() { clearTimeout(this.timer); this.timer = setTimeout(() => this.stop(), 4000); }
  write(buf) { if (this.active && this.ff) { this.ff.stdin.write(buf); this.touch(); } }
  async stop(remote) {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    if (this.ff) { try { this.ff.stdin.end(); setTimeout(() => this.ff?.kill("SIGKILL"), 1500); } catch {} }
    if (!remote) { try { await send("device.stop_talkback", { serialNumber: this.serial }, 10000); } catch {} }
    this.ff = null;
    log("Terugpraten gestopt");
    broadcastDevice(this.serial);
  }
}
const getTalk = (sn) => talk.get(sn) || talk.set(sn, new Talkback(sn)).get(sn);

// ================= Opnames =================
const syncTimers = {};
function scheduleSync(serial, ms) {
  clearTimeout(syncTimers[serial]);
  syncTimers[serial] = setTimeout(() => syncRecordings(serial).catch((e) => log("Opnames ophalen mislukt:", e.message)), ms);
}
setInterval(() => syncRecordings().catch(() => {}), 20 * 60 * 1000);

const noDbAnswer = new Set();
const msTime = (t) => (t && t < 1e12 ? t * 1000 : t);
async function syncRecordings(onlySerial) {
  if (!state.eufyConnected) return;
  const serials = Object.keys(state.devices).filter((s) => !onlySerial || s === onlySerial);
  let added = 0;
  const upsert = (serial, e, source) => {
    const start = msTime(typeof e.start_time === "string" ? Date.parse(e.start_time) : e.start_time);
    if (!start || !e.storage_path) return false;
    const id = `${serial}-${start}`;
    let rec = recordings.find((x) => x.id === id || (x.serial === serial && Math.abs(x.start - start) < 3000));
    let isNew = false;
    if (!rec) {
      rec = { id, serial, device: e.device_name || state.devices[serial]?.props?.name || serial, start, status: "remote" };
      recordings.push(rec);
      isNew = true;
    }
    const end = typeof e.end_time === "string" ? Date.parse(e.end_time) : msTime(e.end_time);
    if (end) rec.end = end;
    rec.path = e.storage_path;
    rec.cipherId = e.cipher_id;
    rec.source = source;
    rec.person = !!e.has_human || rec.person || false;
    const match = events.find((x) => x.serial === serial && x.time >= start - 20000 && x.time <= (rec.end || start + 60000) + 20000);
    if (match) { rec.kind = rec.kind === "ring" ? "ring" : match.kind; rec.snapshot = rec.snapshot || match.snapshot; }
    return isNew;
  };
  const ymd = (d) => d.toLocaleDateString("sv-SE", { timeZone: ENV.tz }).replace(/-/g, "");
  for (const serial of serials) {
    // a) lijst uit Eufy's cloud
    let cloud = 0;
    try {
      const r = await send("driver.get_video_events", {
        startTimestampMs: Date.now() - 30 * 86400000, endTimestampMs: Date.now() + 60000,
        filter: { deviceSN: serial }, maxResults: 300,
      }, 60000);
      for (const e of r.events || []) { cloud++; if (upsert(serial, e, "cloud")) added++; }
    } catch (e) { log("Opnamelijst uit de cloud mislukt:", e.message); }
    // b) lijst rechtstreeks uit de HomeBase / deurbel (lokale opslag)
    let local = 0;
    const stationSN = state.devices[serial]?.props?.stationSerialNumber || serial;
    if (noDbAnswer.has(stationSN)) { if (cloud) log(`Opnames gezocht: ${cloud} via cloud`); continue; }
    try {
      const result = new Promise((resolve) => {
        dbWaiters.set(stationSN, resolve);
        setTimeout(() => { if (dbWaiters.get(stationSN) === resolve) { dbWaiters.delete(stationSN); resolve(null); } }, 40000);
      });
      await send("station.database_query_by_date", {
        serialNumber: stationSN, serialNumbers: [serial],
        startDate: ymd(new Date(Date.now() - 30 * 86400000)), endDate: ymd(new Date()),
        eventType: 0, detectionType: 0, storageType: 0,
      }, 30000);
      const ev = await result;
      if (ev) for (const e of ev.data || []) { if (e.device_sn && e.device_sn !== serial) continue; local++; if (upsert(serial, e, "station")) added++; }
      else { noDbAnswer.add(stationSN); log("HomeBase geeft zijn opnamelijst niet vrij; de server neemt zelf op bij gebeurtenissen"); }
    } catch (e) { log("Opnamelijst uit de HomeBase mislukt:", e.message); }
    log(`Opnames gezocht voor ${state.devices[serial]?.props?.name || serial}: ${cloud} via cloud, ${local} via HomeBase`);
  }
  recordings.sort((a, b) => b.start - a.start);
  saveRecordings();
  if (added) { log(`${added} nieuwe opname(s) gevonden`); broadcast({ type: "recordings-changed" }); }
  // automatisch downloaden
  if (settings.autoDownload !== "off") {
    const cutoff = Date.now() - 3 * 86400000;
    for (const rec of recordings) {
      if (rec.status !== "remote" || rec.removed || rec.start < cutoff || (rec.tries || 0) >= 3) continue; // removed = bewust gewist of opslag vol
      const important = rec.kind === "ring" || rec.kind === "person" || rec.kind === "package" || rec.person;
      if (settings.autoDownload === "all" || important) downloader.enqueue(rec, false);
    }
  }
}

const downloader = {
  queue: [],
  current: null,
  enqueue(rec, front) {
    if (this.current?.rec === rec || this.queue.includes(rec)) { if (front) { this.queue = [rec, ...this.queue.filter((r) => r !== rec)]; } return; }
    rec.status = "queued";
    front ? this.queue.unshift(rec) : this.queue.push(rec);
    broadcast({ type: "recording", recording: rec });
    this.kick();
  },
  kick() { setTimeout(() => this.next(), 200); },
  async next() {
    if (this.current || !this.queue.length || !state.eufyConnected) return;
    const rec = this.queue[0];
    if (live.get(rec.serial)?.status !== "idle" && live.get(rec.serial)) return; // wacht tot live klaar is
    this.queue.shift();
    const base = path.join(TMP_DIR, rec.id);
    const cur = this.current = { rec, base, video: fs.createWriteStream(base + ".v"), audio: fs.createWriteStream(base + ".a"), bytes: 0, codec: "h264", fps: 15, audioBytes: 0 };
    rec.status = "downloading";
    broadcast({ type: "recording", recording: rec });
    log("Opname downloaden", new Date(rec.start).toLocaleString("nl-NL", { timeZone: ENV.tz }));
    cur.timer = setTimeout(() => this.abort("duurde te lang"), 5 * 60000);
    try {
      await send("device.start_download", { serialNumber: rec.serial, path: rec.path, cipherId: rec.cipherId }, 30000);
    } catch (e) { this.fail(e.message); }
  },
  data(kind, e) {
    const cur = this.current;
    if (!cur || cur.rec.serial !== e.serialNumber) return;
    const buf = toBuffer(e.buffer);
    if (!buf) return;
    if (kind === "video") {
      if (e.metadata) { cur.codec = e.metadata.videoCodec === "H265" ? "hevc" : "h264"; if (e.metadata.videoFPS > 0) cur.fps = e.metadata.videoFPS; }
      cur.video.write(buf);
    } else { cur.audio.write(buf); cur.audioBytes += buf.length; }
    cur.bytes += buf.length;
    if (!cur.lastBroadcast || Date.now() - cur.lastBroadcast > 1000) { cur.lastBroadcast = Date.now(); broadcast({ type: "download-progress", id: cur.rec.id, bytes: cur.bytes }); }
  },
  async finished(serial) {
    const cur = this.current;
    if (!cur || cur.rec.serial !== serial) return;
    clearTimeout(cur.timer);
    await Promise.all([new Promise((r) => cur.video.end(r)), new Promise((r) => cur.audio.end(r))]);
    const rec = cur.rec;
    if (cur.bytes < 1000) return this.fail("leeg bestand (staat de opname nog op de deurbel?)");
    const file = rec.id + ".mp4";
    const out = path.join(REC_DIR, file);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-r", String(cur.fps), "-f", cur.codec, "-i", cur.base + ".v"];
    if (cur.audioBytes > 0) args.push("-f", "aac", "-i", cur.base + ".a", "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "64k");
    if (cur.codec === "hevc") args.push("-c:v", "copy", "-tag:v", "hvc1"); else args.push("-c:v", "copy");
    args.push("-movflags", "+faststart", out);
    const ok = await run("ffmpeg", args);
    if (!ok) return this.fail("omzetten naar mp4 mislukt");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", out, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", path.join(REC_DIR, rec.id + ".jpg")]);
    const dur = await probeDuration(out);
    fs.rm(cur.base + ".v", () => {}); fs.rm(cur.base + ".a", () => {});
    rec.file = file;
    rec.size = fs.statSync(out).size;
    rec.duration = dur;
    rec.codec = cur.codec;
    rec.thumb = fs.existsSync(path.join(REC_DIR, rec.id + ".jpg"));
    rec.status = "done";
    rec.downloadedAt = Date.now();
    this.current = null;
    saveRecordings();
    log(`Opname opgeslagen (${(rec.size / 1e6).toFixed(1)} MB)`);
    broadcast({ type: "recording", recording: rec });
    await enforceStorage();
    this.kick();
  },
  fail(reason) {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    cur.video.destroy(); cur.audio.destroy();
    fs.rm(cur.base + ".v", () => {}); fs.rm(cur.base + ".a", () => {});
    cur.rec.status = "remote";
    cur.rec.tries = (cur.rec.tries || 0) + 1;
    cur.rec.error = reason;
    log("Download mislukt:", reason);
    this.current = null;
    saveRecordings();
    broadcast({ type: "recording", recording: cur.rec });
    setTimeout(() => this.next(), 5000);
  },
  abort(reason) {
    const cur = this.current;
    if (!cur) return;
    send("device.cancel_download", { serialNumber: cur.rec.serial }, 10000).catch(() => {});
    cur.rec.tries = (cur.rec.tries || 0) - 1; // telt niet als mislukte poging
    this.fail(reason);
  },
};
// Zware klussen (omzetten) met lage prioriteit, zodat de rest van de server (en je Minecraft-server) er geen last van heeft
function runNice(cmd, args) { return run("nice", ["-n", "15", cmd, ...args]); }
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { if (code !== 0) log(cmd, "fout:", err.trim().slice(0, 300)); resolve(code === 0); });
    p.on("error", () => resolve(false));
  });
}
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(Math.round(parseFloat(out) || 0)));
    p.on("error", () => resolve(0));
  });
}


// ================= Timelapse =================
// Elke eigen foto wordt per dag bewaard, zodat je terug kunt kijken in de tijd.
const dayStr = (t) => new Date(t).toLocaleDateString("sv-SE", { timeZone: ENV.tz }); // 2026-11-07
const timeStr = (t) => new Date(t).toLocaleTimeString("nl-NL", { timeZone: ENV.tz, hour12: false }).replace(/:/g, "-"); // 11-05-00
function saveTimelapse(serial, buf, eventLabel) {
  if (!settings.timelapse) return;
  const now = Date.now();
  const dir = path.join(TL_DIR, serial, dayStr(now));
  fs.mkdirSync(dir, { recursive: true });
  const name = timeStr(now) + (eventLabel ? "_e" : "") + ".jpg";
  fs.writeFile(path.join(dir, name), buf, () => {});
  fs.rm(path.join(dir, "timelapse.mp4"), { force: true }, () => {}); // video van vandaag is nu verouderd
}
function tlDays(serial) {
  const dir = path.join(TL_DIR, serial);
  let days = [];
  try { days = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch {}
  return days.map((day) => {
    const files = fs.readdirSync(path.join(dir, day)).filter((f) => f.endsWith(".jpg")).sort();
    return { day, count: files.length, first: files[0]?.slice(0, 5).replace("-", ":"), last: files[files.length - 1]?.slice(0, 5).replace("-", ":") };
  }).filter((d) => d.count);
}
function tlFrames(serial, day) {
  const dir = path.join(TL_DIR, serial, day);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort().map((f) => ({ f, t: f.slice(0, 8).replace(/-/g, ":"), event: f.includes("_e") }));
  } catch { return []; }
}
async function tlVideo(serial, day, fps) {
  const dir = path.join(TL_DIR, serial, day);
  const out = path.join(dir, "timelapse.mp4");
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > (fs.statSync(dir).mtimeMs - 1000) && !fps) return out;
  const frames = tlFrames(serial, day);
  if (frames.length < 2) throw new Error("Te weinig foto's voor een video");
  const list = path.join(TMP_DIR, `tl-${serial}-${day}.txt`);
  fs.writeFileSync(list, frames.map((x) => `file '${path.join(dir, x.f)}'\nduration ${1 / (fps || 8)}`).join("\n") + `\nfile '${path.join(dir, frames[frames.length - 1].f)}'\n`);
  const ok = await runNice("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "scale='min(1600,iw)':-2:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-r", "25", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-movflags", "+faststart", out]);
  fs.rm(list, () => {});
  if (!ok) throw new Error("Video maken mislukt");
  return out;
}
function tlPruneDays() {
  if (!settings.timelapseDays) return;
  const cutoff = dayStr(Date.now() - settings.timelapseDays * 86400000);
  for (const serial of safeReaddir(TL_DIR)) for (const day of safeReaddir(path.join(TL_DIR, serial))) {
    if (day < cutoff) { fs.rmSync(path.join(TL_DIR, serial, day), { recursive: true, force: true }); log("Timelapse verwijderd (te oud):", day); }
  }
}
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }
async function dirSizeDeep(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSizeDeep(p); else { try { total += (await fsp.stat(p)).size; } catch {} }
  }
  return total;
}

// ================= Opslaglimiet =================
async function dirSize(dir) {
  let total = 0;
  for (const f of await fsp.readdir(dir)) { try { total += (await fsp.stat(path.join(dir, f))).size; } catch {} }
  return total;
}
let storageCache = null, storageCacheAt = 0;
async function storageInfo(fresh) {
  if (!fresh && storageCache) {
    if (Date.now() - storageCacheAt > 60000 && !storageInfo.busy) { // op de achtergrond bijwerken
      storageInfo.busy = true;
      storageInfoReal().then((x) => { storageCache = x; storageCacheAt = Date.now(); }).finally(() => (storageInfo.busy = false));
    }
    return { ...storageCache, limit: settings.storageGb * 1e9, count: recordings.filter((r) => r.file).length };
  }
  storageCache = await storageInfoReal(); storageCacheAt = Date.now();
  return storageCache;
}
async function storageInfoReal() {
  const rec = await dirSize(REC_DIR);
  const snap = await dirSize(SNAP_DIR);
  const tl = await dirSizeDeep(TL_DIR);
  let free = null, total = null;
  try { const s = await fsp.statfs(ENV.dataDir); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {}
  return { used: rec + snap + tl, recordings: rec, snapshots: snap, timelapse: tl, limit: settings.storageGb * 1e9, diskFree: free, diskTotal: total, count: recordings.filter((r) => r.file).length };
}
function deleteLocal(rec) {
  if (rec.file) fs.rm(path.join(REC_DIR, rec.file), () => {});
  fs.rm(path.join(REC_DIR, rec.id + ".jpg"), () => {});
  rec.file = null; rec.size = 0; rec.thumb = false; rec.status = "remote"; rec.removed = true;
}
async function enforceStorage() {
  const limit = settings.storageGb * 1e9;
  let changed = false;
  if (settings.keepDays > 0) {
    const cutoff = Date.now() - settings.keepDays * 86400000;
    for (const r of recordings) if (r.file && r.start < cutoff && !r.keep) { deleteLocal(r); changed = true; }
  }
  let info = await storageInfo(true);
  // ook: altijd minstens 1 GB vrij laten op de schijf
  const needFree = () => info.diskFree != null && info.diskFree < 1e9;
  tlPruneDays();
  const byAge = recordings.filter((r) => r.file && !r.keep).sort((a, b) => a.start - b.start);
  const tlDaysAll = () => safeReaddir(TL_DIR).flatMap((sn) => safeReaddir(path.join(TL_DIR, sn)).map((day) => ({ sn, day }))).sort((a, b) => a.day.localeCompare(b.day));
  while (info.used > limit || needFree()) {
    const oldestRec = byAge[0];
    const days = tlDaysAll();
    const oldestDay = days.length > 1 ? days[0] : null; // vandaag nooit weggooien
    const recDay = oldestRec ? dayStr(oldestRec.start) : null;
    if (oldestDay && (!recDay || oldestDay.day <= recDay)) {
      const p = path.join(TL_DIR, oldestDay.sn, oldestDay.day);
      const sz = await dirSizeDeep(p);
      fs.rmSync(p, { recursive: true, force: true });
      info.used -= sz; if (info.diskFree != null) info.diskFree += sz;
      log("Opslag vol: oudste timelapse-dag verwijderd", oldestDay.day);
      continue;
    }
    if (!oldestRec) break;
    byAge.shift();
    const r = oldestRec;
    info.used -= r.size || 0; if (info.diskFree != null) info.diskFree += r.size || 0;
    deleteLocal(r); changed = true;
    log("Opslag vol: oudste opname verwijderd", new Date(r.start).toLocaleString("nl-NL", { timeZone: ENV.tz }));
  }
  if (info.used > limit) {
    // daarna oude foto's
    const files = (await fsp.readdir(SNAP_DIR)).sort();
    while (info.used > limit && files.length) {
      const f = files.shift();
      try { const s = await fsp.stat(path.join(SNAP_DIR, f)); await fsp.rm(path.join(SNAP_DIR, f)); info.used -= s.size; } catch {}
      for (const e of events) if (e.snapshot === f) e.snapshot = null;
      changed = true;
    }
    saveEvents();
  }
  if (changed) { saveRecordings(); broadcast({ type: "recordings-changed" }); }
}
setInterval(() => enforceStorage().catch(() => {}), 60 * 60 * 1000);

// ================= HTTP =================
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json" };
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => { const i = c.indexOf("="); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
const isAuthed = (req) => !!currentUser(req);
const camHidden = (req, sn) => !userSeesCam(currentUser(req), sn);
const camLocked = (req, sn) => camHidden(req, sn) || (!!sec.camPins[sn] && parseCookies(req)["c_" + sn] !== camToken(sn));
const stationLocked = (req, stSn) => Object.values(state.devices).some((d) => (d.props.stationSerialNumber === stSn || d.serial === stSn) && camLocked(req, d.serial));
const serialOfId = (id) => String(id).split("-")[0];
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }
function readRaw(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > max) { req.destroy(); reject(new Error("te groot")); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
async function readBody(req) { try { return JSON.parse((await readRaw(req, 1e5)).toString() || "{}"); } catch { return {}; } }
function sendFile(req, res, file, type, cache = "max-age=86400") {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      if (!range[1]) end = st.size - 1;
      if (start >= st.size || start < 0) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": cache });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": cache });
    fs.createReadStream(file).pipe(res);
  });
}
const loginAttempts = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress;
      const a = loginAttempts.get(ip) || { n: 0, t: 0 };
      if (a.n >= 5 && Date.now() - a.t < 60000) return json(res, 429, { error: "Te veel pogingen, wacht een minuut" });
      const body = await readBody(req);
      const u = sec.users.length ? sec.users.find((x) => checkPin(body.pin, x.pin)) : OPEN_USER;
      if (u) {
        loginAttempts.delete(ip);
        if (u !== OPEN_USER) { res.setHeader("Set-Cookie", `dt=${userToken(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`); log("Ingelogd:", u.name); }
        return json(res, 200, { ok: true, name: u.name });
      }
      loginAttempts.set(ip, { n: a.n + 1, t: Date.now() });
      return json(res, 401, { error: "Verkeerde pincode" });
    }
    // "Stil 1 uur"-knop in de melding (zonder inloggen, beveiligd met een geheime sleutel)
    if (p === "/api/public/mute") {
      if (url.searchParams.get("k") !== muteKey()) return json(res, 403, { error: "nee" });
      const h = Math.min(24, Math.max(0, Number(url.searchParams.get("h") || 1)));
      settings.muteUntil = Date.now() + h * 3600000; writeJson(SETTINGS_FILE, settings); broadcast(publicState());
      log(`Meldingen gepauzeerd voor ${h} uur (via melding)`);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith("/api/")) {
      if (!isAuthed(req)) return json(res, 401, { error: "login", needPin: true });
      return await api(req, res, url);
    }
    let file = p === "/" ? "/index.html" : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    sendFile(req, res, full, MIME[path.extname(full)] || "application/octet-stream", file === "/index.html" || file === "/sw.js" ? "no-cache" : "max-age=3600");
  } catch (e) {
    log("HTTP-fout:", e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

async function api(req, res, url) {
  const p = url.pathname;
  const post = req.method === "POST";
  let m;

  // --- pincodes ---
  const me = currentUser(req);
  if (p === "/api/security") {
    return json(res, 200, {
      me: publicUser(me), hasPin: !!sec.users.length, admin: me.role === "admin",
      users: me.role === "admin" ? sec.users.map(publicUser) : [],
      ntfyUrl: ENV.ntfyUrl,
      cameras: Object.values(state.devices).filter((d) => userSeesCam(me, d.serial)).map((d) => ({ serial: d.serial, name: displayName(d.serial), hasPin: !!sec.camPins[d.serial], unlocked: !camLocked(req, d.serial) })),
      allCameras: me.role === "admin" ? Object.values(state.devices).map((d) => ({ serial: d.serial, name: displayName(d.serial) })) : [],
    });
  }
  const pinTaken = (pin, exceptId) => sec.users.some((x) => x.id !== exceptId && checkPin(pin, x.pin));
  // eigen pincode wijzigen (of de allereerste instellen)
  if (p === "/api/pin" && post) {
    const b = await readBody(req);
    const np = String(b.pin ?? "").trim();
    if (np && !/^\d{4,12}$/.test(np)) return json(res, 400, { error: "Gebruik 4 tot 12 cijfers" });
    if (me === OPEN_USER) {
      if (!np) return json(res, 400, { error: "Vul een pincode in" });
      const u = { id: "owner", name: String(b.name || "Eigenaar").slice(0, 30), pin: hashPin(np), role: "admin", cams: "all", notify: true };
      sec.users.push(u); saveSec();
      res.setHeader("Set-Cookie", `dt=${userToken(u)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      log("Pincode ingesteld, beheerder aangemaakt");
      return json(res, 200, { ok: true });
    }
    if (!checkPin(b.current, me.pin)) return json(res, 403, { error: "Huidige pincode klopt niet" });
    if (!np) {
      if (sec.users.length > 1) return json(res, 400, { error: "Er zijn huisgenoten; verwijder die eerst voordat je de pincode uitzet" });
      sec.users = []; saveSec(); log("Pincode van de app verwijderd");
      return json(res, 200, { ok: true });
    }
    if (pinTaken(np, me.id)) return json(res, 400, { error: "Deze pincode is al van iemand anders" });
    me.pin = hashPin(np); saveSec();
    res.setHeader("Set-Cookie", `dt=${userToken(me)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    log(`Pincode van ${me.name} gewijzigd`);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/logout" && post) {
    res.setHeader("Set-Cookie", "dt=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  // ---- alleen voor beheerders ----
  const adminOnly =
    (p === "/api/settings" && post) || p.startsWith("/api/users") ||
    /^\/api\/device\/\w+\/(property|pin|snooze|refresh)$/.test(p) || p.startsWith("/api/station/") ||
    (p === "/api/devices/refresh") || (p === "/api/update" && post) || p.startsWith("/api/auth/") ||
    (req.method === "DELETE") || /^\/api\/recordings\/[\w-]+\/(keep|download)$/.test(p);
  if (adminOnly && me.role !== "admin") return json(res, 403, { error: "Alleen een beheerder kan dit" });

  // ---- huisgenoten beheren ----
  if (p === "/api/users" && post) {
    if (!sec.users.length) return json(res, 400, { error: "Stel eerst je eigen pincode in" });
    const b = await readBody(req);
    const name = String(b.name || "").trim().slice(0, 30), np = String(b.pin || "").trim();
    if (!name) return json(res, 400, { error: "Vul een naam in" });
    if (!/^\d{4,12}$/.test(np)) return json(res, 400, { error: "Pincode: 4 tot 12 cijfers" });
    if (pinTaken(np)) return json(res, 400, { error: "Deze pincode is al van iemand anders" });
    const u = { id: crypto.randomBytes(5).toString("hex"), name, pin: hashPin(np), role: b.role === "admin" ? "admin" : "member",
      cams: Array.isArray(b.cams) ? b.cams.filter((x) => state.devices[x]) : "all", notify: b.notify !== false,
      topic: ENV.ntfyTopic ? "deurbel-" + crypto.randomBytes(8).toString("hex") : null };
    sec.users.push(u); saveSec();
    log("Huisgenoot toegevoegd:", name);
    return json(res, 200, { ok: true, user: publicUser(u) });
  }
  if ((m = p.match(/^\/api\/users\/(\w+)$/)) && post) {
    const u = sec.users.find((x) => x.id === m[1]); if (!u) return json(res, 404, { error: "Onbekend" });
    const b = await readBody(req);
    if (b.name) u.name = String(b.name).trim().slice(0, 30);
    if (b.role && u.id !== me.id) {
      const newRole = b.role === "admin" ? "admin" : "member";
      if (u.role === "admin" && newRole !== "admin" && sec.users.filter((x) => x.role === "admin").length < 2) return json(res, 400, { error: "Er moet minstens één beheerder blijven" });
      u.role = newRole;
    }
    if (b.cams !== undefined) u.cams = Array.isArray(b.cams) ? b.cams.filter((x) => state.devices[x]) : "all";
    if (typeof b.notify === "boolean") u.notify = b.notify;
    if (b.pin) {
      const np = String(b.pin).trim();
      if (!/^\d{4,12}$/.test(np)) return json(res, 400, { error: "Pincode: 4 tot 12 cijfers" });
      if (pinTaken(np, u.id)) return json(res, 400, { error: "Deze pincode is al van iemand anders" });
      u.pin = hashPin(np);
    }
    if (b.newTopic) u.topic = "deurbel-" + crypto.randomBytes(8).toString("hex");
    saveSec();
    return json(res, 200, { ok: true, user: publicUser(u) });
  }
  if ((m = p.match(/^\/api\/users\/(\w+)$/)) && req.method === "DELETE") {
    const u = sec.users.find((x) => x.id === m[1]); if (!u) return json(res, 404, { error: "Onbekend" });
    if (u.id === me.id) return json(res, 400, { error: "Je kunt jezelf niet verwijderen" });
    if (u.role === "admin" && sec.users.filter((x) => x.role === "admin").length < 2) return json(res, 400, { error: "Er moet minstens één beheerder blijven" });
    sec.users = sec.users.filter((x) => x !== u); saveSec();
    log("Huisgenoot verwijderd:", u.name);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/unlock$/)) && post) {
    const ip = req.socket.remoteAddress, key = ip + ":" + m[1];
    const a = loginAttempts.get(key) || { n: 0, t: 0 };
    if (a.n >= 5 && Date.now() - a.t < 60000) return json(res, 429, { error: "Te veel pogingen, wacht een minuut" });
    const b = await readBody(req);
    if (!sec.camPins[m[1]] || checkPin(b.pin, sec.camPins[m[1]])) {
      loginAttempts.delete(key);
      const hours = Math.min(720, Math.max(0, Number(b.hours ?? 12)));
      res.setHeader("Set-Cookie", `c_${m[1]}=${camToken(m[1])}; Path=/; HttpOnly; SameSite=Lax${hours ? "; Max-Age=" + hours * 3600 : ""}`);
      return json(res, 200, { ok: true });
    }
    loginAttempts.set(key, { n: a.n + 1, t: Date.now() });
    return json(res, 403, { error: "Verkeerde pincode" });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/lock$/)) && post) {
    res.setHeader("Set-Cookie", `c_${m[1]}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/pin$/)) && post) {
    const b = await readBody(req);
    if (!state.devices[m[1]]) return json(res, 404, { error: "Onbekende camera" });
    if (sec.camPins[m[1]] && !checkPin(b.current, sec.camPins[m[1]])) return json(res, 403, { error: "Huidige pincode van deze camera klopt niet" });
    const np = String(b.pin ?? "").trim();
    if (np && !/^\d{4,12}$/.test(np)) return json(res, 400, { error: "Gebruik 4 tot 12 cijfers" });
    if (np) sec.camPins[m[1]] = hashPin(np); else delete sec.camPins[m[1]];
    saveSec();
    log(`Pincode camera ${m[1]} ${np ? "ingesteld" : "verwijderd"}`);
    if (np) res.setHeader("Set-Cookie", `c_${m[1]}=${camToken(m[1])}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    // iedereen opnieuw bijwerken (vergrendelde weergave)
    for (const [r, q] of sseClients) r.write("data: " + JSON.stringify(filterFor(q, publicState())) + "\n\n");
    return json(res, 200, { ok: true });
  }

  // --- vergrendelde camera's afschermen ---
  {
    let sn = null;
    if ((m = p.match(/^\/api\/(?:device|timelapse)\/(\w+)/))) sn = m[1];
    else if ((m = p.match(/^\/api\/recordings\/([\w-]+?)(?:\.mp4|\.jpg|\/|$)/)) && m[1] !== "sync") sn = serialOfId(m[1]);
    else if ((m = p.match(/^\/api\/snapshot\/([\w.-]+)$/))) sn = serialOfId(m[1]);
    else if ((m = p.match(/^\/api\/events\/([\w-]+)$/))) sn = events.find((e) => e.id === m[1])?.serial;
    if (sn && camLocked(req, sn)) return json(res, 423, { error: "Deze camera is vergrendeld", locked: true });
    if ((m = p.match(/^\/api\/station\/(\w+)/)) && stationLocked(req, m[1])) return json(res, 423, { error: "Ontgrendel eerst de camera's op dit station", locked: true });
  }
  const visible = (sn) => !camLocked(req, sn);

  if (p === "/api/state") return json(res, 200, filterFor(req, publicState()));
  if (p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("data: " + JSON.stringify(filterFor(req, publicState())) + "\n\n");
    sseClients.set(res, req);
    const ka = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  // --- gebeurtenissen ---
  if (p === "/api/events") {
    const before = Number(url.searchParams.get("before") || Infinity);
    const kind = url.searchParams.get("kind");
    const serial = url.searchParams.get("serial");
    return json(res, 200, { events: events.filter((e) => e.time < before && (!kind || e.kind === kind) && (!serial || e.serial === serial) && visible(e.serial)).slice(0, 50) });
  }
  if ((m = p.match(/^\/api\/events\/([\w-]+)$/)) && req.method === "DELETE") {
    const i = events.findIndex((e) => e.id === m[1]);
    if (i >= 0) { const [ev] = events.splice(i, 1); if (ev.snapshot) fs.unlink(path.join(SNAP_DIR, ev.snapshot), () => {}); saveEvents(); }
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/snapshot\/([\w.-]+\.jpg)$/))) return sendFile(req, res, path.join(SNAP_DIR, path.basename(m[1])), "image/jpeg");

  // --- opnames ---
  if (p === "/api/recordings") {
    const before = Number(url.searchParams.get("before") || Infinity);
    const filter = url.searchParams.get("filter") || "";
    const serial = url.searchParams.get("serial");
    const list = recordings.filter((r) => r.start < before && (!serial || r.serial === serial) && visible(r.serial) && (!filter || (filter === "saved" ? r.file : filter === "person" ? (r.person || r.kind === "person") : r.kind === filter))).slice(0, 40);
    return json(res, 200, { recordings: list, storage: await storageInfo() });
  }
  if (p === "/api/recordings/sync" && post) { syncRecordings().catch(() => {}); return json(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/recordings\/([\w-]+)\.mp4$/))) {
    const r = recordings.find((x) => x.id === m[1]);
    if (!r || !r.file) return json(res, 404, { error: "Niet opgeslagen" });
    return sendFile(req, res, path.join(REC_DIR, r.file), "video/mp4");
  }
  if ((m = p.match(/^\/api\/recordings\/([\w-]+)\.jpg$/))) {
    const r = recordings.find((x) => x.id === m[1]);
    if (r?.thumb) return sendFile(req, res, path.join(REC_DIR, r.id + ".jpg"), "image/jpeg");
    if (r?.snapshot) return sendFile(req, res, path.join(SNAP_DIR, r.snapshot), "image/jpeg");
    res.writeHead(404); return res.end();
  }
  if ((m = p.match(/^\/api\/recordings\/([\w-]+)\/download$/)) && post) {
    const r = recordings.find((x) => x.id === m[1]);
    if (!r) return json(res, 404, { error: "Onbekend" });
    r.tries = 0; r.removed = false;
    downloader.enqueue(r, true);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/recordings\/([\w-]+)\/keep$/)) && post) {
    const r = recordings.find((x) => x.id === m[1]);
    if (!r) return json(res, 404, { error: "Onbekend" });
    r.keep = !r.keep; saveRecordings(); broadcast({ type: "recording", recording: r });
    return json(res, 200, { ok: true, keep: r.keep });
  }
  if ((m = p.match(/^\/api\/recordings\/([\w-]+)$/)) && req.method === "DELETE") {
    const r = recordings.find((x) => x.id === m[1]);
    if (r) { deleteLocal(r); saveRecordings(); broadcast({ type: "recording", recording: r }); }
    return json(res, 200, { ok: true });
  }

  // --- updates (via de updater-container) ---
  if (p === "/api/update" && !post) {
    const st = readJson(path.join(ENV.dataDir, "update.json"), null);
    return json(res, 200, { installed: !!st, ...(st || {}) });
  }
  if (p === "/api/update" && post) {
    const b = await readBody(req);
    fs.writeFileSync(path.join(ENV.dataDir, "update-now"), b.action === "install" ? "install" : "check");
    return json(res, 200, { ok: true });
  }

  // --- overzicht / statistieken ---
  if (p === "/api/stats") {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") || 30)));
    const serial = url.searchParams.get("serial");
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
    const list = events.filter((e) => e.time >= since.getTime() && (!serial || e.serial === serial) && visible(e.serial));
    const KINDS = ["ring", "person", "motion", "package"];
    const byDay = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since); d.setDate(since.getDate() + i);
      byDay.push({ day: dayStr(d.getTime()), ring: 0, person: 0, motion: 0, package: 0 });
    }
    const dayIdx = Object.fromEntries(byDay.map((x, i) => [x.day, i]));
    const byHour = Array.from({ length: 24 }, () => ({ all: 0, ring: 0 }));
    const byWeekday = Array(7).fill(0); // ma..zo
    const totals = { ring: 0, person: 0, motion: 0, package: 0 };
    const perCam = {};
    for (const e of list) {
      const k = KINDS.includes(e.kind) ? e.kind : "motion";
      totals[k]++;
      const i = dayIdx[dayStr(e.time)]; if (i != null) byDay[i][k]++;
      const h = Number(new Date(e.time).toLocaleTimeString("nl-NL", { hour: "2-digit", hour12: false, timeZone: ENV.tz }).slice(0, 2)) % 24;
      byHour[h].all++; if (k === "ring") byHour[h].ring++;
      const wd = (new Date(new Date(e.time).toLocaleString("en-US", { timeZone: ENV.tz })).getDay() + 6) % 7;
      byWeekday[wd]++;
      const name = displayName(e.serial); perCam[name] = (perCam[name] || 0) + 1;
    }
    const busiestDay = byDay.reduce((a, x) => { const t = x.ring + x.person + x.motion + x.package; return t > a.total ? { day: x.day, total: t } : a; }, { day: null, total: 0 });
    const busiestHour = byHour.reduce((a, x, i) => (x.all > a.count ? { hour: i, count: x.all } : a), { hour: null, count: 0 });
    return json(res, 200, { days, total: list.length, totals, byDay, byHour, byWeekday, perCam, busiestDay, busiestHour });
  }

  // --- nieuwe camera's zoeken ---
  if (p === "/api/devices/refresh" && post) {
    await send("driver.poll_refresh", {}, 60000).catch((e) => log("poll_refresh:", e.message));
    const before = Object.keys(state.devices);
    const r = await send("start_listening", {}, 60000);
    await loadState(r.state || {});
    broadcast(publicState());
    const added = Object.keys(state.devices).filter((x) => !before.includes(x));
    return json(res, 200, { ok: true, count: Object.keys(state.devices).length, added: added.map(displayName), filtered: !!ENV.deviceSerial });
  }

  // --- timelapse ---
  if ((m = p.match(/^\/api\/timelapse\/(\w+)\/(\d{4}-\d{2}-\d{2})$/)) && req.method === "DELETE") {
    fs.rmSync(path.join(TL_DIR, m[1], m[2]), { recursive: true, force: true });
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/timelapse\/(\w+)$/))) return json(res, 200, { days: tlDays(m[1]) });
  if ((m = p.match(/^\/api\/timelapse\/(\w+)\/(\d{4}-\d{2}-\d{2})$/))) return json(res, 200, { frames: tlFrames(m[1], m[2]) });
  if ((m = p.match(/^\/api\/timelapse\/(\w+)\/(\d{4}-\d{2}-\d{2})\/([\w-]+\.jpg)$/))) return sendFile(req, res, path.join(TL_DIR, m[1], m[2], path.basename(m[3])), "image/jpeg");
  if ((m = p.match(/^\/api\/timelapse\/(\w+)\/(\d{4}-\d{2}-\d{2})\/video\.mp4$/))) {
    const fps = Number(url.searchParams.get("fps")) || 0;
    const out = await tlVideo(m[1], m[2], Math.min(60, Math.max(0, fps)));
    if (url.searchParams.get("download")) res.setHeader("Content-Disposition", `attachment; filename="timelapse-${m[2]}.mp4"`);
    return sendFile(req, res, out, "video/mp4", "no-cache");
  }

  // --- app-instellingen + opslag ---
  if (p === "/api/settings" && !post) return json(res, 200, { settings, storage: await storageInfo(), remoteCount: recordings.filter((r) => r.status === "remote" && !r.removed).length });
  if (p === "/api/settings" && post) {
    const b = await readBody(req);
    const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
    if (b.storageGb != null && isFinite(b.storageGb)) settings.storageGb = num(b.storageGb, 0.5, 100000);
    if (["all", "important", "off"].includes(b.autoDownload)) settings.autoDownload = b.autoDownload;
    if (b.keepDays != null && isFinite(b.keepDays)) settings.keepDays = num(b.keepDays, 0, 3650);
    for (const k of ["notifyRing", "notifyPerson", "notifyMotion", "notifyPackage", "ntfySnapshot"]) if (typeof b[k] === "boolean") settings[k] = b[k];
    if (b.motionCooldown != null && isFinite(b.motionCooldown)) settings.motionCooldown = num(b.motionCooldown, 0, 3600);
    if (b.liveMaxSeconds != null && isFinite(b.liveMaxSeconds)) settings.liveMaxSeconds = num(b.liveMaxSeconds, 30, 1800);
    if (b.snapshotMinutes != null && isFinite(b.snapshotMinutes)) settings.snapshotMinutes = num(b.snapshotMinutes, 0, 1440);
    if (b.timelapseDays != null && isFinite(b.timelapseDays)) settings.timelapseDays = num(b.timelapseDays, 0, 3650);
    if (typeof b.defaultCamera === "string") settings.defaultCamera = b.defaultCamera;
    if (b.quiet && typeof b.quiet === "object") {
      const q = settings.quiet || { enabled: false, from: "23:00", to: "07:00", allow: ["ring"] };
      if (typeof b.quiet.enabled === "boolean") q.enabled = b.quiet.enabled;
      for (const k of ["from", "to"]) if (/^\d{2}:\d{2}$/.test(b.quiet[k] || "")) q[k] = b.quiet[k];
      if (Array.isArray(b.quiet.allow)) q.allow = b.quiet.allow.filter((x) => ["ring", "person", "motion", "package"].includes(x));
      settings.quiet = q;
    }
    if (typeof b.notifyOnlyAway === "boolean") settings.notifyOnlyAway = b.notifyOnlyAway;
    if (b.muteHours != null && isFinite(b.muteHours)) settings.muteUntil = Number(b.muteHours) > 0 ? Date.now() + Number(b.muteHours) * 3600000 : 0;
    if (b.cams && typeof b.cams === "object") {
      settings.cams = settings.cams || {};
      for (const [sn, c] of Object.entries(b.cams)) {
        const cur = settings.cams[sn] || {};
        if (["auto", "doorbell", "camera"].includes(c.kind)) cur.kind = c.kind;
        if (c.tlSeconds != null && isFinite(c.tlSeconds)) cur.tlSeconds = Math.max(-1, Math.min(86400, Number(c.tlSeconds)));
        if (c.notify && typeof c.notify === "object") {
          cur.notify = cur.notify || {};
          for (const k of ["ring", "person", "motion", "package"]) if (k in c.notify) { if (c.notify[k] === null) delete cur.notify[k]; else cur.notify[k] = !!c.notify[k]; }
        }
        settings.cams[sn] = cur;
      }
      setTimeout(manageContinuous, 500);
      for (const d of Object.values(state.devices)) broadcastDevice(d.serial);
    }
    if (b.names && typeof b.names === "object") {
      settings.names = settings.names || {};
      for (const [sn, n] of Object.entries(b.names)) { const v = String(n || "").trim().slice(0, 40); if (v) settings.names[sn] = v; else delete settings.names[sn]; }
      for (const d of Object.values(state.devices)) broadcastDevice(d.serial);
    }
    for (const k of ["snapshotOnEvent", "useEufyPicture", "timelapse"]) if (typeof b[k] === "boolean") settings[k] = b[k];
    if (b.recordSeconds != null && isFinite(b.recordSeconds)) settings.recordSeconds = num(b.recordSeconds, 10, 180);
    if (b.recordOn && typeof b.recordOn === "object") for (const k of ["ring", "person", "motion", "package"]) if (typeof b.recordOn[k] === "boolean") settings.recordOn[k] = b.recordOn[k];
    writeJson(SETTINGS_FILE, settings);
    await enforceStorage();
    if (b.autoDownload) syncRecordings().catch(() => {});
    broadcast(publicState());
    return json(res, 200, { settings, storage: await storageInfo() });
  }

  // --- apparaat ---
  if ((m = p.match(/^\/api\/device\/(\w+)\/picture\.jpg$/))) {
    const d = state.devices[m[1]];
    if (!d?.picture) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
    return res.end(d.picture);
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/live\.mp4$/))) {
    if (!state.devices[m[1]]) return json(res, 404, { error: "Onbekend apparaat" });
    res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store", Connection: "close", "X-Accel-Buffering": "no" });
    await getLive(m[1]).addViewer(res, req);
    return;
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/snapshot$/)) && post) {
    const buf = await grabSnapshot(m[1], "handmatig");
    return buf ? json(res, 200, { ok: true }) : json(res, 500, { error: "Deurbel gaf geen beeld" });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/live\/stop$/)) && post) {
    const l = live.get(m[1]);
    // loopt er een continue timelapse of opname mee, dan de stream laten lopen
    if (l && ![...l.viewers].some((v) => v.cont || v.recorder)) await l.stop("handmatig gestopt");
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/talk$/)) && post) {
    const t = getTalk(m[1]);
    const buf = await readRaw(req, 2e6);
    if (!t.active) await t.start();
    t.write(buf);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/talk\/stop$/)) && post) { await talk.get(m[1])?.stop(); return json(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/device\/(\w+)\/quick-response$/)) && post) {
    const b = await readBody(req);
    await send("device.quick_response", { serialNumber: m[1], voiceId: Number(b.voiceId) }, 20000);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/snooze$/)) && post) {
    const b = await readBody(req);
    await send("device.snooze", { serialNumber: m[1], snoozeTime: Number(b.seconds) || 0, snoozeChime: !!b.chime, snoozeMotion: !!b.motion, snoozeHomebase: !!b.homebase }, 20000);
    setTimeout(() => refreshDevice(m[1]).then(() => broadcastDevice(m[1])), 2000);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/device\/(\w+)\/property$/)) && post) {
    const b = await readBody(req);
    const d = state.devices[m[1]];
    const meta = d?.meta?.[b.name];
    if (!meta || meta.writeable !== true || HIDE.has(b.name) && b.name !== "enabled") return json(res, 400, { error: "Deze instelling kan niet" });
    await send("device.set_property", { serialNumber: m[1], name: b.name, value: b.value }, 30000);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/station\/(\w+)\/property$/)) && post) {
    const b = await readBody(req);
    const s = state.stations[m[1]];
    if (!s?.meta?.[b.name] || s.meta[b.name].writeable !== true) return json(res, 400, { error: "Deze instelling kan niet" });
    await send("station.set_property", { serialNumber: m[1], name: b.name, value: b.value }, 30000);
    return json(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/station\/(\w+)\/reboot$/)) && post) { await send("station.reboot", { serialNumber: m[1] }, 30000); return json(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/device\/(\w+)\/refresh$/)) && post) {
    await refreshDevice(m[1]);
    loadVoices(m[1]).catch(() => {});
    broadcastDevice(m[1]);
    return json(res, 200, { ok: true });
  }

  // --- inloggen bij Eufy ---
  if (p === "/api/auth/code" && post) {
    const b = await readBody(req);
    await send("driver.set_verify_code", { verifyCode: String(b.code || "").trim() }, 30000);
    state.auth = null; broadcast(publicState());
    return json(res, 200, { ok: true });
  }
  if (p === "/api/auth/captcha" && post) {
    const b = await readBody(req);
    await send("driver.set_captcha", { captchaId: state.auth?.captchaId, captcha: String(b.captcha || "").trim() }, 30000);
    state.auth = null; broadcast(publicState());
    return json(res, 200, { ok: true });
  }
  if (p === "/api/test-notification" && post) {
    if (!ENV.ntfyTopic) return json(res, 400, { error: "NTFY_TOPIC is niet ingesteld in .env" });
    await ntfy({ title: "Testmelding", message: "Meldingen van je deurbel werken.", tags: "white_check_mark", priority: "3" });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "Onbekend" });
}

server.on("error", (e) => { log(`Kan poort ${ENV.port} niet openen: ${e.message}. Draait er al iets op deze poort? Kies een andere PORT in .env.`); process.exit(1); });
server.listen(ENV.port, () => {
  log(`Dashboard op http://0.0.0.0:${ENV.port}`);
  if (!sec.users.length) log("Let op: geen pincode ingesteld, het dashboard is open voor iedereen op je netwerk");
  if (!ENV.ntfyTopic) log("Meldingen staan uit (NTFY_TOPIC leeg)");
  connectEufy();
  enforceStorage().catch(() => {});
  storageInfo(true).catch(() => {});
});
// Nooit de hele server laten crashen door één kapotte pijp of verbinding
process.on("uncaughtException", (e) => log("Onverwachte fout (genegeerd):", e && e.message));
process.on("unhandledRejection", (e) => log("Onverwachte fout (genegeerd):", e && e.message));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    for (const l of live.values()) await l.stop("server stopt").catch(() => {});
    for (const f of Object.keys(writers)) { /* laatste writes laten landen */ }
    setTimeout(() => process.exit(0), 600);
  });
}
