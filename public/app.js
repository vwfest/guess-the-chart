'use strict';
(() => {
  // ---------- helpers (all dynamic text goes through textContent: never innerHTML) ----------
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const money = (n, d = 2) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const TZ = 'America/Los_Angeles';
  const fmtDT = ms => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const fmtD = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
  function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3600); }

  let csrf = null;
  async function api(path, opts = {}) {
    const o = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (o.method !== 'GET') {
      if (!csrf) csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()).token;
      o.headers['content-type'] = 'application/json'; o.headers['x-csrf-token'] = csrf;
      o.body = JSON.stringify(opts.body || {});
    }
    const r = await fetch('/api' + path, o);
    let j = {}; try { j = await r.json(); } catch {}
    if (r.status === 403 && /token/i.test(j.error || '')) csrf = null;
    if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; e.data = j; throw e; }
    return j;
  }

  // ---------- state ----------
  const S = { st: null, lb: null, skew: 0, sort: 'price', known: new Set(), me: null, armed: false, price: null, hist: [] };
  const nowMs = () => Date.now() + S.skew;

  // ---------- top bar / auth ----------
  // Default: nickname + emoji only. Email/password and Phantom are behind server flags (AUTH_EMAIL / AUTH_WALLET) and reappear when on.
  const cfgOf = () => (S.st && S.st.config) || {};
  const KEY = 'gtc.token';
  const store = { get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }, set(v) { try { localStorage.setItem(KEY, v); } catch {} }, del() { try { localStorage.removeItem(KEY); } catch {} } };
  function renderAuth() {
    const box = clear($('#authbox')); const cfg = cfgOf();
    if (S.me) {
      box.append(h('a', { class: 'chip', href: '#/profile' }, h('span', { class: 'e', text: S.me.emoji }), h('span', { text: S.me.name })));
      // Legacy email accounts can't log back in while email login is off, so they only get "Switch player" when that's safe.
      if (S.me.kind === 'nick' || cfg.authEmail) box.append(h('button', { class: 'btn ghost small', id: 'logoutBtn', onclick: switchPlayer }, S.me.kind === 'nick' ? 'Switch' : 'Log out'));
    } else if (cfg.authNickname !== false) {
      box.append(h('button', { class: 'btn small green', id: 'loginBtn', onclick: () => openAuth('nick') }, 'Pick a nickname'));
      if (cfg.authEmail) box.append(h('button', { class: 'btn small', id: 'emailLoginBtn', onclick: () => openAuth('login') }, 'Log in'));
    } else if (cfg.authEmail) {
      box.append(h('button', { class: 'btn small', id: 'loginBtn', onclick: () => openAuth('login') }, 'Log in'), h('button', { class: 'btn small green', id: 'signupBtn', onclick: () => openAuth('signup') }, 'Sign up'));
    }
  }
  async function switchPlayer() {
    if (S.me.kind === 'nick' && !confirm('Switch player? Your nickname "' + S.me.name + '" stays reserved, but you will need its recovery key (Profile page) to use it again.')) return;
    await api('/logout', { method: 'POST' }); S.me = null; csrf = null; store.del(); await refreshState(); toast('Switched'); route();
  }
  function closeModal() { $('#modal').hidden = true; clear($('#modalIn')); document.body.style.overflow = ''; }
  function openModal(node) { const m = $('#modal'), mi = clear($('#modalIn')); mi.append(h('button', { class: 'x', 'aria-label': 'Close', onclick: closeModal }, '×'), node); m.hidden = false; document.body.style.overflow = 'hidden'; }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  function emojiPicker(onPick) {
    const emojis = cfgOf().emojis || [];
    const chosen = h('div', { class: 'chosen', id: 'chosen' }, h('span', { class: 'tiny', text: 'Pick your permanent emoji marker ↓' }));
    const grid = h('div', { class: 'egrid', id: 'egrid', role: 'radiogroup', 'aria-label': 'Emoji marker' }, emojis.map(e =>
      h('label', { title: e }, h('input', { type: 'radio', name: 'emoji', value: e, onchange: () => { onPick(e); clear(chosen).append(h('big', { text: e }), h('span', { text: 'Your marker — permanent!' })); } }), h('span', { text: e }))));
    return h('div', { class: 'field' }, h('span', { text: 'Choose your emoji marker' }), chosen, grid);
  }
  function afterAuth(r, welcome) {
    S.me = r.me; csrf = null; if (r.token) store.set(r.token);
    closeModal(); toast(welcome);
    return refreshState().then(() => { renderAuth(); route(); });
  }

  function openAuth(mode) {
    const cfg = cfgOf(); let picked = '';
    const wrap = h('div'); const err = h('div', { class: 'err', id: 'authErr', role: 'alert' });
    const submitBtn = h('button', { class: 'btn', type: 'submit', id: 'authSubmit', style: 'width:100%;margin-top:10px' });
    const form = h('form', { id: 'authForm', novalidate: true });
    const tabs = h('div', { class: 'tabs' });
    const tab = (id, m, label) => tabs.append(h('button', { type: 'button', class: mode === m ? 'on' : '', id, onclick: () => { closeModal(); openAuth(m); } }, label));
    if (cfg.authNickname !== false) tab('tab-nick', 'nick', 'Nickname');
    if (cfg.authEmail) { tab('tab-signup', 'signup', 'Sign up'); tab('tab-login', 'login', 'Log in'); }
    let focusEl;
    if (mode === 'nick') {
      const name = h('input', { type: 'text', name: 'name', id: 'f-name', autocomplete: 'off', maxlength: '16', placeholder: '3–16 letters, numbers, _ . -', 'aria-describedby': 'authErr' });
      focusEl = name;
      form.append(h('label', { class: 'field' }, h('span', { text: 'Your nickname (public, unique)' }), name), emojiPicker(e => picked = e),
        h('div', { class: 'tiny', text: 'Free to play. No email, no password, no wallet. Your nickname is saved in this browser — you get a recovery key on your Profile page.' }));
      submitBtn.textContent = 'Let me play';
      form.append(err, submitBtn);
      form.addEventListener('submit', async ev => {
        ev.preventDefault(); err.textContent = ''; submitBtn.disabled = true;
        try {
          if (!picked) throw new Error('Pick an emoji from the grid.');
          const r = await api('/nick/join', { method: 'POST', body: { name: name.value.trim(), emoji: picked } });
          await afterAuth(r, 'Welcome to the table, ' + r.me.name + ' ' + r.me.emoji);
        } catch (e) { err.textContent = e.message; } finally { submitBtn.disabled = false; }
      });
      const rec = h('details', { class: 'recover' }, h('summary', { text: 'Already have a nickname? Use your recovery key' }),
        h('input', { type: 'text', id: 'f-key', autocomplete: 'off', maxlength: '64', placeholder: 'Paste recovery key', style: 'margin-top:8px' }),
        h('button', { type: 'button', class: 'btn ghost small', id: 'useKey', style: 'margin-top:8px', onclick: async () => {
          err.textContent = '';
          try { const key = $('#f-key').value.trim(); const r = await api('/nick/resume', { method: 'POST', body: { token: key } }); r.token = key; await afterAuth(r, 'Welcome back ' + r.me.emoji); } catch (e) { err.textContent = e.message; }
        } }, 'Restore'));
      form.append(rec);
    } else {
      const email = h('input', { type: 'email', name: 'email', id: 'f-email', autocomplete: 'email', maxlength: '254', required: true });
      const pass = h('input', { type: 'password', name: 'password', id: 'f-pass', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', maxlength: '72', required: true });
      const name = h('input', { type: 'text', name: 'name', id: 'f-name', autocomplete: 'nickname', maxlength: '16', placeholder: '3–16 letters, numbers, _ . -' });
      focusEl = email;
      form.append(h('label', { class: 'field' }, h('span', { text: 'Email' }), email), h('label', { class: 'field' }, h('span', { text: mode === 'signup' ? 'Password (10+ characters)' : 'Password' }), pass));
      if (mode === 'signup') form.append(h('label', { class: 'field' }, h('span', { text: 'Display name (public)' }), name), emojiPicker(e => picked = e));
      submitBtn.textContent = mode === 'signup' ? 'Create account' : 'Log in';
      form.append(err, submitBtn);
      form.addEventListener('submit', async ev => {
        ev.preventDefault(); err.textContent = ''; submitBtn.disabled = true;
        try {
          const body = mode === 'signup' ? { email: email.value, password: pass.value, name: name.value, emoji: picked } : { email: email.value, password: pass.value };
          if (mode === 'signup' && !picked) throw new Error('Pick an emoji from the grid.');
          const r = await api(mode === 'signup' ? '/signup' : '/login', { method: 'POST', body });
          await afterAuth(r, mode === 'signup' ? 'Welcome to the table, ' + r.me.name + ' ' + r.me.emoji : 'Welcome back ' + r.me.emoji);
        } catch (e) { err.textContent = e.message; } finally { submitBtn.disabled = false; }
      });
    }
    wrap.append(h('h2', { id: 'modalTitle', text: mode === 'nick' ? 'Pick your nickname' : mode === 'signup' ? 'Join the table' : 'Welcome back' }));
    if (tabs.children.length > 1) wrap.append(tabs);
    wrap.append(form);
    openModal(wrap);
    setTimeout(() => focusEl && focusEl.focus(), 30);
  }

  // ---------- wallet (Phantom) ----------
  const phantom = () => (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) ? window.phantom.solana : (window.solana && window.solana.isPhantom ? window.solana : null);
  const b64 = u8 => { let s = ''; u8.forEach(b => s += String.fromCharCode(b)); return btoa(s); };
  async function linkWallet() {
    const p = phantom();
    if (!p) { toast('Phantom not found. Open this page in the Phantom app browser.', true); return; }
    try {
      const c = await p.connect();
      const pub = c.publicKey.toString();
      const { message } = await api('/wallet/nonce', { method: 'POST' });
      const signed = await p.signMessage(new TextEncoder().encode(message), 'utf8');
      const r = await api('/wallet/link', { method: 'POST', body: { publicKey: pub, signature: b64(signed.signature) } });
      S.me = r.me;
      toast(r.rpcError ? 'Wallet linked. Balance check pending, try “Re-check”.' : (r.me.holder ? 'Wallet linked — $209madness holder ✔' : 'Wallet linked, but no $209madness found.'), r.me.holder ? false : true);
      await refreshState(); route();
    } catch (e) { toast(e.message || 'Wallet link cancelled', true); }
  }
  async function recheck() {
    try { const r = await api('/wallet/check', { method: 'POST' }); S.me = r.me; toast(r.me.holder ? 'Holder verified ✔' : 'No $209madness found in that wallet.', !r.me.holder); await refreshState(); route(); } catch (e) { toast(e.message, true); }
  }
  function walletBox() {
    const m = S.me; const cfg = S.st.config;
    const box = h('div', { class: 'walletbox', id: 'walletBox' });
    if (!m.wallet) {
      const deep = 'https://phantom.app/ul/browse/' + encodeURIComponent(location.href) + '?ref=' + encodeURIComponent(location.origin);
      box.append(h('div', { text: 'Link your Phantom wallet to prove you hold $209madness. You sign a free message — no transaction, no fees.' }),
        h('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' }, h('button', { class: 'btn green small', id: 'linkWalletBtn', onclick: linkWallet }, '👻 Connect Phantom'), !phantom() ? h('a', { class: 'btn ghost small', href: deep, id: 'openInPhantom' }, 'Open in Phantom app') : null));
    } else {
      box.append(h('div', { class: 'tiny', text: 'LINKED WALLET' }), h('code', { text: m.wallet }),
        h('div', { style: 'margin-top:8px' }, m.holder ? h('span', { class: 'pill live', text: '✔ $209madness holder' }) : h('span', { class: 'pill', style: 'color:#ff7a90', text: 'No $209madness detected' }), ' ', h('button', { class: 'btn ghost small', id: 'recheckBtn', onclick: recheck }, 'Re-check balance')));
    }
    return box;
  }

  // recovery key box (profile)
  function keyBox() {
    const box = h('div', { class: 'walletbox', id: 'keyBox' });
    const have = store.get();
    const show = k => { clear(box).append(h('div', { class: 'tiny', text: 'RECOVERY KEY — KEEP IT SECRET' }), h('code', { id: 'keyVal', text: k }),
      h('div', { class: 'tiny', style: 'margin-top:6px', text: 'Anyone with this key can play as you. Save it somewhere safe — it lets you restore this nickname on another device.' }),
      h('button', { class: 'btn ghost small', style: 'margin-top:8px', id: 'copyKey', onclick: async () => { try { await navigator.clipboard.writeText(k); toast('Recovery key copied'); } catch { toast('Copy failed — select and copy it manually.', true); } } }, 'Copy')); };
    const gen = () => h('button', { class: 'btn ghost small', id: 'genKey', onclick: async () => {
      if (!confirm('Create a new recovery key? Any older key stops working.')) return;
      try { const r = await api('/nick/key', { method: 'POST' }); store.set(r.token); show(r.token); } catch (e) { toast(e.message, true); } } }, have ? 'Make a new key' : 'Show my recovery key');
    box.append(h('div', { class: 'tiny', text: 'RECOVERY KEY' }), h('div', { text: 'Your nickname is protected by a secret key stored in this browser. Reveal it to save a copy.' }),
      h('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' }, have ? h('button', { class: 'btn ghost small', id: 'revealKey', onclick: () => show(have) }, 'Show my recovery key') : null, gen(),
        h('button', { class: 'btn ghost small', id: 'logoutAll', onclick: async () => {
          if (!confirm('Sign out of every device and browser? You can sign back in here with your recovery key. (Make a new key too if you think someone else has it.)')) return;
          try { await api('/logout-all', { method: 'POST' }); S.me = null; csrf = null; await refreshState(); toast('Signed out everywhere'); route(); } catch (e) { toast(e.message, true); } } }, 'Sign out everywhere')));
    return box;
  }

  // ---------- guess panel ----------
  function renderGuess() {
    const el = clear($('#guessPanel')); const st = S.st; if (!st) return;
    const r = st.round, cfg = st.config;
    if (r.phase !== 'open') {
      if (st.myGuess) el.append(h('div', { class: 'label', text: 'YOUR GUESS' }), h('div', { class: 'lockedin', text: money(st.myGuess.guess) }));
      const t = r.phase === 'settled' ? 'Round settled. Next round opens ' + fmtDT(r.nextOpenAt) + '.' : r.phase === 'locked' ? '🔒 Guesses are locked. Final SOL price is taken ' + fmtDT(r.settleAt) + '.' : '⏳ Settling the round…';
      el.append(h('div', { class: 'msg', id: 'lockedMsg', text: t })); return;
    }
    if (st.myGuess) {
      el.append(h('div', { class: 'label', text: 'LOCKED IN — NO CHANGES' }), h('div', { class: 'lockedin', id: 'myGuessBig', text: money(st.myGuess.guess) }), h('div', { class: 'msg', text: 'Good luck, ' + S.me.name + ' ' + S.me.emoji + '. Watch the board 👇' })); return;
    }
    if (!S.me) {
      const em = cfg.authNickname === false && cfg.authEmail;
      el.append(h('div', { class: 'msg', text: em ? 'Create a free account, pick your emoji, and place your bet on where SOL lands.' : 'Free to play — just pick a nickname and an emoji, then place your bet on where SOL lands.' }), h('button', { class: 'btn big', id: 'ctaGuess', onclick: () => openAuth(em ? 'signup' : 'nick') }, 'Place Your Guess')); return;
    }
    if (cfg.requireHolding && cfg.authWallet && !S.me.holder) {
      el.append(h('div', { class: 'msg', text: S.me.wallet ? 'Your linked wallet has no $209madness. Hold the token to play.' : 'Hold $209madness to play. Link your Phantom wallet first.' }), walletBox(), h('button', { class: 'btn big', id: 'ctaGuess', disabled: true, style: 'margin-top:12px' }, 'Place Your Guess')); return;
    }
    const input = h('input', { type: 'text', inputmode: 'decimal', id: 'guessInput', placeholder: '0.00', maxlength: '8', autocomplete: 'off', 'aria-label': 'Your SOL price guess in USD' });
    const err = h('div', { class: 'err', id: 'guessErr', role: 'alert' });
    const btn = h('button', { class: 'btn big', id: 'placeGuess' }, 'Place Your Guess');
    let armedFor = null;
    input.addEventListener('input', () => { armedFor = null; btn.className = 'btn big'; btn.textContent = 'Place Your Guess'; err.textContent = ''; });
    btn.addEventListener('click', async () => {
      err.textContent = '';
      const v = input.value.trim().replace(/^\$/, '');
      if (!/^\d{1,5}(\.\d{1,2})?$/.test(v) || +v < 1 || +v > 10000) { err.textContent = 'Enter a price between $1 and $10,000.'; return; }
      if (armedFor !== v) { armedFor = v; btn.className = 'btn big armed'; btn.textContent = 'CONFIRM ' + money(+v) + ' — NO CHANGES'; return; }
      btn.disabled = true;
      try { await api('/guess', { method: 'POST', body: { price: v } }); toast('🎰 Bet placed: ' + money(+v)); await refreshState(); await refreshLB(); }
      catch (e) { err.textContent = e.message; armedFor = null; btn.className = 'btn big'; btn.textContent = 'Place Your Guess'; btn.disabled = false; if (e.data && e.data.code === 'locked') refreshState(); }
    });
    el.append(h('div', { class: 'label', text: 'WHERE DOES SOL LAND ' + fmtDT(r.settleAt).toUpperCase() + '?' }),
      h('div', { class: 'guessrow', style: 'margin:12px 0' }, h('div', { class: 'money' }, h('span', { text: '$' }), input), btn), err,
      h('div', { class: 'tiny', text: 'One guess per week. Once placed, it can’t be changed.' }),
      cfg.requireHolding ? null : h('div', { class: 'tiny', id: 'claimNote', text: 'Prize: to claim the ' + cfg.prize + ', the winner must show $209madness holdings and provide a Solana wallet address.' }));
  }

  // ---------- price + countdown ----------
  const spark = $('#spark');
  function drawSpark() {
    const c = spark, ctx = c.getContext('2d'); const W = c.width = c.clientWidth * (devicePixelRatio || 1), Hh = c.height = c.clientHeight * (devicePixelRatio || 1);
    ctx.clearRect(0, 0, W, Hh); const pts = S.hist; if (pts.length < 2) return;
    const vs = pts.map(p => p[1]); let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 0.02) { hi += 0.01; lo -= 0.01; }
    const x = i => i / (pts.length - 1) * W, y = v => Hh - 6 - (v - lo) / (hi - lo) * (Hh - 12);
    const g = ctx.createLinearGradient(0, 0, 0, Hh); g.addColorStop(0, 'rgba(24,255,122,.35)'); g.addColorStop(1, 'rgba(24,255,122,0)');
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))); ctx.strokeStyle = '#18ff7a'; ctx.lineWidth = 2.5 * (devicePixelRatio || 1); ctx.shadowColor = '#18ff7a'; ctx.shadowBlur = 10; ctx.stroke();
    ctx.shadowBlur = 0; ctx.lineTo(W, Hh); ctx.lineTo(0, Hh); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
  }
  function setPrice(usd, at) {
    if (!usd) return;
    const el = $('#livePrice'), prev = S.price; S.price = usd;
    el.textContent = money(usd); el.id = 'livePrice';
    if (prev && usd !== prev) { el.classList.remove('up', 'down'); void el.offsetWidth; el.classList.add(usd > prev ? 'up' : 'down'); }
    if (at && (!S.hist.length || S.hist[S.hist.length - 1][0] !== at)) { S.hist.push([at, usd]); if (S.hist.length > 120) S.hist.shift(); }
    drawSpark();
    $('#priceSrc').textContent = 'Updated ' + new Date(at || Date.now()).toLocaleTimeString('en-US', { timeZone: TZ }) + ' PT · public market data';
  }
  function tickCountdown() {
    const st = S.st; if (!st) return; const r = st.round;
    let target = 0, label = '', sub = '';
    if (r.phase === 'open') { target = r.lockAt; label = 'GUESSES LOCK IN'; sub = 'Locks ' + fmtDT(r.lockAt) + ' · Final price ' + fmtDT(r.settleAt); }
    else if (r.phase === 'locked') { target = r.settleAt; label = '🔒 LOCKED · FINAL PRICE IN'; sub = 'Final SOL price taken ' + fmtDT(r.settleAt); }
    else if (r.phase === 'settled') { target = r.nextOpenAt; label = 'NEXT ROUND OPENS IN'; sub = fmtDT(r.nextOpenAt); }
    else { label = 'SETTLING…'; sub = 'Crowning the winner'; }
    $('#countLabel').textContent = label; $('#countSub').textContent = sub;
    let d = Math.max(0, Math.floor((target - nowMs()) / 1000));
    const p = n => String(n).padStart(2, '0');
    $('#cd-d').textContent = p(Math.floor(d / 86400)); $('#cd-h').textContent = p(Math.floor(d % 86400 / 3600)); $('#cd-m').textContent = p(Math.floor(d % 3600 / 60)); $('#cd-s').textContent = p(d % 60);
    if (target && nowMs() > target + 1500 && !tickCountdown.busy) { tickCountdown.busy = true; setTimeout(async () => { await refreshState(); await refreshLB(); tickCountdown.busy = false; }, 2500); }
  }
  setInterval(tickCountdown, 1000);

  // ---------- leaderboard ----------
  function renderLB() {
    const lb = S.lb, st = S.st; if (!lb || !st) return;
    const list = clear($('#lbList')); const settled = lb.round.phase === 'settled';
    $('#lbCount').textContent = lb.entries.length; $('#lbEmpty').hidden = lb.entries.length > 0;
    $('#sortbar').hidden = settled;
    let rows = lb.entries.slice();
    if (!settled) { rows.sort(S.sort === 'price' ? (a, b) => a.guess - b.guess || a.at - b.at : (a, b) => a.at - b.at); rows.forEach((r, i) => r.pos = i + 1); }
    $('#lbNote').textContent = settled ? 'Final SOL price ' + money(lb.round.finalPrice) + ' · ranked by closest guess' : lb.round.phase === 'open' ? 'Live board — new guesses pop in instantly. Re-ranks by closest to the final price when the round settles.' : 'Guesses are locked. Final ranking after the final price is taken.';
    for (const r of rows) {
      const key = r.name + '|' + r.at; const fresh = S.known.size && !S.known.has(key); S.known.add(key);
      const top = settled && r.rank === 1;
      list.append(h('li', { class: 'row' + (top ? ' top1' : '') + (S.me && S.me.name === r.name ? ' me' : '') + (fresh ? ' fresh' : ''), 'data-name': r.name },
        h('span', { class: 'pos', text: settled ? '#' + r.rank : r.pos }), h('span', { class: 'emo', text: r.emoji }),
        h('span', { class: 'nm' }, r.name, top ? h('span', { class: 'badge', text: 'WINNER' }) : null),
        h('span', { class: 'gs' }, money(r.guess), settled ? h('small', { text: r.diff === 0 ? 'EXACT!' : '± ' + money(r.diff) + ' away' }) : null)));
    }
  }
  function winnerCard(w, finalPrice, roundId, heading) {
    return h('div', { class: 'card winnercard', id: 'winnerCard' }, heading ? h('div', { class: 'label', style: 'justify-content:center', text: heading }) : null, h('div', { class: 'crown', text: '👑' }), h('div', { class: 'wemo', text: w.emoji }), h('div', { class: 'winner-name', text: w.name }),
      h('div', { class: 'wbadge', text: '$25 SOL WINNER' }),
      h('div', { class: 'wdetail' }, 'Guessed ', h('b', { text: money(w.guess) }), ' · final price ', h('b', { text: money(finalPrice) }), ' · off by ', h('b', { text: money(w.diff) })),
      roundId ? h('div', { style: 'margin-top:10px' }, h('a', { href: '#/archive/' + roundId, id: 'lastBoardLink', text: 'See that round’s full leaderboard →' })) : null);
  }
  function renderWinner() {
    const box = clear($('#winnerBox')); const st = S.st; if (!st) return;
    if (st.round.phase === 'settled') {
      if (!st.winner) { box.append(h('div', { class: 'card winnercard' }, h('h2', { text: 'Round settled' }), h('div', { text: 'Final SOL price ' + money(st.round.finalPrice) + ' · no guesses this week. The jackpot is waiting!' }))); return; }
      box.append(winnerCard(st.winner, st.round.finalPrice, null, null)); return;
    }
    const lr = st.lastRound;
    if (lr && lr.winner) box.append(winnerCard(lr.winner, lr.finalPrice, lr.id, 'LAST ROUND’S WINNER'));
  }
  async function refreshLB() { try { S.lb = await api('/leaderboard'); renderLB(); } catch {} }
  async function refreshRecent() {
    try {
      const { rounds } = await api('/rounds'); const el = clear($('#recentList'));
      const rs = rounds.filter(r => r.winner).slice(0, 6);
      if (!rs.length) el.append(h('div', { class: 'empty', text: 'No winners crowned yet. The first one could be you.' }));
      for (const r of rs) el.append(h('div', { class: 'wcard' }, h('span', { class: 'e', text: r.winner.emoji }), h('span', { class: 'n', text: r.winner.name }), h('span', { class: 'd', text: money(r.winner.guess) + ' vs ' + money(r.finalPrice) + ' · ' + fmtD(r.settleAt) })));
    } catch {}
  }

  // ---------- state ----------
  async function refreshState() {
    const st = await api('/state'); S.st = st; S.skew = st.now - Date.now(); S.me = st.me ? Object.assign(S.me || {}, st.me) : null;
    if (S.me && st.me) { S.me.holder = st.me.holder; S.me.wallet = st.me.wallet; }
    $('#roundNo').textContent = st.round.id;
    if (st.price.history && !S.hist.length) S.hist = st.price.history.slice();
    setPrice(st.price.usd, st.price.at);
    $('#ruleLock').textContent = fmtDT(st.round.lockAt); $('#ruleSettle').textContent = fmtDT(st.round.settleAt);
    const c = st.config;
    $('#ruleHold').textContent = c.requireHolding ? 'You must hold $209madness in a linked Phantom wallet to play.' : 'Free to play — just a nickname and an emoji. No sign-up, no wallet needed.';
    $('#ruleClaim').hidden = !!c.requireHolding;
    $('#ruleClaim').textContent = 'To claim the ' + c.prize + ' prize, the winner must show $209madness holdings and provide a Solana wallet address.';
    $('#mintLine').textContent = 'Token: $209madness · mint ' + c.mint + (c.requireHolding ? '' : ' (holdings are checked at prize claim, not at play)');
    renderAuth(); renderGuess(); renderWinner(); tickCountdown();
  }

  // ---------- TradingView ----------
  function loadChart() {
    const host = $('#tv'); const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'; s.async = true;
    s.textContent = JSON.stringify({ autosize: true, symbol: 'COINBASE:SOLUSD', interval: '15', timezone: 'America/Los_Angeles', theme: 'dark', style: '1', locale: 'en', backgroundColor: '#050505', gridColor: 'rgba(255,255,255,0.04)', hide_side_toolbar: true, allow_symbol_change: false, save_image: false, calendar: false, support_host: 'https://www.tradingview.com' });
    host.append(s);
  }

  // ---------- profile / archive views ----------
  async function viewProfile() {
    const v = clear($('#view-profile'));
    if (!S.me) { v.append(h('div', { class: 'card' }, h('h2', { text: 'Your profile' }), h('p', { text: 'Pick a nickname to see your guesses and placements.' }), h('button', { class: 'btn', id: 'profileJoin', onclick: () => openAuth(cfgOf().authNickname === false && cfgOf().authEmail ? 'login' : 'nick') }, cfgOf().authNickname === false ? 'Log in' : 'Pick a nickname'))); return; }
    let me; try { me = (await api('/me')).me; } catch { return; }
    Object.assign(S.me, { wallet: me.wallet, holder: me.holder });
    const st = S.st; const cfg = st.config;
    const tbl = h('table', { class: 'hist', id: 'histTable' }, h('thead', {}, h('tr', {}, ['Round', 'Your guess', 'Final', 'Off by', 'Placed'].map(t => h('th', { text: t })))),
      h('tbody', {}, me.history.length ? me.history.map(x => h('tr', {}, h('td', { text: '#' + x.roundId }), h('td', { text: money(x.guess) }), h('td', { text: x.finalPrice ? money(x.finalPrice) : '—' }), h('td', { text: x.diff !== null ? money(x.diff) : '—' }),
        h('td', { text: x.settled ? (x.rank === 1 ? '🏆 1st' : '#' + x.rank + ' of ' + x.players) : 'Pending' }))) : [h('tr', {}, h('td', { colspan: '5', text: 'No guesses yet. Go place one!' }))]));
    v.append(h('div', { class: 'card' }, h('div', { class: 'prof-head' }, h('div', { class: 'pe', id: 'profEmoji', text: me.emoji }), h('div', {}, h('h1', { id: 'profName', text: me.name }), h('div', { class: 'tiny', text: me.kind === 'nick' ? 'Nickname player · emoji marker is permanent' : 'Emoji marker is permanent' }))),
      h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('b', { id: 'statGuesses', text: me.totalGuesses }), h('i', { text: 'Total guesses' })), h('div', { class: 'stat' }, h('b', { text: me.wins }), h('i', { text: 'Wins' })), h('div', { class: 'stat' }, h('b', { text: me.bestRank ? '#' + me.bestRank : '—' }), h('i', { text: 'Best placement' }))),
      cfg.authWallet ? walletBox() : null, keyBox()),
      h('div', { class: 'card' }, h('h2', { text: 'Placement history' }), tbl));
  }
  async function viewArchive(id) {
    const v = clear($('#view-archive'));
    if (id) {
      try {
        const d = await api('/leaderboard?round=' + id); const r = d.round;
        v.append(h('a', { href: '#/archive', text: '← All rounds' }), h('div', { class: 'card' }, h('h2', { text: 'Round #' + r.id + ' · ' + fmtD(r.settleAt) }), r.finalPrice ? h('div', { text: 'Final SOL price ' + money(r.finalPrice) + (r.settledLate ? ' (settled from historical price data)' : '') }) : h('div', { text: 'Not settled yet' }),
          d.winner ? h('div', { class: 'winnercard card' }, h('div', { class: 'wemo', text: d.winner.emoji }), h('div', { class: 'winner-name', text: d.winner.name }), h('div', { class: 'wbadge', text: '$25 SOL WINNER' })) : null,
          h('ol', { class: 'lb', style: 'margin-top:12px' }, d.entries.map(e => h('li', { class: 'row' + (e.rank === 1 ? ' top1' : '') }, h('span', { class: 'pos', text: e.rank ? '#' + e.rank : e.pos }), h('span', { class: 'emo', text: e.emoji }), h('span', { class: 'nm' }, e.name, e.rank === 1 ? h('span', { class: 'badge', text: 'WINNER' }) : null), h('span', { class: 'gs' }, money(e.guess), e.diff !== null ? h('small', { text: '± ' + money(e.diff) }) : null))))));
      } catch { v.append(h('div', { class: 'card', text: 'Round not found.' })); }
      return;
    }
    const { rounds } = await api('/rounds');
    v.append(h('div', { class: 'card' }, h('h2', { text: '🗄️ Archive' }), h('div', { class: 'archive-list', id: 'archiveList' }, rounds.length ? rounds.map(r => h('a', { class: 'arow', href: '#/archive/' + r.id },
      h('div', {}, h('b', { text: 'Round #' + r.id + ' · ' + fmtD(r.settleAt) }), h('div', { class: 'tiny', text: r.players + ' players · final ' + money(r.finalPrice) })),
      h('div', { class: 'big', text: r.winner ? r.winner.emoji + ' ' + r.winner.name : 'No winner' }))) : [h('div', { class: 'empty', text: 'Past weeks will show up here after the first round settles.' })])));
  }

  // ---------- router ----------
  async function route() {
    const hash = location.hash || '#/'; const parts = hash.replace(/^#\//, '').split('/');
    const name = parts[0] === 'profile' ? 'profile' : parts[0] === 'archive' ? 'archive' : 'home';
    for (const n of ['home', 'profile', 'archive']) $('#view-' + n).hidden = n !== name;
    document.querySelectorAll('.nav a[data-route]').forEach(a => a.classList.toggle('on', a.dataset.route === name));
    if (name === 'profile') await viewProfile();
    else if (name === 'archive') await viewArchive(/^\d+$/.test(parts[1] || '') ? parts[1] : null);
    else { renderGuess(); renderLB(); drawSpark(); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  $('#sortbar').addEventListener('click', e => { const b = e.target.closest('button[data-sort]'); if (!b) return; S.sort = b.dataset.sort; document.querySelectorAll('#sortbar button').forEach(x => x.classList.toggle('on', x === b)); renderLB(); });

  // ---------- live events ----------
  let es, poll;
  function connect() {
    try { es = new EventSource('/api/events'); } catch { return; }
    es.addEventListener('guess', async () => { await refreshLB(); const st = await api('/state'); S.st.count = st.count; });
    es.addEventListener('price', e => { try { const d = JSON.parse(e.data); setPrice(d.usd, d.at); } catch {} });
    es.addEventListener('settled', async () => { await refreshState(); await refreshLB(); refreshRecent(); });
  }
  (async () => {
    try { await refreshState(); } catch (e) { toast('Could not load. Retrying…', true); }
    // cookie lost but the browser still holds the player's secret key: quietly resume the same nickname
    if (!S.me && store.get() && cfgOf().authNickname !== false) {
      try { const r = await api('/nick/resume', { method: 'POST', body: { token: store.get() } }); S.me = r.me; csrf = null; await refreshState(); }
      catch (e) { if (e.status === 404 || e.status === 400) store.del(); }
    }
    await Promise.all([refreshLB(), refreshRecent()]);
    renderAuth(); route(); loadChart(); connect();
    poll = setInterval(async () => { if (!es || es.readyState !== 1) { await refreshState().catch(() => {}); await refreshLB(); } }, 15000);
    setInterval(() => { if (S.me === null || !document.hidden) refreshLB(); }, 45000);
  })();
})();
