/* ---------------- Doodle Arcade: live drawing & guessing with whoever is on the floor ----------------
   Standalone site only. Realtime runs over Supabase Realtime (broadcast + presence); the page gets the
   project URL and public anon key from /api/game-config. On localhost it falls back to BroadcastChannel,
   so the game can be tried across browser tabs without any setup.
   Roles: the HOST (earliest player still here) runs the clock, turns and scores. The DRAWER is the only
   client that ever knows the word: it picks it, judges guesses and reveals it at the end of the turn. */
const DOODLE = (() => {
  const GW = 160, GH = 120;                       // the board is a 160 × 120 pixel grid
  const CHOOSE_MS = 15000, DRAW_MS = 80000, REVEAL_MS = 6500, OVER_MS = 14000;
  const PALETTE = ["#2a2230", "#ffffff", "#8d93b0", "#ef6b6b", "#f29a3b", "#ffcf4a", "#6bd18a", "#2f7d4f", "#5fb4e8", "#3056d3", "#b69cf0", "#f29cb6", "#8a5a3b", "#e7b98f"];
  const WORDS = ["logo", "kerning", "moodboard", "deadline", "chai", "elephant", "laptop", "coffee", "pizza", "beach", "sunset", "rocket", "lighthouse", "trophy", "camera", "headphones", "pencil", "paintbrush", "typewriter", "lightbulb", "umbrella", "bicycle", "auto rickshaw", "mango", "dosa", "biryani", "coconut tree", "temple", "kite", "cricket bat", "rangoli", "idli", "samosa", "banana leaf", "sticky note", "wireframe", "calendar", "wifi", "hashtag", "arcade", "beanbag", "frisbee", "hammock", "sandcastle", "surfboard", "anchor", "whale", "octopus", "crab", "palm tree", "volcano", "rainbow", "cloud", "snowman", "cactus", "giraffe", "penguin", "owl", "cat", "dog", "fish", "butterfly", "spider", "snail", "dragon", "unicorn", "robot", "alien", "ghost", "pirate", "crown", "castle", "bridge", "train", "airplane", "submarine", "helicopter", "hot air balloon", "tent", "campfire", "mountain", "river", "island", "moon", "planet", "star", "comet", "clock", "key", "lock", "glasses", "backpack", "sneaker", "hat", "tshirt", "scissors", "ruler", "paperclip", "stapler", "printer", "mouse", "keyboard", "phone", "microphone", "guitar", "drum", "piano", "balloon", "cake", "cupcake", "ice cream", "donut", "burger", "popcorn", "watermelon", "pineapple", "carrot", "broccoli", "egg", "cookie", "magnet", "compass", "map", "treasure", "zoom call", "pixel", "brand", "megaphone", "podium", "handshake", "ladder", "door", "window", "chair", "sofa", "bed", "bathtub", "toothbrush", "mirror", "candle", "plant", "flower", "sunflower", "mushroom", "leaf", "tree", "snake", "turtle", "frog", "rabbit", "monkey", "lion", "tiger", "cow", "duck", "bee"];
  const CID = Math.random().toString(36).slice(2, 10);
  const ME_KEY = "become-doodle-me";
  let me = null; try { me = localStorage.getItem(ME_KEY) || null; } catch (_) {}
  if (me && !byId[me]) me = null;

  const el = id => document.getElementById(id);
  const box = el("doodle"), cvs = el("dCv"), g = cvs.getContext("2d"), overlay = el("dOverlay"), logEl = el("dLog"), input = el("dInput");
  const playing = new Set(); window.__doodlePlaying = playing;

  let lastErr = "", diag = null;
  let rt = null, connecting = null, joined = false, joinedAt = 0, members = [], lastBeat = 0, status = "idle";
  let S = {v: 0, phase: "lobby", round: 0, rounds: 3, order: [], drawn: [], drawer: null, mask: "", scores: {}, guessed: [], endsIn: 0, host: null, turnKey: "", lastWord: "", note: ""};
  let sAt = performance.now();
  let myTurn = "", myWord = "", myChoices = [], hints = 0, autoPick = 0;
  let ops = [], pendingOps = {}, words = {};
  let tool = {c: 0, w: 2, mode: "pen"}, drawing = null, outBuf = [], nextId = 0;

  /* ---------- transport ---------- */
  function loadScript(src){ return new Promise((ok, bad) => { if (window.supabase) return ok(); const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.append(s); }); }
  let rtClient = null, rtChannel = null;
  async function runCheck(){ try { diag = await api("/api/game-config?check=1"); } catch (e){ diag = {error: e.code, message: e.message}; } render(); }
  function reconnect(){ try { if (rtChannel) rtChannel.unsubscribe(); if (rtClient) rtClient.removeAllChannels(); } catch (_) {} rt = null; connecting = null; diag = null; lastErr = ""; members = []; joined = false; connect().then(() => { if (me && rt) join(); }); render(); }
  function supaTransport(cfg){
    const client = window.supabase.createClient(cfg.url, cfg.key, {auth: {persistSession: false, autoRefreshToken: false}, realtime: {params: {eventsPerSecond: 25}}});
    const ch = client.channel(cfg.channel || "studio-doodle", {config: {broadcast: {self: false, ack: false}, presence: {key: CID}}});
    const h = {ev: [], pr: []};
    ch.on("broadcast", {event: "m"}, ({payload}) => h.ev.forEach(f => f(payload)));
    ch.on("presence", {event: "sync"}, () => { const st = ch.presenceState(), list = []; for (const k in st){ const m = st[k][st[k].length - 1]; if (m && m.pid) list.push(m); } h.pr.forEach(f => f(list)); });
    const ready = new Promise(res => ch.subscribe((s, err) => {
      if (s === "SUBSCRIBED"){ lastErr = ""; if (status === "error"){ status = "on"; render(); } res(); }
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED"){
        lastErr = s + (err && err.message ? ": " + err.message : "");
        console.warn("[doodle] realtime", lastErr, err || "");
        if (status !== "on" || s !== "CLOSED"){ status = "error"; render(); runCheck(); }
      }
    }));
    rtClient = client; rtChannel = ch;
    return {ready, send: m => ch.send({type: "broadcast", event: "m", payload: m}), track: meta => ready.then(() => ch.track(meta)), untrack: () => ready.then(() => ch.untrack()), onEvent: f => h.ev.push(f), onPresence: f => h.pr.push(f)};
  }
  function localTransport(){          // localhost only: tabs of one browser talk over BroadcastChannel
    const bc = new BroadcastChannel("studio-doodle-local"), h = {ev: [], pr: []}, seen = {}; let mine = null;
    const emitPresence = () => { const now = Date.now(), list = Object.values(seen).filter(x => now - x.at < 5000).map(x => x.meta); if (mine) list.push(mine); h.pr.forEach(f => f(list)); };
    bc.onmessage = e => { const m = e.data; if (m.kind === "hi"){ seen[m.cid] = {meta: m.meta, at: Date.now()}; emitPresence(); } else if (m.kind === "bye"){ delete seen[m.cid]; emitPresence(); } else h.ev.forEach(f => f(m.msg)); };
    setInterval(() => { if (mine) bc.postMessage({kind: "hi", cid: CID, meta: mine}); emitPresence(); }, 1500);
    addEventListener("pagehide", () => bc.postMessage({kind: "bye", cid: CID}));
    return {ready: Promise.resolve(), send: msg => bc.postMessage({kind: "m", msg}), track: meta => { mine = meta; bc.postMessage({kind: "hi", cid: CID, meta}); emitPresence(); return Promise.resolve(); }, untrack: () => { mine = null; bc.postMessage({kind: "bye", cid: CID}); emitPresence(); return Promise.resolve(); }, onEvent: f => h.ev.push(f), onPresence: f => h.pr.push(f)};
  }
  function connect(){
    if (connecting) return connecting;
    status = "connecting";
    connecting = (async () => {
      let cfg = null;
      try { cfg = await api("/api/game-config"); } catch (e){ diag = {error: e.code, message: e.message}; }
      try {
        if (cfg && cfg.url && cfg.key){ await loadScript("/vendor/supabase.js"); rt = supaTransport(cfg); }
        else if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && "BroadcastChannel" in window) rt = localTransport();
      } catch (_) { rt = null; }
      if (!rt){ status = "off"; render(); return null; }
      rt.onEvent(onMessage); rt.onPresence(onPresence);
      await rt.ready; if (status !== "error" || !lastErr) status = "on"; render();
      return rt;
    })();
    return connecting;
  }
  const emit = (t, d) => { const m = {t, d, from: CID}; if (rt) rt.send(m); onMessage(m); };

  /* ---------- presence, host ---------- */
  function onPresence(list){
    const byPid = {};
    for (const m of list){ if (!byId[m.pid]) continue; const o = byPid[m.pid]; if (!o || m.joined < o.joined) byPid[m.pid] = m; }
    members = Object.values(byPid).sort((a, b) => a.joined - b.joined || (a.cid < b.cid ? -1 : 1));
    const before = [...playing].join(); playing.clear(); members.forEach(m => playing.add(m.pid));
    if ([...playing].join() !== before){ assignSeats(false); }
    if (S.drawer === me && S.phase === "drawing") clearTimeout(onPresence.t), onPresence.t = setTimeout(() => emit("canvas", {turnKey: S.turnKey, ops}), 700);
    render();
  }
  const hostCid = () => members.length ? members[0].cid : null;
  const isHost = () => joined && hostCid() === CID;
  const present = () => members.map(m => m.pid);
  const remaining = () => Math.max(0, S.endsIn - (performance.now() - sAt));
  function setState(patch, dur){
    S = Object.assign({}, S, patch, {v: S.v + 1, host: CID});
    if (dur !== undefined){ S.endsIn = dur; sAt = performance.now(); } else { S.endsIn = remaining(); sAt = performance.now(); }
    pushState(); applyState();
  }
  function pushState(){ lastBeat = performance.now(); if (rt) rt.send({t: "state", d: Object.assign({}, S, {endsIn: remaining()}), from: CID}); }
  function hostTick(){
    if (!isHost()) return;
    const pids = present(), left = remaining();
    if (S.phase !== "lobby" && S.phase !== "over" && pids.length < 2) return toLobby("Not enough players, so the game went back to the lobby.");
    if (S.phase === "choosing" && (!pids.includes(S.drawer) || left <= 0)) return nextTurn();
    if (S.phase === "drawing"){
      const guessers = pids.filter(p => p !== S.drawer);
      if (!pids.includes(S.drawer) || left <= 0 || (guessers.length && guessers.every(p => S.guessed.includes(p)))) return setState({phase: "reveal", lastWord: words[S.turnKey] || ""}, REVEAL_MS);
    }
    if (S.phase === "reveal" && left <= 0) return nextTurn();
    if (S.phase === "over" && left <= 0) return toLobby("");
    if (performance.now() - lastBeat > 2000) pushState();
  }
  function toLobby(note){ setState({phase: "lobby", drawer: null, mask: "", guessed: [], turnKey: "", note}, 0); }
  function startGame(rounds){
    const order = present(), scores = {}; order.forEach(p => scores[p] = 0);
    S = Object.assign({}, S, {order, scores, round: 1, rounds, drawn: []});
    nextTurn(true);
  }
  function nextTurn(first){
    const pids = present();
    let order = S.order.filter(p => pids.includes(p)); pids.forEach(p => { if (!order.includes(p)) order.push(p); });
    const scores = Object.assign({}, S.scores); order.forEach(p => { if (scores[p] === undefined) scores[p] = 0; });
    let round = S.round, drawn = first ? [] : S.drawn.slice();
    let next = order.find(p => !drawn.includes(p));
    if (!next){ round++; drawn = []; next = order[0]; }
    if (round > S.rounds || order.length < 2) return setState({phase: "over", order, scores, drawer: null, turnKey: "", mask: ""}, OVER_MS);
    drawn.push(next);
    setState({phase: "choosing", order, scores, round, drawn, drawer: next, mask: "", guessed: [], lastWord: "", note: "", turnKey: next + ":" + Date.now().toString(36)}, CHOOSE_MS);
  }

  /* ---------- messages ---------- */
  function onMessage(m){
    const {t, d} = m;
    if (t === "state"){
      const fromHost = m.from === hostCid();
      if (d.v > S.v || (fromHost && d.v !== S.v)){ S = d; sAt = performance.now(); applyState(); }
      return;
    }
    if (t === "start" && isHost() && (S.phase === "lobby" || S.phase === "over") && present().length >= 2) return startGame(d.rounds || 3);
    if (t === "chosen" && isHost() && S.phase === "choosing" && d.turnKey === S.turnKey) return setState({phase: "drawing", mask: d.mask}, DRAW_MS);
    if (t === "mask" && isHost() && S.phase === "drawing" && d.turnKey === S.turnKey) return setState({mask: d.mask});
    if (t === "correct" && isHost() && S.phase === "drawing" && d.turnKey === S.turnKey && !S.guessed.includes(d.pid)){
      const scores = Object.assign({}, S.scores), left = remaining();
      scores[d.pid] = (scores[d.pid] || 0) + 30 + Math.round(70 * left / DRAW_MS) + (S.guessed.length === 0 ? 20 : 0);
      scores[S.drawer] = (scores[S.drawer] || 0) + 15;
      return setState({scores, guessed: S.guessed.concat(d.pid)});
    }
    if (t === "word"){ words[d.turnKey] = d.word; if (isHost() && d.turnKey === S.turnKey && S.phase === "reveal") setState({lastWord: d.word}); render(); return; }
    if (t === "guess" && S.drawer === me && d.turnKey === S.turnKey && S.phase === "drawing") return judge(d);
    if (t === "chat") return addChat(d);
    if (t === "ops"){ if (d.turnKey === S.turnKey){ if (S.drawer !== me) applyOps(d.ops); } else (pendingOps[d.turnKey] = pendingOps[d.turnKey] || []).push(...d.ops); return; }
    if (t === "canvas" && d.turnKey === S.turnKey && S.drawer !== me){ ops = []; redrawAll(); applyOps(d.ops); return; }
  }
  const norm = s => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  function lev(a, b){ const d = Array.from({length: a.length + 1}, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return d[a.length][b.length]; }
  function judge(d){                     // runs on the drawer's screen only
    const g = norm(d.text), w = norm(myWord);
    if (!g) return;
    if (S.guessed.includes(d.pid)) return emit("chat", {pid: d.pid, text: d.text, kind: "inner"});
    if (g === w || g.replace(/ /g, "") === w.replace(/ /g, "")){ emit("correct", {pid: d.pid, turnKey: S.turnKey}); return emit("chat", {pid: d.pid, text: "guessed the word!", kind: "ok"}); }
    emit("chat", {pid: d.pid, text: d.text, kind: "guess"});
    if (w.length >= 4 && lev(g, w) === 1) emit("chat", {pid: d.pid, text: `“${d.text}” is so close!`, kind: "close", to: d.pid});
  }

  /* ---------- state → screen ---------- */
  let lastTurnSeen = "", lastPhase = "";
  function applyState(){
    if (S.turnKey !== lastTurnSeen){
      lastTurnSeen = S.turnKey; ops = []; redrawAll();
      if (pendingOps[S.turnKey]){ applyOps(pendingOps[S.turnKey]); } pendingOps = {};
      if (S.turnKey && S.drawer === me){ myTurn = S.turnKey; myWord = ""; hints = 0; myChoices = pickWords(3); clearTimeout(autoPick); autoPick = setTimeout(() => { if (!myWord && S.phase === "choosing" && S.turnKey === myTurn) choose(myChoices[0]); }, CHOOSE_MS - 2500); }
      if (S.turnKey && joined) Sound.jingle();
    }
    if (S.phase !== lastPhase){
      lastPhase = S.phase;          // set first: emitting below can re-enter applyState on the host
      if (S.phase === "choosing" && S.drawer) sys(`${nameOf(S.drawer)} is drawing now.`);
      if (S.phase === "over") sys("Game over! Final scores are up.");
      if (S.phase === "reveal" && S.drawer === me && myWord) emit("word", {turnKey: S.turnKey, word: myWord});
    }
    render();
  }
  function pickWords(n){ const pool = WORDS.slice(), out = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); return out; }
  const maskOf = (w, shown) => [...w].map((ch, i) => ch === " " ? " " : shown.includes(i) ? ch : "_").join("");
  let shownIdx = [];
  function choose(w){ if (S.drawer !== me || S.phase !== "choosing") return; myWord = w; shownIdx = []; clearTimeout(autoPick); emit("chosen", {turnKey: S.turnKey, mask: maskOf(w, [])}); render(); }
  function drawerTick(){
    if (S.drawer !== me || S.phase !== "drawing" || !myWord) return;
    const left = remaining(), letters = [...myWord].map((c, i) => c === " " ? -1 : i).filter(i => i >= 0 && !shownIdx.includes(i));
    const want = left < DRAW_MS * 0.25 ? 2 : left < DRAW_MS * 0.5 ? 1 : 0;
    if (hints < want && letters.length > 2 && myWord.replace(/ /g, "").length >= 4){ shownIdx.push(letters[Math.floor(Math.random() * letters.length)]); hints++; emit("mask", {turnKey: S.turnKey, mask: maskOf(myWord, shownIdx)}); }
  }
  const nameOf = pid => pid && byId[pid] ? byId[pid].name.split(" ")[0] : "Someone";
  function line(cls, who, text){
    const d = document.createElement("div"); if (cls) d.className = cls;
    if (who){ const b = document.createElement("b"); b.textContent = who + ": "; d.append(b); }
    d.append(document.createTextNode(text)); logEl.append(d);
    while (logEl.childElementCount > 120) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }
  const sys = text => line("sys", "", text);
  function addChat(d){
    if (d.kind === "inner" && !(S.guessed.includes(me) || S.drawer === me || d.pid === me)) return;
    if (d.kind === "close" && d.to !== me) return;
    if (d.kind === "ok"){ line("ok", "", `${nameOf(d.pid)} guessed the word!`); floorBubble(d.pid, "✅ Got it!"); if (d.pid === me) Sound.chime(); return; }
    if (d.kind === "close") return line("close", "", d.text);
    line(d.kind === "inner" ? "inner" : "", nameOf(d.pid), d.text);
    if (d.kind !== "inner") floorBubble(d.pid, d.text.length > 22 ? d.text.slice(0, 21) + "…" : d.text);
  }
  function floorBubble(pid, text){ if (byId[pid]) bubbles.set(pid, {text, until: performance.now() + 4200}); }

  /* ---------- the board ---------- */
  function redrawAll(){ g.fillStyle = "#ffffff"; g.fillRect(0, 0, GW, GH); for (const o of ops) paint(o, 0); }
  function plot(x, y, c, w){ const o = w > 1 ? Math.floor(w / 2) : 0; g.fillStyle = c; g.fillRect(x - o, y - o, w, w); }
  function line2(x0, y0, x1, y1, c, w){ const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy; for (;;){ plot(x0, y0, c, w); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy){ e += dy; x0 += sx; } if (e2 <= dx){ e += dx; y0 += sy; } } }
  function paint(o, from){
    if (o.k === "s"){ const c = PALETTE[o.c] || "#000", p = o.p; if (from === 0 && p.length >= 2) plot(p[0], p[1], c, o.w); for (let i = Math.max(2, from); i + 1 < p.length; i += 2) line2(p[i-2], p[i-1], p[i], p[i+1], c, o.w); }
    else if (o.k === "f") flood(o.x, o.y, PALETTE[o.c] || "#000");
    else if (o.k === "c"){ g.fillStyle = "#ffffff"; g.fillRect(0, 0, GW, GH); }
  }
  function flood(x, y, hex){
    const img = g.getImageData(0, 0, GW, GH), a = img.data, i0 = (y * GW + x) * 4, tr = a[i0], tg = a[i0+1], tb = a[i0+2];
    const n = parseInt(hex.slice(1), 16), r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
    if (tr === r && tg === gg && tb === b) return;
    const st = [x, y];
    while (st.length){ const yy = st.pop(), xx = st.pop(); if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue; const k = (yy * GW + xx) * 4; if (a[k] !== tr || a[k+1] !== tg || a[k+2] !== tb) continue; a[k] = r; a[k+1] = gg; a[k+2] = b; a[k+3] = 255; st.push(xx+1, yy, xx-1, yy, xx, yy+1, xx, yy-1); }
    g.putImageData(img, 0, 0);
  }
  function applyOps(list){
    for (const o of list){
      if (o.k === "s+"){ const s = ops.find(q => q.id === o.id); if (!s) continue; const from = s.p.length; s.p.push(...o.p); paint(s, from); }
      else if (o.k === "u"){ const i = ops.map(q => q.id).lastIndexOf(o.target); if (i >= 0){ ops.splice(i, 1); redrawAll(); } }
      else { if (ops.some(q => q.id === o.id)) continue; const copy = Object.assign({}, o, o.p ? {p: o.p.slice()} : {}); ops.push(copy); paint(copy, 0); }
    }
  }
  const canDraw = () => joined && S.phase === "drawing" && S.drawer === me;
  function gridPt(e){ const r = cvs.getBoundingClientRect(); return [Math.max(0, Math.min(GW - 1, Math.floor((e.clientX - r.left) / r.width * GW))), Math.max(0, Math.min(GH - 1, Math.floor((e.clientY - r.top) / r.height * GH)))]; }
  function local(o){ applyOps([o]); outBuf.push(o.k === "s" ? Object.assign({}, o, {p: o.p.slice()}) : o); }
  cvs.addEventListener("pointerdown", e => {
    if (!canDraw()) return; e.preventDefault(); cvs.setPointerCapture(e.pointerId);
    const [x, y] = gridPt(e), id = CID + "-" + (nextId++);
    if (tool.mode === "fill") return local({k: "f", id, x, y, c: tool.c});
    drawing = {id, last: [x, y]};
    local({k: "s", id, c: tool.mode === "erase" ? 1 : tool.c, w: tool.mode === "erase" ? Math.max(4, tool.w * 2) : tool.w, p: [x, y]});
  });
  cvs.addEventListener("pointermove", e => {
    if (!drawing || !canDraw()) return;
    const [x, y] = gridPt(e); if (x === drawing.last[0] && y === drawing.last[1]) return;
    drawing.last = [x, y];
    const s = ops.find(q => q.id === drawing.id); if (!s) return;
    const from = s.p.length; s.p.push(x, y); paint(s, from);
    const pend = outBuf.find(q => q.id === drawing.id && (q.k === "s" || q.k === "s+"));
    if (pend) pend.p.push(x, y); else outBuf.push({k: "s+", id: drawing.id, p: [x, y]});
  });
  const endStroke = () => { drawing = null; };
  cvs.addEventListener("pointerup", endStroke); cvs.addEventListener("pointercancel", endStroke);
  setInterval(() => { if (outBuf.length && canDraw()){ emit("ops", {turnKey: S.turnKey, ops: outBuf}); } outBuf = []; }, 90);
  function undo(){ if (!canDraw()) return; const last = ops.filter(o => o.k !== "u").pop(); if (last){ const o = {k: "u", id: CID + "-" + (nextId++), target: last.id}; local(o); } }
  function clearBoard(){ if (!canDraw()) return; local({k: "c", id: CID + "-" + (nextId++)}); }

  /* ---------- UI ---------- */
  function renderTools(){
    const t = el("dTools"); t.innerHTML = "";
    if (!canDraw()){ const h = document.createElement("span"); h.className = "hint"; h.textContent = joined ? (S.phase === "drawing" ? "Guess in the chat →" : "") : ""; t.append(h); cvs.classList.add("off"); return; }
    cvs.classList.remove("off");
    PALETTE.forEach((c, i) => { const b = document.createElement("button"); b.className = "sw"; b.style.background = c; b.setAttribute("aria-label", "Colour " + c); b.setAttribute("aria-pressed", String(tool.c === i && tool.mode !== "erase")); b.onclick = () => { tool.c = i; if (tool.mode === "erase") tool.mode = "pen"; renderTools(); }; t.append(b); });
    const sep = () => { const s = document.createElement("span"); s.className = "sep"; t.append(s); };
    sep();
    [[1, "S"], [2, "M"], [4, "L"]].forEach(([w, l]) => { const b = document.createElement("button"); b.textContent = l; b.setAttribute("aria-label", "Brush size " + l); b.setAttribute("aria-pressed", String(tool.w === w)); b.onclick = () => { tool.w = w; renderTools(); }; t.append(b); });
    sep();
    [["pen", "✏️ PEN"], ["fill", "🪣 FILL"], ["erase", "ERASER"]].forEach(([m, l]) => { const b = document.createElement("button"); b.textContent = l; b.setAttribute("aria-pressed", String(tool.mode === m)); b.onclick = () => { tool.mode = m; renderTools(); }; t.append(b); });
    sep();
    const u = document.createElement("button"); u.textContent = "↶ UNDO"; u.onclick = undo; t.append(u);
    const c = document.createElement("button"); c.textContent = "CLEAR"; c.onclick = clearBoard; t.append(c);
  }
  function portrait(pid){ const p = byId[pid]; return PORTRAITS[pid] || (p ? avatar(p) : ""); }
  function renderPlayers(){
    const list = el("dPlayers"); list.innerHTML = "";
    const pids = S.phase === "lobby" ? present() : S.order.filter(p => present().includes(p)).concat(present().filter(p => !S.order.includes(p)));
    const ranked = pids.slice().sort((a, b) => (S.scores[b] || 0) - (S.scores[a] || 0));
    for (const pid of (S.phase === "lobby" ? pids : ranked)){
      const p = byId[pid]; if (!p) continue;
      const row = document.createElement("div"); row.className = "dp" + (pid === me ? " me" : "") + (pid === S.drawer ? " drawer" : "") + (S.guessed.includes(pid) ? " got" : "");
      const im = document.createElement("img"); im.alt = ""; im.src = portrait(pid); im.style.background = p.look.shirt;
      const nm = document.createElement("span"); const b = document.createElement("b"); b.textContent = p.name.split(" ")[0] + (pid === me ? " (you)" : ""); const sm = document.createElement("small");
      sm.textContent = pid === S.drawer && S.phase !== "lobby" ? "✏️ drawing" : S.guessed.includes(pid) ? "✅ got it" : members.find(m => m.pid === pid && m.cid === hostCid()) ? "host" : "";
      nm.append(b, sm);
      const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = S.phase === "lobby" ? "" : String(S.scores[pid] || 0);
      row.append(im, nm, pts); list.append(row);
    }
    if (!pids.length){ const e = document.createElement("small"); e.style.color = "var(--muted)"; e.textContent = "No one's at the arcade yet."; list.append(e); }
  }
  function card(){ const c = document.createElement("div"); c.className = "dcard"; overlay.innerHTML = ""; overlay.append(c); return c; }
  function btn(label, fn, ghost, disabled){ const b = document.createElement("button"); b.textContent = label; if (ghost) b.className = "ghost"; if (disabled) b.disabled = true; b.onclick = fn; return b; }
  function h3(c, t){ const h = document.createElement("h3"); h.textContent = t; c.append(h); }
  function p_(c, t){ const p = document.createElement("p"); p.textContent = t; c.append(p); }
  function renderOverlay(){
    const again = () => { const r = document.createElement("div"); r.className = "row"; r.append(btn("TRY AGAIN", reconnect)); return r; };
    const FIX = {
      missing_realtime: "Add SUPABASE_URL and SUPABASE_ANON_KEY in Netlify → Site configuration → Environment variables, then trigger a new deploy.",
      bad_url: "SUPABASE_URL isn’t the project address. Use the Project URL from Supabase’s Connect button, like https://abcd1234.supabase.co (not the dashboard link), then redeploy.",
      secret_key: "SUPABASE_ANON_KEY holds a secret key. Swap it for the anon or publishable key, redeploy, and rotate the secret key in Supabase.",
      bad_key: "Supabase rejected the key. Copy the anon (legacy) or publishable key again from Project Settings → API Keys, update SUPABASE_ANON_KEY in Netlify and redeploy.",
      unreachable: "The site couldn’t reach Supabase. Check the project isn’t paused (free projects pause after a week idle; open it in Supabase to wake it).",
    };
    if (status === "off"){ const c = card(); h3(c, "The arcade isn't plugged in yet"); p_(c, FIX[diag && diag.error] || FIX.missing_realtime); if (diag && diag.message && diag.error !== "missing_realtime") p_(c, "Details: " + diag.message); c.append(again()); return; }
    if (status === "error"){
      const c = card(); h3(c, "Can’t connect to the game server");
      const code = diag ? (diag.error || (diag.check && diag.check !== "ok" ? diag.check : "")) : "";
      if (!diag) p_(c, "Checking the setup…");
      else if (FIX[code]) p_(c, FIX[code]);
      else if (diag.check === "ok") p_(c, "The URL and key look fine, so the live channel was refused. In Supabase → Realtime → Settings keep “Allow public access to channels” on, then try again. A strict office network or VPN can also block the connection; try another network.");
      else p_(c, "Something between this browser and Supabase is failing. Try again, or open the page on another network.");
      const det = [lastErr, diag && diag.url ? "server: " + diag.url.replace(/^https:\/\//, "") : "", diag && diag.keyKind ? "key: " + diag.keyKind : "", diag && diag.checkBody ? diag.checkBody : ""].filter(Boolean).join(" · ");
      if (det){ const d = document.createElement("p"); d.style.cssText = "font-size:12px;opacity:.7;word-break:break-word"; d.textContent = det; c.append(d); }
      c.append(again()); return;
    }
    if (status !== "on"){ const c = card(); h3(c, "Powering up…"); return; }
    if (!me || !joined){
      const c = card(); h3(c, me ? `Play as ${byId[me].name.split(" ")[0]}?` : "Who’s playing?");
      if (me){ const r = document.createElement("div"); r.className = "row"; r.append(btn("JOIN THE GAME", join), btn("I’M SOMEONE ELSE", () => { me = null; render(); }, true)); c.append(r); return; }
      p_(c, "Pick yourself. Your pixel twin walks over to the arcade so the floor can see you playing.");
      const grid = document.createElement("div"); grid.className = "dwho";
      people.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(p => { const b = document.createElement("button"); const im = document.createElement("img"); im.alt = ""; im.src = portrait(p.id); im.style.background = p.look.shirt; const s = document.createElement("span"); s.textContent = p.name.split(" ")[0]; b.append(im, s); b.onclick = () => { me = p.id; try { localStorage.setItem(ME_KEY, me); } catch (_) {} join(); }; grid.append(b); });
      c.append(grid); return;
    }
    const n = present().length;
    if (S.phase === "lobby"){
      const c = card(); h3(c, "Lobby"); p_(c, S.note || (n < 2 ? "Waiting for one more player. Share the floor link: anyone who taps the arcade can join." : `${n} players ready. Everyone draws once per round; guess fast for more points.`));
      const r = document.createElement("div"); r.className = "row";
      [2, 3].forEach(k => r.append(btn(`START · ${k} ROUNDS`, () => emit("start", {rounds: k}), k === 2, n < 2)));
      c.append(r); return;
    }
    if (S.phase === "choosing"){
      if (S.drawer === me && !myWord){ const c = card(); h3(c, "Your turn to draw. Pick a word:"); const r = document.createElement("div"); r.className = "row"; myChoices.forEach(w => r.append(btn(w.toUpperCase(), () => choose(w)))); c.append(r); return; }
      const c = card(); h3(c, S.drawer === me ? "Get ready…" : `${nameOf(S.drawer)} is picking a word…`); return;
    }
    if (S.phase === "reveal"){
      const c = card(); h3(c, "The word was"); const w = document.createElement("p"); w.style.cssText = "font-family:var(--display);font-size:26px;letter-spacing:.12em;margin:4px 0 10px"; w.textContent = (S.lastWord || words[S.turnKey] || "…").toUpperCase(); c.append(w);
      p_(c, S.guessed.length ? `${S.guessed.map(nameOf).join(", ")} got it.` : "Nobody got it this time!"); return;
    }
    if (S.phase === "over"){
      const c = card(); h3(c, "🏆 Final scores");
      const top = Object.entries(S.scores).filter(([p]) => byId[p]).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const pod = document.createElement("div"); pod.className = "dpod";
      [1, 0, 2].forEach(i => { const e = top[i]; if (!e) return; const d = document.createElement("div"); const im = document.createElement("img"); im.alt = ""; im.src = portrait(e[0]); const nm = document.createElement("span"); nm.textContent = `${nameOf(e[0])} · ${e[1]}`; const bar = document.createElement("i"); bar.style.height = [70, 50, 36][i] + "px"; bar.textContent = ["1", "2", "3"][i]; d.append(im, nm, bar); pod.append(d); });
      c.append(pod); p_(c, "Back to the lobby in a moment."); return;
    }
    overlay.innerHTML = "";
  }
  function renderTop(){
    el("dRound").textContent = S.phase === "lobby" || !S.round ? "" : `ROUND ${Math.min(S.round, S.rounds)}/${S.rounds}`;
    const w = el("dWord"); w.innerHTML = "";
    if (S.phase === "drawing" || S.phase === "choosing"){
      if (S.drawer === me && myWord){ w.textContent = myWord.toUpperCase(); const s = document.createElement("small"); s.textContent = "draw this"; w.append(s); }
      else if (S.mask){ w.textContent = S.mask.replace(/ /g, "  ").toUpperCase(); const s = document.createElement("small"); s.textContent = `${S.mask.replace(/ /g, "").length} letters`; w.append(s); }
    }
    const left = Math.ceil(remaining() / 1000), tm = el("dTimer");
    tm.textContent = (S.phase === "drawing" || S.phase === "choosing") ? `${left}s` : "";
    tm.classList.toggle("low", S.phase === "drawing" && left <= 10);
    input.disabled = !joined || (S.phase === "drawing" && S.drawer === me);
    input.placeholder = !joined ? "Join to chat" : S.phase === "drawing" ? (S.drawer === me ? "You’re drawing!" : S.guessed.includes(me) ? "Chat with the others who got it" : "Type your guess…") : "Say something…";
  }
  function render(){ if (box.hidden) return; renderTop(); renderPlayers(); renderOverlay(); renderTools(); }
  setInterval(() => { hostTick(); drawerTick(); if (!box.hidden) renderTop(); }, 250);

  el("dForm").addEventListener("submit", e => {
    e.preventDefault(); const text = input.value.trim(); if (!text || !joined) return; input.value = "";
    if (S.phase === "drawing"){ if (S.drawer === me) return; emit("guess", {pid: me, text, turnKey: S.turnKey}); }
    else emit("chat", {pid: me, text, kind: "chat"});
  });
  async function join(){
    if (!me || !rt) return render();
    joinedAt = Date.now(); joined = true;
    await rt.track({cid: CID, pid: me, joined: joinedAt});
    sys(`You joined as ${nameOf(me)}.`); render();
  }
  async function leave(){ if (!joined) return; joined = false; if (rt) await rt.untrack(); }
  let lastFocus = null;
  async function open(){
    lastFocus = document.activeElement; hideTip(); box.hidden = false; render();
    await connect(); render(); el("dClose").focus();
  }
  function close(){ box.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  el("dClose").onclick = close;
  box.addEventListener("click", e => { if (e.target === box) close(); });
  document.addEventListener("keydown", e => { if (!box.hidden && e.key === "Escape") close(); });
  addEventListener("pagehide", () => { leave(); });
  // Everyone on the floor listens (without joining), so players walk to the arcade on every screen.
  setTimeout(() => { if (location.protocol !== "file:") connect(); }, 3500);
  redrawAll();
  return {open, leave, get playing(){ return playing; }, get phase(){ return S.phase; }};
})();

/* the arcade cabinet in the lounge is the way in */
const ARC_RECT = {x: 56.3*T, y: 29.4*T, w: 2*T, h: 2*T};
let arcHover = false;
function overArcade(sx, sy){ const w = toWorld(sx, sy), r = ARC_RECT; return w.x >= r.x - 2 && w.x <= r.x + r.w + 2 && w.y >= r.y - 12 && w.y <= r.y + r.h + 2; }
function arcadeHover(sx, sy){
  arcHover = overArcade(sx, sy);
  if (!arcHover) return false;
  tvHover = libHover = awHover = false;
  const n = DOODLE.playing.size;
  cv.style.cursor = "pointer"; tip.innerHTML = `<b>Doodle Arcade</b>${n ? `${n} playing now. Tap to join` : "Tap to play a drawing game with the team"}`;
  tip.hidden = false; tip.style.left = Math.min(vw - tip.offsetWidth - 8, sx + 14) + "px"; tip.style.top = Math.max(8, sy - 44) + "px";
  return true;
}
function drawArcade(t){
  const {x, y} = ARC_RECT, sx = x + 6, sy = y + 6, live = DOODLE.playing.size > 0;
  if (live){ ctx.fillStyle = "#fff"; ctx.fillRect(sx, sy, 20, 8); const k = Math.floor(t / 180) % 12; ctx.fillStyle = ["#ef6b6b", "#3056d3", "#6bd18a"][Math.floor(t / 2200) % 3]; for (let i = 0; i < k; i++) ctx.fillRect(sx + 2 + i * 1.4, sy + 4 + Math.round(Math.sin(i * 0.9) * 2), 1, 1); }
  else if (Math.floor(t / 600) % 2){ ctx.fillStyle = "#ffffff"; ctx.fillRect(sx + 4, sy + 3, 2, 2); ctx.fillRect(sx + 8, sy + 3, 2, 2); ctx.fillRect(sx + 12, sy + 3, 4, 2); }
  if (arcHover){ ctx.strokeStyle = "#ffcf4a"; ctx.lineWidth = 1; ctx.strokeRect(x - .5, y - .5, ARC_RECT.w + 1, ARC_RECT.h + 1); }
}
const ARCADE_SPOTS = [
  {x: 55.3*T, y: 31.95*T, face: "up", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 54.1*T, y: 31.95*T, face: "up", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 55.0*T, y: 30.5*T, face: "down", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 53.9*T, y: 30.5*T, face: "down", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 56.6*T, y: 28.7*T, face: "down", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 57.9*T, y: 28.7*T, face: "down", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 54.9*T, y: 29.1*T, face: "down", seated: false, pool: "game", where: "Doodle Arcade"},
  {x: 53.7*T, y: 29.1*T, face: "down", seated: false, pool: "game", where: "Doodle Arcade"},
];
document.getElementById("arcBtn").onclick = () => DOODLE.open();
window.__openArcade = () => DOODLE.open();
