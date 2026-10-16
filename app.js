// Doza — micro-doses de vocabulaire russe (répétition espacée, 100 % local).
'use strict';

const STORE_KEY = 'doza.v1';
const DAY = 86400000;
const RETURN_APPS = {
  instagram: ['Instagram', 'instagram://'],
  tinder: ['Tinder', 'tinder://'],
  hinge: ['Hinge', 'hinge://'],
  bumble: ['Bumble', 'bumble://'],
  tiktok: ['TikTok', 'snssdk1233://'],
  youtube: ['YouTube', 'youtube://'],
  x: ['X', 'twitter://'],
  snapchat: ['Snapchat', 'snapchat://'],
  reddit: ['Reddit', 'reddit://'],
};

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ---------- Stockage ----------
function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* stockage indisponible */ }
  const defaults = {
    items: {},          // "cardId:ru" | "cardId:tr" -> { due, ivl, ease, reps, lapses, last }
    settings: { n: 5, newPerDay: 15, dir: 'ru', tts: false, goal: 50 },
    days: {},           // "YYYY-MM-DD" -> { reviews, new }
  };
  s = s || {};
  const merged = { ...defaults, ...s, settings: { ...defaults.settings, ...s.settings } };
  if (merged.settingsV !== 1) { merged.settings.n = 5; merged.settingsV = 1; } // doses de 5 par défaut
  return merged;
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}
const today = () => new Date().toLocaleDateString('sv'); // AAAA-MM-JJ local
function dayLog() { return (state.days[today()] ||= { reviews: 0, new: 0, ok: 0 }); }

let state = loadState();
let cards = [];         // contenu de cards.json
let queue = [];         // items de la dose en cours
let doneCount = 0;
let sessionSize = 0;
let current = null;
let combo = 0;          // bonnes réponses d'affilée dans la dose
let sessionXp = 0;
let sessionStartLevel = 1;
let sessionOk = 0;

// ---------- Planification (SM-2 simplifié) ----------
// L'intervalle grandit selon le temps réellement écoulé depuis la dernière révision :
// réviser 3 fois le même jour ne fait pas exploser l'intervalle, et retrouver un mot
// après une longue pause compte (en partie) cette pause.
const MAX_IVL = 365;
function schedule(st, grade, now, fuzz = true) {
  st = st ? { ...st } : { ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
  const elapsed = st.last ? (now - st.last) / DAY : 0;
  const early = elapsed < st.ivl;
  if (grade === 0) {
    st.lapses += 1;
    st.reps = 0;
    st.ease = Math.max(1.3, st.ease - 0.2);
    st.ivl = 0;
    st.due = now + 10 * 60000; // revient dans une prochaine dose
  } else {
    const base = early ? elapsed : (st.ivl + elapsed) / 2;
    let ivl;
    if (st.reps === 0) ivl = grade === 3 ? 4 : 1;
    else if (st.reps === 1 && grade === 2) ivl = Math.max(3, base * st.ease);
    else ivl = base * st.ease * (grade === 3 ? 1.3 : grade === 1 ? 0.5 : 1);
    if (early) ivl = Math.max(ivl, st.ivl); // une révision anticipée ne fait pas reculer
    if (!early || st.reps === 0) st.ease += grade === 3 ? 0.15 : grade === 1 ? -0.15 : 0;
    st.ease = Math.min(3, Math.max(1.3, st.ease));
    if (fuzz) ivl *= 0.95 + Math.random() * 0.1;
    st.ivl = Math.min(MAX_IVL, Math.max(1, Math.round(ivl)));
    st.reps += 1;
    st.due = now + st.ivl * DAY;
  }
  st.last = now;
  return st;
}
function fmtIvl(st) {
  const ms = st.due - Date.now();
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + ' min';
  const d = Math.round(ms / DAY);
  if (d < 31) return d + ' j';
  if (d < 365) return Math.round(d / 30) + ' mois';
  return +(d / 365).toFixed(1) + ' an';
}

// ---------- Construction de la dose ----------
function itemKeys(card) {
  const dir = state.settings.dir;
  const keys = [];
  if (dir !== 'tr') keys.push(card.id + ':ru');
  if (dir === 'tr') keys.push(card.id + ':tr');
  // Mode mixte : le sens traduction → russe se débloque quand russe → traduction a été réussi 2 fois d'affilée.
  if (dir === 'mix') {
    const fwd = state.items[card.id + ':ru'];
    if (fwd && fwd.reps >= 2) keys.push(card.id + ':tr');
  }
  return keys;
}
function counts() {
  const now = Date.now();
  let due = 0, fresh = 0, learned = 0;
  for (const c of cards) for (const k of itemKeys(c)) {
    const st = state.items[k];
    if (!st) fresh++;
    else { if (st.due <= now) due++; if (st.ivl >= 21) learned++; }
  }
  return { due, fresh, learned };
}
function buildQueue(n) {
  const now = Date.now();
  const due = [], fresh = [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) for (const k of itemKeys(c)) {
    const st = state.items[k];
    if (!st) fresh.push(k);
    else if (st.due <= now) due.push(k);
  }
  due.sort((a, b) => state.items[a].due - state.items[b].due);
  const picked = due.slice(0, n);
  const newLeft = Math.max(0, state.settings.newPerDay - dayLog().new);
  picked.push(...fresh.slice(0, Math.min(n - picked.length, newLeft)));
  // Mélange léger pour éviter d'avoir toujours le même ordre.
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked.map((k) => {
    const [id, side] = k.split(':');
    return { key: k, card: byId.get(id), side, retry: false };
  });
}

// ---------- Rendu ----------
function show(view) {
  for (const v of ['review', 'done', 'settings']) $('view-' + v).hidden = v !== view;
}
function renderStats() {
  const c = counts();
  const streak = streakDays();
  $('stats').textContent = `${c.due.toLocaleString('fr')} à revoir · ${streak}🔥`;
  $('stats').title = `${c.fresh} nouvelles cartes en attente`;
  renderGoal();
  renderLevel();
}
function renderGoal() {
  const done = state.days[today()]?.reviews || 0;
  const goal = state.settings.goal;
  const pct = Math.round((done / goal) * 100);
  $('goal-text').textContent = `Aujourd'hui : ${done} / ${goal} cartes`;
  $('goal-pct').textContent = pct >= 100 ? 'Objectif atteint ✓' : pct + ' %';
  $('goal-fill').style.width = Math.min(100, pct) + '%';
  $('goal').classList.toggle('reached', pct >= 100);
}
function streakDays() {
  let n = 0;
  const d = new Date();
  if (!state.days[today()]?.reviews) d.setDate(d.getDate() - 1);
  while (state.days[d.toLocaleDateString('sv')]?.reviews) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function renderProgress() {
  $('progress').innerHTML = Array.from({ length: sessionSize }, (_, i) =>
    `<span class="${i < doneCount ? 'on' : ''}"></span>`).join('');
  $('combo').textContent = combo >= 3 ? `${combo} d'affilée` : '';
  $('combo').hidden = combo < 3;
}
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/́/g, ''));
  u.lang = 'ru-RU';
  u.rate = 0.9;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ru'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
// ---------- Reconnaissance vocale ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
function normRu(t) {
  return t.toLowerCase().normalize('NFD').replace(/\u0301/g, '').normalize('NFC')
    .replace(/ё/g, 'е').replace(/[^а-я\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}
// « Жечь(Сжигать)/Сжечь » → ["жечь сжигать сжечь", "жечь", "сжигать", "сжечь"]
function ruVariants(ru) {
  const whole = normRu(ru.replace(/\(.*?\)/g, ' '));
  const parts = ru.split(/[\/,;()|\n]/).map(normRu).filter((p) => p.length > 1);
  return [...new Set([whole, ...parts].filter(Boolean))];
}
function similarity(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}
function checkSpeech(heard, ru) {
  let best = 0;
  for (const h of heard.map(normRu)) for (const v of ruVariants(ru)) {
    best = Math.max(best, similarity(h, v), h.includes(v) && v.length > 3 ? 1 : 0);
  }
  return best;
}
let listening = null;
function listen() {
  if (!Recognition || !current) return;
  if (listening) { listening.abort(); return; }
  const card = current.card;
  const rec = new Recognition();
  rec.lang = 'ru-RU';
  rec.maxAlternatives = 5;
  rec.interimResults = false;
  listening = rec;
  $('btn-mic').classList.add('on');
  setHeard('Je t\'écoute…', '');
  rec.onresult = (e) => {
    const heard = Array.from(e.results[0]).map((a) => a.transcript);
    const score = checkSpeech(heard, card.ru);
    if (current?.card !== card) return;
    if (score >= 0.8) {
      setHeard(`✓ « ${heard[0]} »`, 'ok');
      if (!$('btn-show').hidden) reveal();
    } else if (score >= 0.6) {
      setHeard(`Presque : « ${heard[0]} »`, 'near');
    } else {
      setHeard(`✗ Entendu : « ${heard[0]} »`, 'ko');
    }
  };
  rec.onerror = (e) => {
    setHeard(e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'Micro bloqué : autorise-le dans les réglages du navigateur.'
      : e.error === 'no-speech' ? 'Rien entendu, réessaie.' : 'Reconnaissance indisponible (' + e.error + ').', 'ko');
  };
  rec.onend = () => { listening = null; $('btn-mic').classList.remove('on'); };
  try { rec.start(); } catch (err) { rec.onend(); }
}
function setHeard(text, cls) {
  const el = $('heard');
  el.textContent = text;
  el.className = 'heard ' + cls;
  el.hidden = !text;
}

function next() {
  renderStats();
  renderProgress();
  current = queue.shift();
  if (!current) return finish();
  const { card, side } = current;
  const ruFirst = side === 'ru';
  $('prompt-lang').textContent = ruFirst ? 'Russe → ?' : '? → Russe';
  $('prompt').textContent = ruFirst ? card.ru : card.tr;
  $('answer-text').textContent = ruFirst ? card.tr : card.ru;
  $('note').textContent = card.note || '';
  $('answer').hidden = true;
  $('btn-show').hidden = false;
  $('grades').hidden = true;
  $('btn-speak').hidden = !ruFirst;
  $('btn-mic').hidden = !Recognition;
  $('btn-mic').title = ruFirst ? 'Prononce ce mot' : 'Dis le mot en russe';
  if (listening) listening.abort();
  setHeard('', '');
  if (ruFirst && state.settings.tts) speak(card.ru);
}
function reveal() {
  $('answer').hidden = false;
  $('btn-show').hidden = true;
  $('grades').hidden = false;
  $('btn-speak').hidden = false;
  if (current.side === 'tr' && state.settings.tts) speak(current.card.ru);
  const st = state.items[current.key];
  for (const g of [0, 2, 3]) $('hint-' + g).textContent = fmtIvl(schedule(st, g, Date.now()));
}
function grade(g) {
  const now = Date.now();
  const prev = state.items[current.key];
  if (!current.retry) {
    const day = dayLog();
    if (day.anchored0 === undefined) day.anchored0 = counts().learned;
    if (!prev) day.new += 1;
    state.items[current.key] = schedule(prev, g, now);
    day.reviews += 1;
    doneCount += 1;
    if (g > 0) { day.ok = (day.ok || 0) + 1; sessionOk += 1; combo += 1; } else combo = 0;
    let xp = g > 0 ? XP_OK : XP_KO;
    if (day.reviews === state.settings.goal) xp += XP_GOAL;
    state.xp = (state.xp || 0) + xp;
    sessionXp += xp;
    day.bestCombo = Math.max(day.bestCombo || 0, combo);
  }
  // Une carte ratée repasse une fois en fin de dose (sans toucher au planning).
  if (g === 0 && !current.retry) queue.push({ ...current, retry: true });
  saveState();
  next();
}
function finish() {
  show('done');
  renderStats();
  const c = counts();
  $('done-text').textContent = doneCount ? '' : 'Rien à réviser pour l\'instant. Tu peux y aller.';
  $('done-text').hidden = !!doneCount;
  renderGoal();
  renderSummary();
  const app = RETURN_APPS[params.get('return')];
  const back = $('btn-return');
  if (app) {
    back.textContent = 'Retour à ' + app[0];
    // Sur iPhone, le retour passe par le raccourci « Doza retour » : il laisse passer
    // la prochaine ouverture de l'appli sans relancer de dose.
    back.href = /iPhone|iPad|iPod/.test(navigator.userAgent)
      ? 'shortcuts://run-shortcut?name=' + encodeURIComponent('Doza retour') + '&input=text&text=' + encodeURIComponent(app[1])
      : app[1];
    back.hidden = false;
  } else back.hidden = true;
}
// ---------- Niveaux et paliers ----------
// Paliers : cartes revues dans Doza (on repart de zéro). L'historique AnkiApp (33 209 révisions)
// sert seulement à planifier les cartes et s'affiche à part dans les réglages.
const ANKIAPP_REVIEWS = 33209;
const RANKS = [
  [0, 'Новичок', 'Débutant'], [500, 'Ученик', 'Apprenti'], [1500, 'Студент', 'Étudiant'],
  [3000, 'Знаток', 'Connaisseur'], [5000, 'Мастер', 'Maître'], [8000, 'Профессор', 'Professeur'],
  [12000, 'Полиглот', 'Polyglotte'], [18000, 'Академик', 'Académicien'], [25000, 'Носитель языка', 'Natif'],
  [35000, 'Легенда', 'Légende'],
];
// Niveaux : XP gagnée dans Doza. 10 XP par bonne réponse, 4 par carte ratée, 50 quand l'objectif du jour tombe.
const XP_OK = 10, XP_KO = 4, XP_GOAL = 50;
const xpToNext = (lvl) => 250 + 50 * (lvl - 1);
function levelInfo(xp = state.xp || 0) {
  let lvl = 1, rest = xp;
  while (rest >= xpToNext(lvl)) { rest -= xpToNext(lvl); lvl += 1; }
  return { lvl, rest, need: xpToNext(lvl) };
}
function totalReviews() {
  return Object.values(state.days).reduce((s, d) => s + (d.reviews || 0), 0);
}
function rankInfo(total = totalReviews()) {
  let i = 0;
  while (i + 1 < RANKS.length && total >= RANKS[i + 1][0]) i += 1;
  return { rank: RANKS[i], next: RANKS[i + 1] || null };
}
function renderLevel() {
  const { lvl } = levelInfo();
  $('level-chip').textContent = 'Niv. ' + lvl;
}

// ---------- Bilan de fin de dose ----------
function renderSummary() {
  const c = counts();
  const day = dayLog();
  const goal = state.settings.goal;
  const pct = Math.round((day.reviews / goal) * 100);
  const gained = c.learned - (day.anchored0 ?? c.learned);
  const total = totalReviews();
  const { rank, next: nextRank } = rankInfo(total);
  const lv = levelInfo();
  const rate = averageDaily() || goal;
  const etaDays = Math.ceil(c.due / rate);
  const rows = [];
  if (doneCount) rows.push(['Cette dose', `${sessionOk} / ${doneCount} justes`]);
  rows.push(['Objectif du jour', pct >= 100 ? `Atteint (${day.reviews} cartes)` : `${pct} % · encore ${goal - day.reviews} cartes`]);
  rows.push(['Cartes revues dans Doza', total.toLocaleString('fr')]);
  rows.push(['Palier', `${rank[1]} · ${rank[2]}`]);
  if (nextRank) rows.push([`Vers ${nextRank[1]}`, `encore ${(nextRank[0] - total).toLocaleString('fr')}`]);
  rows.push(['Mots ancrés', `${c.learned.toLocaleString('fr')}${gained > 0 ? ` (+${gained} aujourd'hui)` : ''}`]);
  if (c.due) rows.push(['Retard', `${c.due.toLocaleString('fr')} cartes · environ ${etaDays} j à ${Math.round(rate)} / jour`]);
  if (day.bestCombo >= 3) rows.push(["Meilleure série aujourd'hui", `${day.bestCombo} d'affilée`]);
  $('summary').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('milestone-fill').style.width = Math.round((lv.rest / lv.need) * 100) + '%';
  $('milestone-label').innerHTML = `<b>Niveau ${lv.lvl}</b><span>${lv.rest} / ${lv.need} XP${sessionXp ? ` · +${sessionXp} XP` : ''}</span>`;
  const levelUp = lv.lvl > sessionStartLevel;
  $('done-title').textContent = levelUp ? `Niveau ${lv.lvl} ⬆` : pct >= 100 && !day.celebrated ? 'Objectif atteint 🎯' : 'Готово ✓';
  $('done-title').classList.toggle('levelup', levelUp);
  if (pct >= 100 && !day.celebrated) { day.celebrated = true; saveState(); }
  renderHeatmap();
}
function averageDaily() {
  const d = new Date();
  let sum = 0, n = 0;
  for (let i = 1; i <= 7; i++) {
    d.setDate(d.getDate() - 1);
    const r = state.days[d.toLocaleDateString('sv')]?.reviews;
    if (r) { sum += r; n += 1; }
  }
  return n ? sum / n : 0;
}
// 12 semaines de révisions, une case par jour (lundi en haut), comme le calendrier GitHub.
function renderHeatmap() {
  const goal = state.settings.goal;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 7 * 11 - ((end.getDay() + 6) % 7));
  const cells = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = d.toLocaleDateString('sv');
    const r = state.days[key]?.reviews || 0;
    const lvl = r === 0 ? 0 : r < goal / 2 ? 1 : r < goal ? 2 : 3;
    cells.push(`<i class="l${lvl}" title="${key} : ${r} cartes"></i>`);
  }
  $('heatmap').innerHTML = cells.join('');
}

function startSession() {
  sessionSize = Number(params.get('n')) || state.settings.n;
  queue = buildQueue(sessionSize);
  sessionSize = queue.length;
  doneCount = 0;
  combo = 0;
  sessionOk = 0;
  sessionXp = 0;
  sessionStartLevel = levelInfo().lvl;
  show('review');
  next();
}

// ---------- Réglages ----------
function openSettings() {
  const s = state.settings;
  $('set-n').value = String(s.n);
  $('set-new').value = String(s.newPerDay);
  $('set-dir').value = s.dir;
  $('set-tts').checked = s.tts;
  $('set-goal').value = String(s.goal);
  const ci = counts();
  $('deck-info').textContent = `${cards.length} cartes dans le paquet · ${ci.fresh} nouvelles en attente · ${ci.learned} bien ancrées (≥ 3 semaines) · ${totalReviews().toLocaleString('fr')} révisions dans Doza, plus ${ANKIAPP_REVIEWS.toLocaleString('fr')} sur AnkiApp.`;
  show('settings');
}
function closeSettings() {
  state.settings = {
    n: Number($('set-n').value),
    newPerDay: Number($('set-new').value),
    dir: $('set-dir').value,
    tts: $('set-tts').checked,
    goal: Number($('set-goal').value),
  };
  saveState();
  startSession();
}
function exportProgress() {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `doza-progression-${today()}.json`;
  a.click();
}
async function importProgress(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.items) throw new Error('format');
    state = Object.assign(loadState(), data);
    saveState();
    alert('Progression restaurée.');
    openSettings();
  } catch (e) {
    alert('Fichier invalide.');
  }
}

// ---------- Démarrage ----------
async function loadCards() {
  try {
    const r = await fetch('cards.json', { cache: 'no-cache' });
    return (await r.json()).cards;
  } catch (e) {
    return [];
  }
}
// Historique importé d'AnkiApp : appliqué une seule fois, sans écraser ce qui a déjà été révisé ici.
// Une nouvelle version du seed remplace les états importés, jamais une carte révisée ici depuis.
const SEED_VERSION = 2;
async function applySeed() {
  if (state.seedVersion === SEED_VERSION) return;
  try {
    const seed = await (await fetch('seed.json', { cache: 'no-cache' })).json();
    for (const [k, st] of Object.entries(seed)) {
      const cur = state.items[k];
      if (!cur || cur.last <= st.last) state.items[k] = st;
    }
    state.seedVersion = SEED_VERSION;
    saveState();
  } catch (e) { /* pas de seed : on démarre de zéro */ }
}
async function init() {
  $('btn-show').onclick = reveal;
  $('card').onclick = (e) => { if (!$('btn-show').hidden && !e.target.closest('.icon')) reveal(); };
  $('btn-mic').onclick = listen;
  $('grades').onclick = (e) => { const b = e.target.closest('button'); if (b) grade(Number(b.dataset.grade)); };
  $('btn-speak').onclick = () => speak(current?.card.ru);
  $('btn-more').onclick = startSession;
  $('btn-settings').onclick = openSettings;
  $('btn-back').onclick = closeSettings;
  $('btn-export').onclick = exportProgress;
  $('file-import').onchange = (e) => e.target.files[0] && importProgress(e.target.files[0]);
  $('btn-reset').onclick = () => {
    if (confirm('Effacer toute ta progression ?')) { state.items = {}; state.days = {}; saveState(); openSettings(); }
  };
  document.addEventListener('keydown', (e) => {
    if ($('view-review').hidden) return;
    if (e.key === ' ' && !$('btn-show').hidden) { e.preventDefault(); reveal(); }
    else if (e.key === 'm') listen();
    else if (!$('grades').hidden && { 1: 0, 2: 2, 3: 3 }[e.key] !== undefined) grade({ 1: 0, 2: 2, 3: 3 }[e.key]);
  });
  cards = await loadCards();
  await applySeed();
  startSession();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
