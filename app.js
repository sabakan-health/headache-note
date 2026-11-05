'use strict';
/* 頭痛ノート: 端末内のみに保存する頭痛記録PWA */

// ---------- 定数 ----------
const KEY = 'headache-note-v1';
const TYPES = { migraine: '片頭痛', tension: '緊張型', unknown: 'わからない' };
const LOCS = ['左側', '右側', '両側', 'こめかみ', '目の奥', '額', '後頭部', '首・肩'];
const QUALS = ['ズキズキ（脈打つ）', '締め付けられる', '重い・圧迫感', '刺すような'];
const SYMS = ['吐き気', '嘔吐', '光がまぶしい', '音がつらい', 'においがつらい', '動くと悪化', '前兆（閃輝暗点など）', '肩・首こり', 'めまい'];
const TRIGS = ['睡眠不足', '寝すぎ', 'ストレス', '緊張からの解放', '生理', '天気・気圧', '空腹・食事抜き', 'アルコール', '画面作業', '姿勢', '人混み・騒音', '強い光', 'におい', '疲労', 'カフェイン'];
const MEDCAT = { triptan: 'トリプタン', analgesic: '鎮痛薬', combo: '複合鎮痛薬', preventive: '予防薬', other: 'その他' };
const EFFECT = ['効かなかった', '少し効いた', '効いた', 'よく効いた'];
const PRESSURE_DROP_WARN = 3; // 6時間で何hPa下がったら注意表示するか（目安）

// ---------- 汎用 ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const dayKey = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toLocalInput = d => { d = new Date(d); return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtTime = d => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = d => { d = new Date(d); return `${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}）`; };
const fmtDur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`; };
const DAY = 86400000;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- 保存 ----------
function defaultState() {
  return {
    version: 1,
    attacks: [], doses: [],
    meds: [
      { id: 'm1', name: 'トリプタン（薬名に変更）', cat: 'triptan' },
      { id: 'm2', name: 'ロキソプロフェン', cat: 'analgesic' },
      { id: 'm3', name: 'アセトアミノフェン', cat: 'analgesic' },
    ],
    settings: { loc: null },
    weather: null,
  };
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) { console.error(e); }
  return defaultState();
}
let state = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { alert('保存に失敗しました: ' + e.message); }
}
const medById = id => state.meds.find(m => m.id === id);
const sortedAttacks = () => [...state.attacks].sort((a, b) => b.start.localeCompare(a.start));
const ongoingAttack = () => state.attacks.find(a => !a.end);

// ---------- 気圧（Open-Meteo） ----------
async function fetchWeather(force = false) {
  const loc = state.settings.loc;
  if (!loc) return null;
  const w = state.weather;
  if (!force && w && w.lat === loc.lat && w.lon === loc.lon && Date.now() - w.fetchedAt < 30 * 60000) return w;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&hourly=surface_pressure&past_days=31&forecast_days=2&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  state.weather = {
    fetchedAt: Date.now(), lat: loc.lat, lon: loc.lon,
    t: j.hourly.time.map(s => new Date(s).getTime()),
    p: j.hourly.surface_pressure,
  };
  save();
  return state.weather;
}
function pressureAt(ts) {
  const w = state.weather; if (!w) return null;
  let best = -1, bd = Infinity;
  for (let i = 0; i < w.t.length; i++) { const d = Math.abs(w.t[i] - ts); if (d < bd) { bd = d; best = i; } }
  if (best < 0 || bd > 90 * 60000 || w.p[best] == null) return null;
  return w.p[best];
}
// ts時点の気圧と、その6時間前からの変化量
function pressureSnapshot(ts) {
  const p = pressureAt(ts), p6 = pressureAt(ts - 6 * 3600000);
  if (p == null) return null;
  return { hPa: Math.round(p * 10) / 10, d6: p6 == null ? null : Math.round((p - p6) * 10) / 10 };
}
// 今から hours 時間以内に始まる6時間のうち、気圧の下降量が最大の区間
function forecastDrop(hours = 24) {
  const w = state.weather; if (!w) return null;
  const now = Date.now(); let worst = { drop: 0, from: null, to: null };
  for (let i = 0; i < w.t.length; i++) {
    if (w.t[i] < now - 3600000 || w.t[i] > now + hours * 3600000) continue;
    const j = w.t.indexOf(w.t[i] + 6 * 3600000);
    if (j < 0 || w.p[i] == null || w.p[j] == null) continue;
    const drop = w.p[i] - w.p[j];
    if (drop > worst.drop) worst = { drop, from: w.t[i], to: w.t[j] };
  }
  return worst;
}
function pressureChart() {
  const w = state.weather; if (!w) return '';
  const now = Date.now(), from = now - 24 * 3600000, to = now + 24 * 3600000;
  const pts = w.t.map((t, i) => [t, w.p[i]]).filter(([t, p]) => t >= from && t <= to && p != null);
  if (pts.length < 2) return '<p class="muted">気圧データがありません</p>';
  const W = 320, H = 110, L = 30, R = 6, T = 8, B = 18;
  const ps = pts.map(x => x[1]); let lo = Math.min(...ps), hi = Math.max(...ps);
  if (hi - lo < 6) { const m = (hi + lo) / 2; lo = m - 3; hi = m + 3; }
  const x = t => L + (t - from) / (to - from) * (W - L - R);
  const y = p => T + (hi - p) / (hi - lo) * (H - T - B);
  const past = pts.filter(p => p[0] <= now), fut = pts.filter(p => p[0] >= now - 3600000);
  const path = arr => arr.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v)}</text>
    <line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="前後24時間の気圧">
    ${ticks}
    <path d="${path(past)}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <path d="${path(fut)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/>
    <line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1"/>
    <text x="${x(now)}" y="${H - 5}" text-anchor="middle">今</text>
    <text x="${L}" y="${H - 5}">24時間前</text>
    <text x="${W - R}" y="${H - 5}" text-anchor="end">24時間後</text>
  </svg>`;
}

// ---------- 服薬日数（薬剤の使用過多による頭痛の目安） ----------
function medDays(sinceTs) {
  const days = { all: new Set(), triptan: new Set(), analgesic: new Set() };
  for (const d of state.doses) {
    const t = new Date(d.time).getTime(); if (t < sinceTs) continue;
    const m = medById(d.medId); const cat = m ? m.cat : 'other';
    if (cat === 'preventive') continue;
    const k = dayKey(t); days.all.add(k);
    if (cat === 'triptan' || cat === 'combo') days.triptan.add(k);
    if (cat === 'analgesic') days.analgesic.add(k);
  }
  return { all: days.all.size, triptan: days.triptan.size, analgesic: days.analgesic.size };
}
function mohAlert(md) {
  // 国際頭痛分類（ICHD-3）の目安: トリプタン・複合鎮痛薬は月10日以上、単一の鎮痛薬は月15日以上、
  // 複数の種類を合わせて月10日以上で「薬剤の使用過多による頭痛」が疑われる
  if (md.triptan >= 10 || md.analgesic >= 15 || md.all >= 10)
    return `<div class="alert danger">直近30日で頭痛薬を飲んだ日が${md.all}日あります。頭痛薬を月10日以上飲むと、薬が原因で頭痛が増えることがあります（薬剤の使用過多による頭痛）。医師に相談してください。</div>`;
  if (md.all >= 8)
    return `<div class="alert warn">直近30日で頭痛薬を飲んだ日が${md.all}日です。月10日を超えないように注意してください。</div>`;
  return '';
}

// ---------- 片頭痛・緊張型のヒント ----------
function typeHint(a) {
  const s = new Set([...(a.symptoms || []), ...(a.locations || []), ...(a.qualities || [])]);
  let mig = 0, ten = 0;
  if (s.has('ズキズキ（脈打つ）')) mig++;
  if (s.has('左側') || s.has('右側')) mig++;
  if (s.has('動くと悪化')) mig++;
  if (a.intensity >= 6) mig++;
  if (s.has('吐き気') || s.has('嘔吐')) mig += 2;
  if (s.has('光がまぶしい') && s.has('音がつらい')) mig++;
  if (s.has('前兆（閃輝暗点など）')) mig += 2;
  if (s.has('締め付けられる') || s.has('重い・圧迫感')) ten++;
  if (s.has('両側') || s.has('後頭部')) ten++;
  if (s.has('肩・首こり')) ten++;
  if (a.intensity > 0 && a.intensity <= 5) ten++;
  if (!s.has('動くと悪化') && !s.has('吐き気') && !s.has('嘔吐') && s.size > 0) ten++;
  if (mig + ten < 2) return '';
  if (mig >= ten + 2) return '選んだ症状は片頭痛の特徴に多く当てはまります。';
  if (ten >= mig + 2) return '選んだ症状は緊張型頭痛の特徴に多く当てはまります。';
  return '片頭痛と緊張型頭痛の両方の特徴があります。';
}

// ---------- タブ ----------
let tab = 'home';
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let calSel = dayKey(Date.now());
let statsRange = 90;

function render() {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const v = $('#view');
  if (tab === 'home') v.innerHTML = viewHome();
  else if (tab === 'calendar') v.innerHTML = viewCalendar();
  else if (tab === 'stats') v.innerHTML = viewStats();
  else if (tab === 'settings') v.innerHTML = viewSettings();
  else if (tab === 'report') v.innerHTML = viewReport();
  $('#title').textContent = { home: '頭痛ノート', calendar: 'カレンダー', stats: '分析', settings: '設定', report: '受診用レポート' }[tab];
}
$$('.tabbar button').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));

function attackItem(a) {
  const doses = state.doses.filter(d => d.attackId === a.id);
  const dur = a.end ? fmtDur(new Date(a.end) - new Date(a.start)) : '継続中';
  return `<li data-act="edit-attack" data-id="${a.id}">
    <div class="row between"><strong>${fmtDate(a.start)} ${fmtTime(a.start)}</strong><span class="muted">${dur}</span></div>
    <div class="small"><span class="tag ${a.type}">${TYPES[a.type]}</span>強さ ${a.intensity}/10
    ${doses.map(d => `<span class="tag med">${esc(medById(d.medId)?.name || '薬')}</span>`).join('')}</div>
  </li>`;
}

// ---------- ホーム ----------
function viewHome() {
  const on = ongoingAttack();
  const md = medDays(Date.now() - 30 * DAY);
  const days30 = new Set(state.attacks.filter(a => new Date(a.start) >= Date.now() - 30 * DAY).map(a => dayKey(a.start))).size;
  const recent = sortedAttacks().slice(0, 5);
  let top;
  if (on) {
    top = `<div class="card ongoing">
      <div class="row between"><strong>頭痛中</strong><span class="muted">${fmtTime(on.start)}から ${fmtDur(Date.now() - new Date(on.start))}</span></div>
      <div class="small" style="margin:6px 0 10px"><span class="tag ${on.type}">${TYPES[on.type]}</span>強さ ${on.intensity}/10</div>
      <div class="grid2">
        <button class="btn" data-act="edit-attack" data-id="${on.id}">記録を編集</button>
        <button class="btn primary" data-act="end-attack" data-id="${on.id}">治まった</button>
      </div>
    </div>`;
  } else {
    top = `<button class="big-btn" data-act="new-attack">頭痛が始まった</button><div style="height:12px"></div>`;
  }
  return `${top}
  <div class="grid2" style="margin-bottom:12px">
    <button class="btn" data-act="new-dose">薬を飲んだ</button>
    <button class="btn" data-act="past-attack">過去の頭痛を記録</button>
  </div>
  <div class="card"><h2>気圧</h2>${weatherBlock()}</div>
  <div class="card"><h2>直近30日</h2>
    <div class="grid2">
      <div class="stat"><div class="v">${days30}<small>日</small></div><div class="l">頭痛があった日</div></div>
      <div class="stat"><div class="v">${md.all}<small>日</small></div><div class="l">頭痛薬を飲んだ日</div></div>
    </div>${mohAlert(md)}
  </div>
  <div class="card"><h2>最近の記録</h2>
    ${recent.length ? `<ul class="list">${recent.map(attackItem).join('')}</ul>` : '<p class="muted">まだ記録がありません</p>'}
  </div>`;
}
function weatherBlock() {
  if (!state.settings.loc) return `<p class="muted">地域を登録すると、気圧の変化と低下の予報を表示します。</p>
    <button class="btn" data-act="goto-settings">地域を登録する</button>`;
  const w = state.weather;
  if (!w) { refreshWeather(); return '<p class="muted">読み込み中…</p>'; }
  if (Date.now() - w.fetchedAt > 30 * 60000) refreshWeather();
  const cur = pressureSnapshot(Date.now());
  const fd = forecastDrop(24);
  let msg = '';
  if (fd && fd.drop >= PRESSURE_DROP_WARN)
    msg = `<div class="alert warn">${fmtDate(fd.from)} ${fmtTime(fd.from)}〜${fmtTime(fd.to)}の6時間で、気圧が${fd.drop.toFixed(1)}hPa下がる予報です。</div>`;
  else if (fd) msg = `<div class="alert ok">今後24時間に大きな気圧低下の予報はありません。</div>`;
  return `<div class="row between"><span><strong style="font-size:20px">${cur ? cur.hPa : '-'}</strong> hPa
    ${cur && cur.d6 != null ? `<span class="muted">（6時間で${cur.d6 > 0 ? '+' : ''}${cur.d6}）</span>` : ''}</span>
    <span class="muted">${esc(state.settings.loc.name)}</span></div>
    ${pressureChart()}${msg}
    <div class="muted" style="margin-top:6px">${fmtTime(w.fetchedAt)}に取得・気象データ Open-Meteo</div>`;
}
let weatherLoading = false;
async function refreshWeather(force) {
  if (weatherLoading) return; weatherLoading = true;
  try { await fetchWeather(force); } catch (e) { console.warn(e); toast('気圧を取得できませんでした'); }
  weatherLoading = false;
  if (tab === 'home') render();
}

// ---------- シート（入力フォーム） ----------
function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheet').classList.remove('hidden'); $('#sheetBg').classList.remove('hidden');
  $('#sheet').scrollTop = 0;
}
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheetBg').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#sheetBg').addEventListener('click', closeSheet);

const chips = (name, opts, sel) => `<div class="chips" data-chips="${name}">${opts.map(o =>
  `<button type="button" class="chip ${sel.includes(o) ? 'on' : ''}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
const medOptions = sel => state.meds.map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
const effectOptions = sel => `<option value="">（あとで評価）</option>` + EFFECT.map((e, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${e}</option>`).join('');

function doseRow(d) {
  return `<div class="dose-row" data-dose="${d.id || ''}">
    <select class="full" name="medId">${medOptions(d.medId)}</select>
    <input type="datetime-local" name="time" value="${toLocalInput(d.time)}">
    <button type="button" class="btn danger" data-act="rm-dose-row">削除</button>
    <select class="full" name="effect">${effectOptions(d.effect)}</select>
  </div>`;
}

function attackForm(a) {
  const isNew = !state.attacks.some(x => x.id === a.id);
  const doses = state.doses.filter(d => d.attackId === a.id);
  openSheet(`<h3>${isNew ? '頭痛を記録' : '頭痛の記録を編集'}</h3>
  <form id="attackForm" data-id="${a.id}">
    <div class="field"><label>始まった時刻</label><input type="datetime-local" name="start" value="${toLocalInput(a.start)}" required></div>
    <div class="field"><label>治まった時刻</label>
      <div class="row"><label class="small"><input type="checkbox" name="ongoing" ${a.end ? '' : 'checked'}> まだ続いている</label></div>
      <input type="datetime-local" name="end" value="${a.end ? toLocalInput(a.end) : toLocalInput(Date.now())}" ${a.end ? '' : 'disabled'} style="margin-top:6px">
    </div>
    <div class="field"><span class="lbl">痛みの強さ（0：なし、10：最悪）</span>
      <div class="range-wrap"><input type="range" name="intensity" min="0" max="10" value="${a.intensity}"><span class="range-val" id="ival">${a.intensity}</span></div>
    </div>
    <div class="field"><span class="lbl">痛む場所</span>${chips('locations', LOCS, a.locations)}</div>
    <div class="field"><span class="lbl">痛み方</span>${chips('qualities', QUALS, a.qualities)}</div>
    <div class="field"><span class="lbl">一緒に出た症状</span>${chips('symptoms', SYMS, a.symptoms)}</div>
    <div class="field"><span class="lbl">頭痛の種類</span>
      <div class="seg" data-seg="type">${Object.entries(TYPES).map(([k, v]) => `<button type="button" data-v="${k}" class="${a.type === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="hint" id="typeHint" style="${typeHint(a) ? '' : 'display:none'}">${typeHint(a)}</div>
    </div>
    <div class="field"><span class="lbl">きっかけになったと思うもの</span>${chips('triggers', TRIGS, a.triggers)}</div>
    <div class="field"><span class="lbl">飲んだ薬</span>
      <div id="doseRows">${doses.map(doseRow).join('')}</div>
      <button type="button" class="btn block" data-act="add-dose-row">＋ 薬を追加</button>
    </div>
    <div class="field"><label>メモ</label><textarea name="memo" placeholder="仕事や食事など気になったこと">${esc(a.memo)}</textarea></div>
    ${isNew ? '' : '<button type="button" class="btn danger block" data-act="del-attack" style="margin-bottom:10px">この記録を削除</button>'}
    <div class="sheet-actions"><button type="button" class="btn" data-act="close">キャンセル</button><button class="btn primary">保存</button></div>
  </form>`);
  const f = $('#attackForm');
  f._data = { ...a, locations: [...a.locations], qualities: [...a.qualities], symptoms: [...a.symptoms], triggers: [...a.triggers] };
  const updateHint = () => { const h = typeHint(f._data); const el = $('#typeHint'); el.textContent = h; el.style.display = h ? '' : 'none'; };
  f.intensity.addEventListener('input', () => { $('#ival').textContent = f.intensity.value; f._data.intensity = +f.intensity.value; updateHint(); });
  f.ongoing.addEventListener('change', () => { f.end.disabled = f.ongoing.checked; });
  $$('[data-chips]', f).forEach(box => box.addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const arr = f._data[box.dataset.chips]; const v = c.dataset.v; const i = arr.indexOf(v);
    i >= 0 ? arr.splice(i, 1) : arr.push(v); c.classList.toggle('on'); updateHint();
  }));
  $('[data-seg=type]', f).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    f._data.type = b.dataset.v; $$('[data-seg=type] button', f).forEach(x => x.classList.toggle('on', x === b));
  });
  f.addEventListener('submit', e => { e.preventDefault(); saveAttackForm(f); });
}

function saveAttackForm(f) {
  const d = f._data;
  const start = new Date(f.start.value);
  if (isNaN(start)) return toast('開始時刻を入力してください');
  let end = null;
  if (!f.ongoing.checked) {
    end = new Date(f.end.value);
    if (isNaN(end) || end < start) return toast('治まった時刻が開始より前です');
  }
  const a = {
    id: d.id, start: start.toISOString(), end: end ? end.toISOString() : null, intensity: +f.intensity.value,
    type: d.type, locations: d.locations, qualities: d.qualities, symptoms: d.symptoms, triggers: d.triggers,
    memo: f.memo.value.trim(), pressure: d.pressure || null,
  };
  if (!a.pressure || d.start !== a.start) a.pressure = pressureSnapshot(start.getTime());
  const i = state.attacks.findIndex(x => x.id === a.id);
  i >= 0 ? (state.attacks[i] = a) : state.attacks.push(a);
  // 服薬の同期
  const keep = new Set();
  for (const row of $$('.dose-row', f)) {
    const time = new Date(row.querySelector('[name=time]').value);
    if (isNaN(time)) continue;
    const ev = row.querySelector('[name=effect]').value;
    const dose = { id: row.dataset.dose || uid(), attackId: a.id, medId: row.querySelector('[name=medId]').value, time: time.toISOString(), effect: ev === '' ? null : +ev };
    keep.add(dose.id);
    const j = state.doses.findIndex(x => x.id === dose.id);
    j >= 0 ? (state.doses[j] = dose) : state.doses.push(dose);
  }
  state.doses = state.doses.filter(x => x.attackId !== a.id || keep.has(x.id));
  save(); closeSheet(); render(); toast('保存しました');
  // 気圧が未取得なら後から補完
  if (!a.pressure && state.settings.loc) fetchWeather(true).then(() => {
    const x = state.attacks.find(y => y.id === a.id); if (x && !x.pressure) { x.pressure = pressureSnapshot(new Date(x.start).getTime()); save(); }
  }).catch(() => {});
}

function newAttack(startTs) {
  return { id: uid(), start: new Date(startTs).toISOString(), end: null, intensity: 5, type: 'unknown', locations: [], qualities: [], symptoms: [], triggers: [], memo: '', pressure: null };
}

function doseForm(dose) {
  const isNew = !state.doses.some(x => x.id === dose.id);
  const on = ongoingAttack();
  const attackOpts = sortedAttacks().slice(0, 15).map(a => `<option value="${a.id}" ${dose.attackId === a.id ? 'selected' : ''}>${fmtDate(a.start)} ${fmtTime(a.start)} の頭痛</option>`).join('');
  openSheet(`<h3>${isNew ? '薬を記録' : '服薬の記録を編集'}</h3>
  <form id="doseForm">
    <div class="field"><label>薬</label><select name="medId">${medOptions(dose.medId)}</select></div>
    <div class="field"><label>飲んだ時刻</label><input type="datetime-local" name="time" value="${toLocalInput(dose.time)}"></div>
    <div class="field"><label>効き目</label><select name="effect">${effectOptions(dose.effect)}</select></div>
    <div class="field"><label>どの頭痛に対して</label><select name="attackId"><option value="">（頭痛と結びつけない）</option>${attackOpts}</select></div>
    ${isNew ? '' : '<button type="button" class="btn danger block" data-act="del-dose" style="margin-bottom:10px">この記録を削除</button>'}
    <div class="sheet-actions"><button type="button" class="btn" data-act="close">キャンセル</button><button class="btn primary">保存</button></div>
  </form>`);
  const f = $('#doseForm');
  if (isNew && on) f.attackId.value = on.id;
  f.addEventListener('submit', e => {
    e.preventDefault();
    const t = new Date(f.time.value); if (isNaN(t)) return toast('時刻を入力してください');
    const nd = { id: dose.id, medId: f.medId.value, time: t.toISOString(), effect: f.effect.value === '' ? null : +f.effect.value, attackId: f.attackId.value || null };
    const i = state.doses.findIndex(x => x.id === nd.id);
    i >= 0 ? (state.doses[i] = nd) : state.doses.push(nd);
    save(); closeSheet(); render(); toast('保存しました');
  });
  $('[data-act=del-dose]', f)?.setAttribute('data-id', dose.id);
}

// ---------- カレンダー ----------
function dayInfo() {
  const m = {};
  for (const a of state.attacks) {
    const k = dayKey(a.start); const x = m[k] ||= { attacks: [], doses: [] }; x.attacks.push(a);
  }
  for (const d of state.doses) { const k = dayKey(d.time); const x = m[k] ||= { attacks: [], doses: [] }; x.doses.push(d); }
  return m;
}
function viewCalendar() {
  const info = dayInfo();
  const y = calMonth.getFullYear(), mo = calMonth.getMonth();
  const first = new Date(y, mo, 1); const start = new Date(y, mo, 1 - first.getDay());
  const today = dayKey(Date.now());
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const k = dayKey(d); const x = info[k];
    let dot = '';
    if (x && x.attacks.length) {
      const top = x.attacks.reduce((p, c) => c.intensity > p.intensity ? c : p);
      const op = 0.35 + top.intensity / 10 * 0.65;
      dot = `<div class="dot" style="background:var(--${top.type === 'migraine' ? 'mig' : top.type === 'tension' ? 'ten' : 'unk'});opacity:${op}"></div>`;
    }
    const pill = x && x.doses.length ? `<div class="pill">薬${x.doses.length}</div>` : '';
    cells += `<div class="day ${d.getMonth() !== mo ? 'out' : ''} ${k === today ? 'today' : ''} ${k === calSel ? 'sel' : ''}" data-act="cal-day" data-k="${k}">${d.getDate()}${dot}${pill}</div>`;
    if (i >= 34 && d.getMonth() !== mo && d.getDay() === 6) break;
  }
  const monthAttacks = state.attacks.filter(a => { const d = new Date(a.start); return d.getFullYear() === y && d.getMonth() === mo; });
  const mDays = new Set(monthAttacks.map(a => dayKey(a.start))).size;
  const mMed = new Set(state.doses.filter(d => { const t = new Date(d.time); return t.getFullYear() === y && t.getMonth() === mo && medById(d.medId)?.cat !== 'preventive'; }).map(d => dayKey(d.time))).size;
  const sel = info[calSel];
  const selDate = new Date(calSel + 'T12:00');
  return `<div class="card">
    <div class="row between" style="margin-bottom:8px">
      <button class="btn" data-act="cal-prev">‹</button><strong>${y}年${mo + 1}月</strong><button class="btn" data-act="cal-next">›</button>
    </div>
    <div class="cal">${'日月火水木金土'.split('').map(c => `<div class="dow">${c}</div>`).join('')}${cells}</div>
    <div class="legend"><span><i style="background:var(--mig)"></i>片頭痛</span><span><i style="background:var(--ten)"></i>緊張型</span><span><i style="background:var(--unk)"></i>わからない</span><span>色が濃いほど強い痛み</span></div>
    <p class="small" style="margin:8px 0 0">この月：頭痛 ${mDays}日・頭痛薬 ${mMed}日</p>
  </div>
  <div class="card"><h2>${fmtDate(selDate)}</h2>
    ${sel && sel.attacks.length ? `<ul class="list">${sel.attacks.map(attackItem).join('')}</ul>` : '<p class="muted">頭痛の記録はありません</p>'}
    ${sel && sel.doses.filter(d => !d.attackId).length ? `<p class="small" style="margin-bottom:4px">頭痛と結びつけていない服薬</p><ul class="list">${sel.doses.filter(d => !d.attackId).map(d =>
      `<li data-act="edit-dose" data-id="${d.id}">${fmtTime(d.time)} ${esc(medById(d.medId)?.name || '薬')}${d.effect != null ? `（${EFFECT[d.effect]}）` : ''}</li>`).join('')}</ul>` : ''}
    <div class="grid2" style="margin-top:8px"><button class="btn" data-act="cal-add-attack">この日に頭痛を追加</button><button class="btn" data-act="cal-add-dose">この日に薬を追加</button></div>
  </div>`;
}

// ---------- 分析 ----------
function statsFor(fromTs, toTs = Date.now()) {
  const as = state.attacks.filter(a => { const t = new Date(a.start).getTime(); return t >= fromTs && t <= toTs; });
  const ds = state.doses.filter(d => { const t = new Date(d.time).getTime(); return t >= fromTs && t <= toTs; });
  const days = new Set(as.map(a => dayKey(a.start))).size;
  const medDaySet = new Set(ds.filter(d => medById(d.medId)?.cat !== 'preventive').map(d => dayKey(d.time)));
  const avg = as.length ? as.reduce((s, a) => s + a.intensity, 0) / as.length : 0;
  const durs = as.filter(a => a.end).map(a => new Date(a.end) - new Date(a.start));
  const avgDur = durs.length ? durs.reduce((s, x) => s + x, 0) / durs.length : null;
  const byType = { migraine: 0, tension: 0, unknown: 0 }; as.forEach(a => byType[a.type]++);
  const count = key => { const c = {}; as.forEach(a => (a[key] || []).forEach(v => c[v] = (c[v] || 0) + 1)); return Object.entries(c).sort((a, b) => b[1] - a[1]); };
  const medEff = {};
  ds.forEach(d => { const e = medEff[d.medId] ||= { n: 0, rated: 0, sum: 0 }; e.n++; if (d.effect != null) { e.rated++; e.sum += d.effect; } });
  const withP = as.filter(a => a.pressure && a.pressure.d6 != null);
  const pDrop = withP.filter(a => a.pressure.d6 <= -2).length;
  return { as, ds, days, medDays: medDaySet.size, avg, avgDur, byType, triggers: count('triggers'), symptoms: count('symptoms'), medEff, withP: withP.length, pDrop };
}
function barList(entries, total) {
  if (!entries.length) return '<p class="muted">記録がありません</p>';
  const max = Math.max(...entries.map(e => e[1]));
  return `<div class="bar-list">${entries.slice(0, 8).map(([k, v]) => `<div class="b"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${v / max * 100}%"></div></div><span>${v}</span></div>`).join('')}</div>
    <p class="muted" style="margin:4px 0 0">数字は${total}回の頭痛のうち、その項目を選んだ回数</p>`;
}
function monthlyChart(n = 6) {
  const now = new Date(); const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = new Date(now.getFullYear(), now.getMonth() - i, 1), e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const st = statsFor(s.getTime(), e.getTime() - 1);
    months.push({ label: `${s.getMonth() + 1}月`, days: st.days, med: st.medDays });
  }
  const W = 320, H = 140, L = 22, B = 20, T = 10, max = Math.max(10, ...months.map(m => Math.max(m.days, m.med)));
  const bw = (W - L) / n; const y = v => T + (1 - v / max) * (H - T - B);
  const bars = months.map((m, i) => {
    const x = L + i * bw;
    return `<rect x="${x + bw * 0.15}" y="${y(m.days)}" width="${bw * 0.33}" height="${H - B - y(m.days)}" fill="var(--mig)" rx="2"/>
      <rect x="${x + bw * 0.52}" y="${y(m.med)}" width="${bw * 0.33}" height="${H - B - y(m.med)}" fill="var(--accent)" opacity=".45" rx="2"/>
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${m.label}</text>
      <text x="${x + bw * 0.315}" y="${y(m.days) - 2}" text-anchor="middle">${m.days || ''}</text>`;
  }).join('');
  const line10 = `<line x1="${L}" x2="${W}" y1="${y(10)}" y2="${y(10)}" stroke="var(--danger)" stroke-dasharray="3 3"/><text x="${L - 3}" y="${y(10) + 3}" text-anchor="end">10</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="月ごとの頭痛日数と服薬日数">${line10}${bars}</svg>
    <div class="legend"><span><i style="background:var(--mig)"></i>頭痛があった日数</span><span><i style="background:var(--accent);opacity:.45"></i>頭痛薬を飲んだ日数</span><span>赤い点線：月10日</span></div>`;
}
function viewStats() {
  const st = statsFor(Date.now() - statsRange * DAY);
  const n = st.as.length;
  const medRows = Object.entries(st.medEff).map(([id, e]) =>
    `<tr><td>${esc(medById(id)?.name || '削除した薬')}</td><td>${e.n}回</td><td>${e.rated ? EFFECT[Math.round(e.sum / e.rated)] + `（${e.rated}回評価）` : '未評価'}</td></tr>`).join('');
  return `<div class="seg no-print" style="margin-bottom:12px">${[30, 90, 180].map(r => `<button data-act="range" data-r="${r}" class="${statsRange === r ? 'on' : ''}">${r}日</button>`).join('')}</div>
  <div class="card"><h2>直近${statsRange}日のまとめ</h2>
    <div class="grid2">
      <div class="stat"><div class="v">${st.days}<small>日</small></div><div class="l">頭痛があった日（月あたり${(st.days / statsRange * 30).toFixed(1)}日）</div></div>
      <div class="stat"><div class="v">${n}<small>回</small></div><div class="l">頭痛の回数</div></div>
      <div class="stat"><div class="v">${n ? st.avg.toFixed(1) : '-'}</div><div class="l">平均の強さ（0〜10）</div></div>
      <div class="stat"><div class="v">${st.avgDur ? fmtDur(st.avgDur) : '-'}</div><div class="l">平均の持続時間</div></div>
      <div class="stat"><div class="v">${st.byType.migraine}/${st.byType.tension}/${st.byType.unknown}</div><div class="l">片頭痛/緊張型/不明 の回数</div></div>
      <div class="stat"><div class="v">${st.medDays}<small>日</small></div><div class="l">頭痛薬を飲んだ日</div></div>
    </div>
  </div>
  <div class="card"><h2>月ごとの推移（6か月）</h2>${monthlyChart()}</div>
  <div class="card"><h2>きっかけ</h2>${barList(st.triggers, n)}</div>
  <div class="card"><h2>気圧との関係</h2>${st.withP ? `<p class="small" style="margin:0">気圧を記録できた${st.withP}回の頭痛のうち、始まる前の6時間で気圧が2hPa以上下がっていたのは${st.pDrop}回（${Math.round(st.pDrop / st.withP * 100)}%）です。</p>
    <p class="muted">気圧が下がらない日にも頭痛は起きるため、この割合だけで気圧が原因とは言えません。記録が増えるほど傾向を読みやすくなります。</p>` : '<p class="muted">地域を登録してから記録した頭痛について、気圧の変化を集計します。</p>'}</div>
  <div class="card"><h2>薬の効き目</h2>${medRows ? `<table><tr><th>薬</th><th>回数</th><th>平均の効き目</th></tr>${medRows}</table>` : '<p class="muted">服薬の記録がありません</p>'}</div>
  <button class="btn primary block" data-act="goto-report">受診用レポートを作る</button>`;
}

// ---------- 受診用レポート ----------
let reportRange = 90;
function viewReport() {
  const from = Date.now() - reportRange * DAY;
  const st = statsFor(from);
  const md30 = medDays(Date.now() - 30 * DAY);
  const rows = [...st.as].sort((a, b) => a.start.localeCompare(b.start)).map(a => {
    const ds = state.doses.filter(d => d.attackId === a.id);
    return `<tr><td>${fmtDate(a.start)}<br>${fmtTime(a.start)}</td><td>${a.end ? fmtDur(new Date(a.end) - new Date(a.start)) : '継続中'}</td>
      <td>${TYPES[a.type]}</td><td>${a.intensity}</td>
      <td>${esc([...a.locations, ...a.qualities, ...a.symptoms].join('、'))}</td>
      <td>${ds.map(d => esc(medById(d.medId)?.name || '薬') + (d.effect != null ? `（${EFFECT[d.effect]}）` : '')).join('<br>')}</td>
      <td>${esc(a.triggers.join('、'))}${a.memo ? '<br>' + esc(a.memo) : ''}</td></tr>`;
  }).join('');
  const medRows = Object.entries(st.medEff).map(([id, e]) => {
    const m = medById(id); const days = new Set(st.ds.filter(d => d.medId === id).map(d => dayKey(d.time))).size;
    return `<tr><td>${esc(m?.name || '削除した薬')}</td><td>${MEDCAT[m?.cat] || ''}</td><td>${e.n}回・${days}日</td><td>${e.rated ? EFFECT[Math.round(e.sum / e.rated)] : '未評価'}</td></tr>`;
  }).join('');
  return `<div class="no-print" style="margin-bottom:12px">
    <div class="seg" style="margin-bottom:8px">${[30, 90, 180].map(r => `<button data-act="rep-range" data-r="${r}" class="${reportRange === r ? 'on' : ''}">${r}日</button>`).join('')}</div>
    <div class="grid2"><button class="btn" data-act="goto-stats">戻る</button><button class="btn primary" data-act="print">印刷・PDF保存</button></div>
  </div>
  <div class="card report">
    <div class="rep-head"><strong style="font-size:18px">頭痛の記録</strong><span class="small">${dayKey(from)} 〜 ${dayKey(Date.now())}（${reportRange}日間）</span></div>
    <h2>概要</h2>
    <table>
      <tr><th>頭痛があった日数</th><td>${st.days}日（30日あたり${(st.days / reportRange * 30).toFixed(1)}日）</td></tr>
      <tr><th>頭痛の回数</th><td>${st.as.length}回（片頭痛 ${st.byType.migraine}、緊張型 ${st.byType.tension}、本人が判断できなかったもの ${st.byType.unknown}）</td></tr>
      <tr><th>平均の強さ</th><td>${st.as.length ? st.avg.toFixed(1) : '-'}（0〜10の自己評価）</td></tr>
      <tr><th>平均の持続時間</th><td>${st.avgDur ? fmtDur(st.avgDur) : '-'}</td></tr>
      <tr><th>頭痛薬を飲んだ日数</th><td>${st.medDays}日（予防薬を除く）、直近30日では${md30.all}日</td></tr>
      <tr><th>多かった症状</th><td>${esc(st.symptoms.slice(0, 5).map(([k, v]) => `${k} ${v}回`).join('、')) || '-'}</td></tr>
      <tr><th>多かったきっかけ</th><td>${esc(st.triggers.slice(0, 5).map(([k, v]) => `${k} ${v}回`).join('、')) || '-'}</td></tr>
    </table>
    <h2>月ごとの推移</h2>${monthlyChart()}
    <h2>使った薬</h2>${medRows ? `<table><tr><th>薬</th><th>種類</th><th>使用</th><th>平均の効き目</th></tr>${medRows}</table>` : '<p class="muted">記録なし</p>'}
    <h2>頭痛ごとの記録</h2>
    ${rows ? `<table><tr><th>日時</th><th>持続</th><th>種類</th><th>強さ</th><th>場所・痛み方・症状</th><th>薬（効き目）</th><th>きっかけ・メモ</th></tr>${rows}</table>` : '<p class="muted">記録なし</p>'}
    <p class="muted" style="margin-top:12px">本人がアプリ「頭痛ノート」で記録した内容です。頭痛の種類は本人の判断です。</p>
  </div>`;
}

// ---------- 設定 ----------
function viewSettings() {
  const loc = state.settings.loc;
  return `<div class="card"><h2>地域（気圧の取得に使う）</h2>
    <p class="small" style="margin-top:0">${loc ? `現在：<strong>${esc(loc.name)}</strong>` : '未登録'}</p>
    <div class="row" style="flex-wrap:nowrap"><input type="search" id="citySearch" placeholder="市区町村名（例：横浜）"><button class="btn" data-act="city-search">検索</button></div>
    <div id="cityResults"></div>
    <button class="btn block" data-act="geo" style="margin-top:8px">現在地を使う</button>
    <p class="muted">緯度・経度を気象データサービス Open-Meteo に送り、気圧を取得します。頭痛の記録は送りません。</p>
    ${loc ? '<button class="btn danger" data-act="clear-loc">地域の登録を解除</button>' : ''}
  </div>
  <div class="card"><h2>薬の一覧</h2>
    <ul class="list">${state.meds.map(m => `<li style="cursor:default"><div class="row between"><span>${esc(m.name)} <span class="tag med">${MEDCAT[m.cat]}</span></span>
      <span><button class="btn" data-act="edit-med" data-id="${m.id}">編集</button></span></div></li>`).join('')}</ul>
    <button class="btn block" data-act="add-med" style="margin-top:8px">＋ 薬を追加</button>
    <p class="muted">種類を「予防薬」にした薬は、頭痛薬を飲んだ日数に数えません。</p>
  </div>
  <div class="card"><h2>データ</h2>
    <p class="small" style="margin-top:0">記録はこの端末のブラウザの中だけに保存しています。ブラウザのデータを消すと記録も消えるため、ときどき書き出して保管してください。</p>
    <div class="grid2"><button class="btn" data-act="export">書き出し（JSON）</button><button class="btn" data-act="import">読み込み</button></div>
    <input type="file" id="importFile" accept="application/json,.json" class="hidden">
    <p class="muted">頭痛 ${state.attacks.length}件・服薬 ${state.doses.length}件</p>
    <button class="btn danger block" data-act="wipe">すべての記録を削除</button>
  </div>
  <p class="muted">このアプリは記録用です。診断はしません。いつもと違う激しい頭痛、手足のしびれ、ろれつが回らない、熱を伴う頭痛などがあるときは、すぐに医療機関を受診してください。</p>`;
}
function medForm(m) {
  const isNew = !state.meds.some(x => x.id === m.id);
  openSheet(`<h3>${isNew ? '薬を追加' : '薬を編集'}</h3><form id="medForm">
    <div class="field"><label>薬の名前</label><input type="text" name="name" value="${esc(m.name)}" required></div>
    <div class="field"><label>種類</label><select name="cat">${Object.entries(MEDCAT).map(([k, v]) => `<option value="${k}" ${m.cat === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    ${isNew ? '' : `<button type="button" class="btn danger block" data-act="del-med" data-id="${m.id}" style="margin-bottom:10px">この薬を一覧から削除</button>`}
    <div class="sheet-actions"><button type="button" class="btn" data-act="close">キャンセル</button><button class="btn primary">保存</button></div></form>`);
  const f = $('#medForm');
  f.addEventListener('submit', e => {
    e.preventDefault();
    const nm = { id: m.id, name: f.name.value.trim(), cat: f.cat.value }; if (!nm.name) return;
    const i = state.meds.findIndex(x => x.id === nm.id); i >= 0 ? (state.meds[i] = nm) : state.meds.push(nm);
    save(); closeSheet(); render();
  });
}
async function citySearch() {
  const q = $('#citySearch').value.trim(); if (!q) return;
  const box = $('#cityResults'); box.innerHTML = '<p class="muted">検索中…</p>';
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=ja&format=json`);
    const j = await r.json();
    const res = j.results || [];
    box.innerHTML = res.length ? `<ul class="list">${res.map((c, i) => `<li data-act="pick-city" data-i="${i}">${esc(c.name)} <span class="muted">${esc([c.admin1, c.country].filter(Boolean).join('、'))}</span></li>`).join('')}</ul>` : '<p class="muted">見つかりませんでした</p>';
    box._res = res;
  } catch (e) { box.innerHTML = '<p class="muted">検索できませんでした</p>'; }
}
function setLoc(lat, lon, name) {
  state.settings.loc = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, name };
  state.weather = null; save(); render(); toast('地域を登録しました'); refreshWeather(true);
}

// ---------- データ入出力 ----------
function exportData() {
  const data = { ...state, weather: undefined, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `headache-note-${dayKey(Date.now())}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const j = JSON.parse(r.result);
      if (!Array.isArray(j.attacks) || !Array.isArray(j.doses) || !Array.isArray(j.meds)) throw new Error('形式が違います');
      if (!confirm(`頭痛${j.attacks.length}件・服薬${j.doses.length}件を読み込みます。今の記録は置き換わります。よろしいですか？`)) return;
      state = Object.assign(defaultState(), j, { weather: null }); delete state.exportedAt;
      save(); render(); toast('読み込みました');
    } catch (e) { alert('読み込めませんでした：' + e.message); }
  };
  r.readAsText(file);
}

// ---------- イベント ----------
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case 'new-attack': attackForm(newAttack(Date.now())); break;
    case 'past-attack': { const a = newAttack(Date.now() - 2 * 3600000); a.end = new Date().toISOString(); attackForm(a); break; }
    case 'edit-attack': attackForm(state.attacks.find(a => a.id === id)); break;
    case 'end-attack': {
      const a = state.attacks.find(x => x.id === id); a.end = new Date().toISOString(); save(); render();
      toast(`${fmtDur(new Date(a.end) - new Date(a.start))}続きました`); break;
    }
    case 'del-attack': {
      const fid = $('#attackForm').dataset.id;
      if (!confirm('この頭痛の記録と、結びつけた服薬の記録を削除します。')) return;
      state.attacks = state.attacks.filter(a => a.id !== fid); state.doses = state.doses.filter(d => d.attackId !== fid);
      save(); closeSheet(); render(); break;
    }
    case 'add-dose-row': {
      // 継続中なら今、終わった頭痛なら開始時刻を初期値にする
      const f = $('#attackForm'); const st = new Date(f.start.value).getTime();
      const t = f.ongoing.checked || isNaN(st) ? Date.now() : st;
      $('#doseRows').insertAdjacentHTML('beforeend', doseRow({ medId: state.meds[0]?.id, time: t, effect: null }));
      if (!state.meds.length) toast('設定で薬を登録してください');
      break;
    }
    case 'rm-dose-row': el.closest('.dose-row').remove(); break;
    case 'new-dose': doseForm({ id: uid(), medId: state.meds[0]?.id, time: Date.now(), effect: null, attackId: null }); break;
    case 'edit-dose': doseForm(state.doses.find(d => d.id === id)); break;
    case 'del-dose': if (confirm('この服薬の記録を削除します。')) { state.doses = state.doses.filter(d => d.id !== id); save(); closeSheet(); render(); } break;
    case 'close': closeSheet(); break;
    case 'goto-settings': tab = 'settings'; render(); break;
    case 'goto-report': tab = 'report'; render(); window.scrollTo(0, 0); break;
    case 'goto-stats': tab = 'stats'; render(); break;
    case 'print': window.print(); break;
    case 'range': statsRange = +el.dataset.r; render(); break;
    case 'rep-range': reportRange = +el.dataset.r; render(); break;
    case 'cal-prev': calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); render(); break;
    case 'cal-next': calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); render(); break;
    case 'cal-day': calSel = el.dataset.k; render(); break;
    case 'cal-add-attack': { const a = newAttack(new Date(calSel + 'T12:00').getTime()); a.end = new Date(calSel + 'T14:00').toISOString(); attackForm(a); break; }
    case 'cal-add-dose': doseForm({ id: uid(), medId: state.meds[0]?.id, time: new Date(calSel + 'T12:00').getTime(), effect: null, attackId: null }); break;
    case 'city-search': citySearch(); break;
    case 'pick-city': { const c = $('#cityResults')._res[+el.dataset.i]; setLoc(c.latitude, c.longitude, c.name); break; }
    case 'geo':
      if (!navigator.geolocation) return toast('この端末では現在地を使えません');
      navigator.geolocation.getCurrentPosition(p => setLoc(p.coords.latitude, p.coords.longitude, '現在地'), () => toast('現在地を取得できませんでした'), { timeout: 10000 });
      break;
    case 'clear-loc': state.settings.loc = null; state.weather = null; save(); render(); break;
    case 'add-med': medForm({ id: uid(), name: '', cat: 'analgesic' }); break;
    case 'edit-med': medForm(state.meds.find(m => m.id === id)); break;
    case 'del-med': if (confirm('薬を一覧から削除します。過去の服薬記録は残ります。')) { state.meds = state.meds.filter(m => m.id !== id); save(); closeSheet(); render(); } break;
    case 'export': exportData(); break;
    case 'import': $('#importFile').click(); break;
    case 'wipe':
      if (confirm('すべての頭痛・服薬の記録を削除します。元に戻せません。') && confirm('本当に削除しますか？先に書き出しておくことをおすすめします。')) {
        state = defaultState(); save(); render(); toast('削除しました');
      }
      break;
  }
});
document.addEventListener('change', e => { if (e.target.id === 'importFile' && e.target.files[0]) importData(e.target.files[0]); });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'citySearch') { e.preventDefault(); citySearch(); } });

// 経過時間の表示を1分ごとに更新
setInterval(() => { if (tab === 'home' && $('#sheet').classList.contains('hidden')) render(); }, 60000);

render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(console.warn);
