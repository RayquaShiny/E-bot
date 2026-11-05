/* E bot : assistant IA de Securechat (compte « ebot »)
   Répond aux messages privés qui lui sont adressés, et aux mentions « @E bot » dans les salons.
   Il se connecte comme un vrai compte : il déchiffre uniquement ce qui lui est destiné. */
const { webcrypto } = require('crypto');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/database');

const subtle = webcrypto.subtle;
const { BOT_PASSWORD, GROUP_PASSPHRASE, AI_API_KEY } = process.env;
// IA : n'importe quel service compatible « OpenAI » (par défaut Groq, gratuit et sans carte bancaire)
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';
const BOT_KEY = 'ebot', BOT_NAME = 'E bot', EMAIL = BOT_KEY + '@securechat.app';
for (const [n, v] of Object.entries({ BOT_PASSWORD, AI_API_KEY })) if (!v) { console.error('Variable manquante : ' + n); process.exit(1); }

firebase.initializeApp({
  apiKey: 'AIzaSyA1-DPVxv934DWaqMMlQsE4AGvPElb_Rl8',
  authDomain: 'chat-1e417.firebaseapp.com',
  databaseURL: 'https://chat-1e417-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'chat-1e417'
});
const db = firebase.database();
const enc = new TextEncoder(), dec = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function pbkdf2Key(secret, salt) {
  const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function aesEnc(key, bytes) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv: b64(iv), c: b64(ct) };
}
async function aesDec(key, iv, c) { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(c))); }
const dmName = (a, b) => { const s = [a, b].sort(); return 'dm_' + s[0] + '_' + s[1]; };
// Heure de Paris (le serveur GitHub est en UTC)
const nowTime = () => new Date().toLocaleTimeString('fr-FR', { timeZone: process.env.TZ_NAME || 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false });

let myPriv = null, groupKey = null;
const dmKeys = {}, names = {}, history = {}, lastAsk = {};

// Clés personnelles : on les lit (ou on les crée la première fois) comme le fait l'appli
async function loadUserKeys() {
  const pub = (await db.ref('pubkeys/' + BOT_KEY).once('value')).val();
  const wrapped = (await db.ref('privkeys/' + BOT_KEY).once('value')).val();
  if (pub && wrapped) {
    const k = await pbkdf2Key(BOT_PASSWORD, unb64(wrapped.salt));
    const pkcs8 = await aesDec(k, wrapped.iv, wrapped.c);
    myPriv = await subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveKey']);
    return;
  }
  const pair = await subtle.generateKey(ECDH, true, ['deriveKey']);
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const w = await aesEnc(await pbkdf2Key(BOT_PASSWORD, salt), pkcs8);
  await db.ref('privkeys/' + BOT_KEY).set({ salt: b64(salt), iv: w.iv, c: w.c });
  await db.ref('pubkeys/' + BOT_KEY).set({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  myPriv = await subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveKey']);
  console.log('Clés de chiffrement créées pour ' + BOT_NAME);
}
async function loadGroupKey() {
  if (!GROUP_PASSPHRASE) { console.log('GROUP_PASSPHRASE absent : le bot ne répondra qu\'en message privé.'); return; }
  const check = (await db.ref('crypto/groupCheck').once('value')).val();
  const k = await pbkdf2Key(GROUP_PASSPHRASE, enc.encode('securechat-group-v3'));
  try {
    if (!check || dec.decode(await aesDec(k, check.iv, check.c)) !== 'securechat-ok') throw 0;
    groupKey = k;
  } catch (e) { console.error('Phrase secrète du groupe incorrecte : réponses en salon désactivées.'); }
}
async function getDmKey(partner) {
  if (dmKeys[partner]) return dmKeys[partner];
  const pub = (await db.ref('pubkeys/' + partner).once('value')).val();
  if (!pub) return null;
  const pk = await subtle.importKey('jwk', pub, ECDH, false, []);
  return (dmKeys[partner] = await subtle.deriveKey({ name: 'ECDH', public: pk }, myPriv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
}
// Clé de la conversation, ou null si le bot ne doit pas y répondre
async function keyFor(chan, senderKey) {
  if (chan.startsWith('dm_')) return chan === dmName(BOT_KEY, senderKey) ? getDmKey(senderKey) : null;
  if (chan === 'self' || chan.startsWith('grp_') || chan === 'annonce-update') return null;
  return groupKey;
}

const SYSTEM = "Tu es E bot, l'assistant IA de la messagerie Securechat. Tu réponds en français, de façon chaleureuse, claire et courte (quelques phrases, 600 caractères maximum sauf si on te demande plus). " +
  "Tu peux aider, expliquer, plaisanter et faire des jeux. Tu ne prétends jamais être un humain. Tu ne connais pas le contenu des autres conversations. Pas de mise en forme Markdown compliquée.";

async function askAI(chan, who, text) {
  const h = history[chan] = history[chan] || [];
  h.push({ role: 'user', content: who + ' : ' + text });
  while (h.length > 12) h.shift();
  while (h.length && h[0].role !== 'user') h.shift();
  const r = await callAI(h);
  if (r.ok) h.push({ role: 'assistant', content: r.text }); else h.pop();
  return r.text;
}

async function reply(chan, key, text) {
  const e = await aesEnc(key, enc.encode(JSON.stringify({ t: text })));
  await db.ref('messages').push({ id: Date.now(), sender: BOT_NAME, senderKey: BOT_KEY, time: nowTime(), channel: chan, v: 3, iv: e.iv, c: e.c });
}

async function onMessage(m) {
  try {
    if (!m || !m.c || m.senderKey === BOT_KEY) return;
    const chan = m.channel || 'general';
    const key = await keyFor(chan, m.senderKey);
    if (!key) return;
    const pl = JSON.parse(dec.decode(await aesDec(key, m.iv, m.c)));
    const text = String(pl.t || '').trim();
    if (!text) return;
    const isDm = chan.startsWith('dm_');
    if (!isDm && !/@\s?e\s?bot\b/i.test(text)) return;
    const now = Date.now();
    if (now - (lastAsk[m.senderKey] || 0) < 3000) return; // anti-spam : 1 demande toutes les 3 s
    lastAsk[m.senderKey] = now;
    const who = m.sender || names[m.senderKey] || m.senderKey;
    const clean = text.replace(/@\s?e\s?bot\b/ig, '').trim() || 'Salut !';
    console.log('[' + chan + '] ' + who + ' → ' + BOT_NAME);
    await reply(chan, key, await askAI(chan, who, clean));
  } catch (e) { console.error('Message ignoré :', e.message); }
}

// ===== Mode « une passe » (GitHub Actions) : répond aux messages restés sans réponse, puis s'arrête =====
async function callAI(messages) {
  try {
    const body = { model: MODEL, max_tokens: 1500, messages: [{ role: 'system', content: SYSTEM }, ...messages] };
    if (/gpt-oss/.test(MODEL)) body.reasoning_effort = 'low';
    const r = await fetch(AI_BASE_URL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AI_API_KEY },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const out = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    if (!out) throw new Error(JSON.stringify(j.error || j).slice(0, 200));
    return { ok: true, text: out.slice(0, 1800) };
  } catch (e) {
    console.error('Erreur IA :', e.message);
    return { ok: false, text: "Oups, je n'arrive pas à réfléchir pour le moment. Réessaie dans un instant." };
  }
}
async function contextOf(list, idx, chan, key) {
  const out = [];
  for (let i = idx - 1; i >= 0 && out.length < 6; i--) {
    const x = list[i];
    if ((x.channel || 'general') !== chan || !x.c) continue;
    try {
      const pl = JSON.parse(dec.decode(await aesDec(key, x.iv, x.c)));
      if (pl.t) out.unshift(x.senderKey === BOT_KEY ? { role: 'assistant', content: String(pl.t) } : { role: 'user', content: (x.sender || x.senderKey) + ' : ' + pl.t });
    } catch (e) { /* message illisible : on l'ignore */ }
  }
  return out;
}
function mergeTurns(arr) {
  const o = [];
  for (const t of arr) { if (o.length && o[o.length - 1].role === t.role) o[o.length - 1].content += '\n' + t.content; else o.push({ ...t }); }
  while (o.length && o[0].role !== 'user') o.shift();
  return o;
}
async function once() {
  const snap = await db.ref('messages').orderByKey().limitToLast(300).once('value');
  const list = []; snap.forEach((c) => { list.push({ ...c.val(), _k: c.key }); });
  // Un message est « sans réponse » s'il est plus récent que ma dernière réponse dans la même conversation
  const lastBot = {};
  list.forEach((m) => { if (m.senderKey === BOT_KEY) lastBot[m.channel || 'general'] = m._k; });
  const cutoff = Date.now() - 45 * 60000; // on ignore ce qui date de plus de 45 min
  const mention = /@\s?e\s?bot\b/ig, groups = {};
  for (let i = 0; i < list.length; i++) {
    const m = list[i], chan = m.channel || 'general';
    if (!m.c || m.senderKey === BOT_KEY || m._k <= (lastBot[chan] || '') || (m.id && m.id < cutoff)) continue;
    const key = await keyFor(chan, m.senderKey);
    if (!key) continue;
    let text = '';
    try { text = String(JSON.parse(dec.decode(await aesDec(key, m.iv, m.c))).t || '').trim(); } catch (e) { continue; }
    if (!text) continue;
    if (!chan.startsWith('dm_') && !/@\s?e\s?bot\b/i.test(text)) continue;
    const id = chan + '|' + m.senderKey;
    const g = groups[id] = groups[id] || { chan, key, who: m.sender || m.senderKey, idx: i, texts: [] };
    g.texts.push(text.replace(mention, '').trim() || 'Salut !');
  }
  let n = 0;
  for (const g of Object.values(groups)) {
    if (n++ >= 5) break; // maximum 5 réponses par passage
    const ctx = await contextOf(list, g.idx, g.chan, g.key);
    const msgs = mergeTurns([...ctx, { role: 'user', content: g.who + ' : ' + g.texts.slice(-5).join('\n') }]);
    await reply(g.chan, g.key, (await callAI(msgs)).text);
    console.log('Réponse envoyée à ' + g.who + ' dans ' + g.chan);
  }
  if (!n) console.log('Rien à répondre.');
}

(async () => {
  await firebase.auth().signInWithEmailAndPassword(EMAIL, BOT_PASSWORD);
  await loadUserKeys();
  await loadGroupKey();
  if (process.argv.includes('--once')) { await once(); process.exit(0); }
  db.ref('accounts').on('value', (s) => { const a = s.val() || {}; Object.keys(a).forEach((k) => { names[k] = a[k].name; }); });
  const last = (await db.ref('messages').orderByKey().limitToLast(1).once('value'));
  let lastKey = ''; last.forEach((c) => { lastKey = c.key; });
  const q = lastKey ? db.ref('messages').orderByKey().startAt(lastKey) : db.ref('messages');
  q.on('child_added', (c) => { if (c.key !== lastKey) onMessage(c.val()); });
  console.log(BOT_NAME + ' est en ligne.');
})().catch((e) => { console.error('Démarrage impossible :', e.code || e.message); process.exit(1); });
