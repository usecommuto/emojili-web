// Emojili — web Pub Round client.
// Mirrors the iOS app: anonymous auth → join_room → realtime → on-device
// hashed grading, identical to PubRoundSession / RoomPlayView / HashedAnswer.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = "https://acncsbpxcojehwppgmev.supabase.co";
const SUPABASE_KEY = "sb_publishable_iNNAJaSlrkyuAhBlLAWPew_i77Nwhzq";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "emojili-web-auth" },
});

// ---- Avatar palette (offered to web joiners; mirrors the app accents) ----
const AVATAR_COLORS = [0x6C5CE0, 0xF0A73B, 0x3FA36B, 0x5B8DEF, 0xC4536E, 0xE0679B, 0x36B0A6, 0xE8703A];

// =====================================================================
// Grading — byte-for-byte match with PhraseSolver + HashedAnswer (Swift)
// =====================================================================
function normalizeWord(w) {
  return w.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}
function rawWords(guess) {
  return guess.split(" ").map((s) => s).filter((w) => normalizeWord(w) !== "");
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function wordHash(word, salt) {
  return sha256hex(`${salt}:${normalizeWord(word)}`);
}
// Wordle two-pass over comparable tokens (hashes here) → per-word status.
function statuses(guessTokens, answerTokens) {
  const status = guessTokens.map(() => "absent");
  const remaining = [...answerTokens];
  for (let i = 0; i < guessTokens.length; i++) {
    if (i < answerTokens.length && guessTokens[i] === answerTokens[i]) {
      status[i] = "correct";
      const idx = remaining.indexOf(guessTokens[i]);
      if (idx !== -1) remaining.splice(idx, 1);
    }
  }
  for (let i = 0; i < guessTokens.length; i++) {
    if (status[i] === "correct") continue;
    const idx = remaining.indexOf(guessTokens[i]);
    if (idx !== -1) { status[i] = "present"; remaining.splice(idx, 1); }
  }
  return status;
}
// Returns { marks:[{text,status}], correct:Set<int> } for a guess vs word_hashes.
async function grade(guess, wordHashes, salt) {
  const raw = rawWords(guess);
  const gh = await Promise.all(raw.map((w) => wordHash(w, salt)));
  const st = statuses(gh, wordHashes);
  const correct = new Set();
  for (let i = 0; i < gh.length; i++) if (i < wordHashes.length && gh[i] === wordHashes[i]) correct.add(i);
  return { marks: raw.map((t, i) => ({ text: t, status: st[i] })), correct, raw };
}

// =====================================================================
// Helpers
// =====================================================================
// Room codes are alphanumeric — strip spaces/punctuation a keyboard may inject
// so join_room's exact `upper(code)=upper(p_code)` match never misses.
const cleanCode = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hex6 = (n) => "#" + (Math.max(0, n) >>> 0).toString(16).padStart(6, "0").slice(-6);
function initials(name) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]).filter(Boolean).join("");
  return letters ? letters.toUpperCase() : "?";
}
function avatarEl(name, colorInt, size = 40) {
  const a = el("span", "avatar");
  a.style.width = a.style.height = size + "px";
  a.style.fontSize = size * 0.4 + "px";
  a.style.background = hex6(colorInt);
  a.textContent = initials(name);
  return a;
}

// =====================================================================
// App state
// =====================================================================
const app = document.getElementById("app");
const store = {
  state: null,          // RoomState from room_state_json
  myId: null,           // auth uid
  channel: null,
  name: localStorage.getItem("emojili-web-name") || "",
  color: Number(localStorage.getItem("emojili-web-color")) || AVATAR_COLORS[0],
  code: cleanCode(location.hash.replace(/^#\/?/, "")),
  busy: false,
  error: "",
  // per-round solve UI state
  solve: { attempts: 0, revealed: {}, marks: [], wrong: false },
  lastRoundId: null,
  celebrated: false,
};

const room = () => store.state?.room;
const round = () => store.state?.round;
const members = () => store.state?.members || [];
const me = () => members().find((m) => m.user_id === store.myId);
const iAmEncoder = () => round()?.encoder_id && round().encoder_id === store.myId;
const mySolve = () => round()?.solves?.find((s) => s.user_id === store.myId);
const isHost = () => room()?.host_id === store.myId;

// =====================================================================
// Networking
// =====================================================================
async function rpc(fn, params) {
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw error;
  return data;
}
function friendly(e) {
  const m = (e?.message || "").toLowerCase();
  if (m.includes("room not found")) return "No room with that code.";
  if (m.includes("room full")) return "That room is full.";
  if (m.includes("already started")) return "That game has already started.";
  if (m.includes("anonymous")) return "Guest sign-in is off — ask the host.";
  return "Something went wrong. Try again.";
}

async function ensureAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) { store.myId = session.user.id; return; }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  store.myId = data.user.id;
}

async function join() {
  store.busy = true; store.error = ""; render();
  try {
    await ensureAuth();
    store.code = cleanCode(store.code);
    store.state = await rpc("join_room", { p_code: store.code, p_display_name: store.name.trim() || "Player", p_color: store.color });
    await subscribe();
    startPolling();
  } catch (e) {
    store.error = friendly(e);
  }
  store.busy = false; render();
}

async function refresh() {
  const id = room()?.id;
  if (!id) return;
  try {
    const fresh = await rpc("room_snapshot", { p_room: id });
    if (fresh) { store.state = fresh; onStateChanged(); render(); }
  } catch { /* transient */ }
}

async function subscribe() {
  const id = room()?.id;
  if (!id) return;
  if (store.channel) { await supabase.removeChannel(store.channel); store.channel = null; }
  const ch = supabase.channel(`room-${id}-${Date.now()}`);
  const bump = () => refresh();
  ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${id}` }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${id}` }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "room_rounds", filter: `room_id=eq.${id}` }, bump)
    .on("postgres_changes", { event: "*", schema: "public", table: "round_solves", filter: `room_id=eq.${id}` }, bump)
    .subscribe((status) => {
      // Mobile browsers kill sockets on suspend — rebuild the channel on failure.
      if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) scheduleResubscribe();
    });
  store.channel = ch;
}

let resubPending = false;
function scheduleResubscribe() {
  if (resubPending || !store.state) return;
  resubPending = true;
  setTimeout(async () => {
    resubPending = false;
    if (!store.state) return;
    await subscribe();
    await refresh();
  }, 2000);
}

// Poll as a safety net: realtime can silently die; a 5s snapshot keeps everyone honest.
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { if (store.state) refresh(); }, 5000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Tab returns from background → snapshot + fresh channel immediately.
async function onVisible() {
  if (document.visibilityState !== "visible" || !store.state) return;
  await refresh();
  await subscribe();
}
document.addEventListener("visibilitychange", onVisible);
window.addEventListener("focus", onVisible);
window.addEventListener("pageshow", onVisible);

// Reset per-round solve state when the live round changes.
function onStateChanged() {
  const r = round();
  const rid = r?.id || null;
  if (rid !== store.lastRoundId) {
    store.lastRoundId = rid;
    store.solve = { attempts: 0, revealed: {}, marks: [], wrong: false };
  }
  if (room()?.status === "finished" && !store.celebrated) {
    store.celebrated = true;
    const top = [...members()].sort((a, b) => b.score - a.score)[0];
    if (top?.user_id === store.myId) fireConfetti();
  }
}

// Host-only actions available on web too (a web host can drive the game).
async function startGame() { await act(() => rpc("start_game", { p_room: room().id })); }
async function advance() { await act(() => rpc("advance_round", { p_room: room().id })); }
async function submitAuthored(emojis, answer) { await act(() => rpc("submit_authored", { p_round: round().id, p_emojis: emojis, p_answer: answer })); }
async function submitSolve(solved, guesses) { await act(() => rpc("submit_room_solve", { p_round: round().id, p_solved: solved, p_guesses: guesses })); }

async function act(work) {
  store.busy = true; store.error = ""; render();
  try { const s = await work(); if (s) { store.state = s; onStateChanged(); } }
  catch (e) { store.error = friendly(e); }
  store.busy = false; render();
}

async function leave() {
  stopPolling();
  try { if (room()?.id) await rpc("leave_room", { p_room: room().id }); } catch {}
  if (store.channel) { await supabase.removeChannel(store.channel); store.channel = null; }
  store.state = null; store.lastRoundId = null; store.celebrated = false;
  render();
}

// =====================================================================
// Views
// =====================================================================
function wordmark() {
  const w = el("div", "wordmark");
  w.append(document.createTextNode("emojili"));
  const d = el("span", "dot", "."); w.append(d);
  return w;
}
function topbar(right) {
  const bar = el("div", "topbar");
  bar.append(wordmark());
  if (right) bar.append(right); else bar.append(el("span"));
  return bar;
}

function render() {
  app.innerHTML = "";
  if (!store.state) return app.append(joinScreen());
  const st = room().status;
  if (st === "lobby") return app.append(lobbyScreen());
  if (st === "finished") return app.append(finishedScreen());
  return app.append(playScreen());
}

// ---- Join / name entry ----
function joinScreen() {
  // Self-heal: an earlier ambiguous UI could save the room code AS the name.
  if (store.name && store.code && store.name.toUpperCase() === store.code) {
    store.name = ""; localStorage.removeItem("emojili-web-name");
  }

  const s = el("div", "screen");
  s.append(topbar());
  const c = el("div", "center");

  const beer = el("div", null, "🍻"); beer.style.fontSize = "60px"; c.append(beer);
  const h = el("h1", null, "Join the Pub Round");
  h.style.cssText = "font-size:26px;font-weight:800;letter-spacing:-0.5px;";
  c.append(h);

  const form = el("div", "stack");
  form.style.cssText = "width:100%;max-width:340px;margin-top:4px;gap:16px;";

  // Room code: a read-only chip when it came from the QR/URL, else an input.
  if (store.code) {
    const g = el("div"); g.style.textAlign = "center";
    g.append(el("div", "field-label", "Room"));
    const chip = el("div", "room-chip", store.code); chip.style.margin = "0 auto";
    g.append(chip);
    form.append(g);
  } else {
    const g = el("div");
    g.append(el("div", "field-label", "Room code"));
    const codeField = el("label", "field");
    const ci = el("input"); ci.placeholder = "e.g. WU8DV"; ci.maxLength = 6; ci.value = store.code;
    ci.autocapitalize = "characters"; ci.autocomplete = "off"; ci.autocorrect = "off";
    ci.style.cssText = "text-transform:uppercase;letter-spacing:4px;font-weight:800;text-align:center;";
    ci.oninput = () => { store.code = cleanCode(ci.value); ci.value = store.code; refreshJoinBtn(); };
    codeField.append(ci); g.append(codeField); form.append(g);
  }

  // Your name
  const ng = el("div");
  ng.append(el("div", "field-label", "Your name"));
  const nameField = el("label", "field");
  const ni = el("input"); ni.placeholder = "Type your name"; ni.maxLength = 16; ni.value = store.name;
  ni.autocomplete = "off";
  ni.oninput = () => { store.name = ni.value; localStorage.setItem("emojili-web-name", ni.value); refreshJoinBtn(); };
  nameField.append(ni); ng.append(nameField); form.append(ng);

  // Colour
  const cg = el("div");
  cg.append(el("div", "field-label", "Your colour"));
  const colors = el("div"); colors.style.cssText = "display:flex;gap:10px;justify-content:flex-start;flex-wrap:wrap;";
  AVATAR_COLORS.forEach((col) => {
    const dot = el("button"); dot.style.cssText = `width:34px;height:34px;border-radius:50%;background:${hex6(col)};transition:transform .1s;`;
    if (col === store.color) { dot.style.outline = "3px solid var(--ink)"; dot.style.outlineOffset = "2px"; }
    dot.onclick = () => { store.color = col; localStorage.setItem("emojili-web-color", String(col)); render(); };
    colors.append(dot);
  });
  cg.append(colors); form.append(cg);

  const btn = el("button", "btn-primary");
  btn.id = "joinBtn"; btn.onclick = join;
  form.append(btn);

  if (store.error) form.append(el("p", "err", store.error));
  c.append(form);
  s.append(c);
  // set initial button label/disabled
  setTimeout(refreshJoinBtn, 0);
  return s;
}

// Keep the Join button's label + enabled state in sync without a full re-render
// (so typing never steals focus from the field).
function refreshJoinBtn() {
  const btn = document.getElementById("joinBtn");
  if (!btn) return;
  const hasCode = !!store.code.trim();
  const hasName = !!store.name.trim();
  btn.disabled = store.busy || !hasCode || !hasName;
  btn.textContent = store.busy ? "Joining…" : (!hasCode ? "Enter a room code" : (!hasName ? "Enter your name" : "Join room"));
}

// ---- Lobby ----
function lobbyScreen() {
  const s = el("div", "screen");
  s.append(topbar(leaveBtn()));
  const wrap = el("div", "stack"); wrap.style.marginTop = "10px";

  // Invite card
  const invite = el("div", "card wait");
  invite.append(el("div", "section-label", "You're in"));
  const code = el("div", "invite-code", room().code); code.style.margin = "10px 0"; invite.append(code);
  invite.append(el("div", "muted", modeSummary()));
  wrap.append(invite);

  // Members
  const mcard = el("div", "card");
  mcard.append(el("div", "section-label", `Players · ${members().length}/${room().max_players}`));
  const list = el("div"); list.style.marginTop = "12px";
  members().forEach((m) => {
    const row = el("div", "member-row");
    row.append(avatarEl(m.display_name, m.avatar_color, 40));
    row.append(el("span", "name", m.display_name + (m.user_id === store.myId ? " (you)" : "")));
    if (m.is_host) { const t = el("span", "tag-host", "HOST"); row.append(t); }
    list.append(row);
  });
  mcard.append(list);
  wrap.append(mcard);

  if (store.error) wrap.append(el("p", "err", store.error));
  s.append(wrap);
  s.append(el("div", "spacer"));

  if (isHost()) {
    const btn = el("button", "btn-primary", store.busy ? "Starting…" : "Start game");
    btn.disabled = store.busy || members().length < 1;
    btn.onclick = startGame;
    s.append(btn);
  } else {
    const w = el("div", "wait"); w.style.padding = "10px";
    w.append(el("div", "muted", "Waiting for the host to start…"));
    s.append(w);
  }
  return s;
}

function modeSummary() {
  const r = room(); if (!r) return "";
  const parts = [r.mode === "race" ? "Race" : "Pass-around", `${r.total_rounds} rounds`];
  if (r.teams_enabled) parts.push("teams");
  if (r.survival) parts.push("survival");
  return parts.join(" · ");
}

function leaveBtn() {
  const b = el("button", "pill", "Leave");
  b.onclick = leave;
  return b;
}

// ---- Play ----
function playScreen() {
  const s = el("div", "screen");
  // header
  const head = el("div", "topbar");
  const info = el("div");
  const rt = el("div", null, `Round ${room().current_round} of ${room().total_rounds}`);
  rt.style.cssText = "font-size:18px;font-weight:800;";
  info.append(rt);
  const ms = el("div", "muted", room().mode === "race" ? "Race" : "Pass-around"); ms.style.fontSize = "12px"; info.append(ms);
  head.append(info); head.append(leaveBtn());
  s.append(head);

  const body = el("div", "stack"); body.style.marginTop = "14px";
  body.append(scoreboard());
  body.append(panel());
  if (store.error) body.append(el("p", "err", store.error));
  s.append(body);
  s.append(el("div", "spacer"));

  // host controls: force-end while active, advance once ended
  const rst = round()?.status;
  if (isHost() && (rst === "active" || rst === "ended")) {
    const last = room().current_round >= room().total_rounds;
    let label, style;
    if (rst === "active") { label = "End round early"; style = "btn-outline"; }
    else { label = last ? "Finish game" : "Next round"; style = "btn-primary"; }
    const btn = el("button", style, store.busy ? "…" : label);
    btn.disabled = store.busy;
    btn.onclick = () => {
      if (rst === "active") {
        const r = round();
        const eligible = members().filter((m) => m.alive && m.user_id !== r.encoder_id);
        const pending = eligible.filter((m) => !r.solves?.some((s) => s.user_id === m.user_id));
        if (pending.length && !window.confirm(`${pending.length} player${pending.length === 1 ? " is" : "s are"} still solving — end the round anyway?`)) return;
      }
      advance();
    };
    btn.style.marginTop = "12px";
    s.append(btn);
  }
  return s;
}

function scoreboard() {
  const sb = el("div", "scoreboard");
  members().forEach((m) => {
    const col = el("div", "score-col");
    const wrap = el("div", "avatar-wrap");
    const av = avatarEl(m.display_name, m.avatar_color, 44);
    if (room().survival && !m.alive) av.style.opacity = "0.35";
    wrap.append(av);
    const sv = round()?.solves?.find((x) => x.user_id === m.user_id);
    if (sv) { const b = el("span", "solve-badge", sv.solved ? "✅" : "❌"); wrap.append(b); }
    col.append(wrap);
    col.append(el("div", "who", m.display_name));
    col.append(el("div", "pts", String(m.score)));
    sb.append(col);
  });
  return sb;
}

function panel() {
  const r = round();
  if (!r) return waitCard("⏳", "Getting the next round ready", "");
  if (r.status === "pending") {
    if (iAmEncoder()) return authorPanel();
    return waitCard("✍️", `${encoderName()} is making a puzzle`, "Hang tight — you'll solve it next.");
  }
  if (r.status === "active") {
    if (iAmEncoder()) return waitCard("👀", "Your puzzle is live", `Watch everyone try to crack ${r.emojis || ""}.`);
    const sv = mySolve();
    if (sv) {
      // Everyone else done too? Tell the player who they're waiting on.
      const eligible = members().filter((m) => m.alive && m.user_id !== r.encoder_id);
      const allDone = eligible.every((m) => r.solves?.some((s) => s.user_id === m.user_id));
      const sub = allDone ? `Waiting for ${hostName()} to continue.` : "Waiting for the others to finish.";
      return waitCard(sv.solved ? "✅" : "🙈", sv.solved ? `Nice — +${sv.points}!` : "Out this round", sub);
    }
    return solvePanel();
  }
  return endedPanel();
}

function hostName() {
  const h = members().find((m) => m.user_id === room()?.host_id);
  return h ? (h.user_id === store.myId ? "you" : h.display_name) : "the host";
}

// Round-end interstitial: the answer, everyone's result, encoder award.
function endedPanel() {
  const r = round();
  const c = el("div", "card stack round-end");

  const head = el("div", "wait");
  head.append(el("div", "big-emoji", r.emojis || "🎉"));
  head.append(el("div", "sub", "The answer was"));
  const ans = el("div", "answer-reveal", (r.answer || "—").toUpperCase());
  head.append(ans);
  c.append(head);

  // Per-player results
  const list = el("div");
  const medals = ["🥇", "🥈", "🥉"];
  members().filter((m) => m.user_id !== r.encoder_id).forEach((m) => {
    const sv = r.solves?.find((s) => s.user_id === m.user_id);
    const row = el("div", "member-row");
    row.append(avatarEl(m.display_name, m.avatar_color, 34));
    row.append(el("span", "name", m.display_name + (m.user_id === store.myId ? " (you)" : "")));
    const right = el("span", "round-result");
    if (sv?.solved) {
      const medal = room().mode === "race" && sv.placement && sv.placement <= 3 ? medals[sv.placement - 1] + " " : "";
      right.textContent = `${medal}✅ ${sv.guesses} guess${sv.guesses === 1 ? "" : "es"} · +${sv.points}`;
    } else if (sv) {
      right.textContent = "❌ +0";
    } else {
      right.textContent = "—";
    }
    row.append(right);
    list.append(row);
  });
  // Encoder award
  if (r.encoder_id) {
    const enc = members().find((m) => m.user_id === r.encoder_id);
    const solvers = (r.solves || []).filter((s) => s.solved).length;
    if (enc) {
      const row = el("div", "member-row");
      row.append(avatarEl(enc.display_name, enc.avatar_color, 34));
      row.append(el("span", "name", enc.display_name + " ✍️"));
      const right = el("span", "round-result");
      right.textContent = `+${40 * solvers} encoder`;
      row.append(right);
      list.append(row);
    }
  }
  c.append(list);

  if (!isHost()) c.append(el("div", "sub wait-host", `Waiting for ${hostName()}…`));
  return c;
}

function encoderName() {
  return members().find((m) => m.user_id === round()?.encoder_id)?.display_name || "Someone";
}

function waitCard(emoji, title, sub) {
  const c = el("div", "card wait");
  c.append(el("div", "big-emoji", emoji));
  c.append(el("div", "title", title));
  if (sub) c.append(el("div", "sub", sub));
  return c;
}

// Encoder authoring (pass-around / mix rounds)
function authorPanel() {
  const c = el("div", "card stack");
  const head = el("div", "wait");
  head.append(el("div", "title", "Make a puzzle"));
  head.append(el("div", "sub", "Pick emojis that hint a word or phrase."));
  c.append(head);

  const ef = el("label", "field big");
  const ei = el("input"); ei.placeholder = "😀 emojis";
  ef.append(ei); c.append(ef);

  const af = el("label", "field");
  const ai = el("input"); ai.placeholder = "the answer"; ai.autocapitalize = "none"; ai.autocorrect = "off";
  ai.style.textAlign = "center";
  af.append(ai); c.append(af);

  const btn = el("button", "btn-primary", "Send to the room");
  const upd = () => { btn.disabled = store.busy || !ei.value.trim() || !ai.value.trim(); };
  ei.oninput = upd; ai.oninput = upd; upd();
  let sent = false;   // double-tap guard before busy propagates
  btn.onclick = () => {
    if (sent) return;
    sent = true; btn.disabled = true; btn.textContent = "Sending…";
    submitAuthored(ei.value.trim(), ai.value.trim());
  };
  c.append(btn);
  return c;
}

// Solver — on-device hashed grading, identical to SolvePanel.
function solvePanel() {
  const r = round();
  const slots = r.word_lengths || [];
  const wh = r.word_hashes || [];
  const salt = r.id;
  const c = el("div", "card stack" + (store.solve.wrong ? " wrong" : ""));

  c.append(el("div", "emoji-clue soft-fill", r.emojis || ""));

  const slotRow = el("div", "slots");
  slots.forEach((len, i) => {
    const w = store.solve.revealed[i];
    if (w) slotRow.append(el("span", "slot done", w.toUpperCase()));
    else slotRow.append(el("span", "slot blank", "•".repeat(len)));
  });
  c.append(slotRow);

  if (store.solve.marks.length) {
    const mk = el("div", "marks");
    store.solve.marks.forEach((m) => mk.append(el("span", "mark " + m.status, m.text)));
    c.append(mk);
  }

  const gr = el("div", "guess-row");
  const gf = el("label", "field"); gf.style.flex = "1";
  const gi = el("input"); gi.placeholder = "Type your guess"; gi.autocapitalize = "none"; gi.autocorrect = "off";
  gi.value = store.solve.draft || "";                 // survive realtime re-renders
  gi.oninput = () => { store.solve.draft = gi.value; };
  gf.append(gi); gr.append(gf);
  const send = el("button", "guess-send", "⬆");
  gr.append(send); c.append(gr);

  c.append(el("div", "guesses-left", `${6 - store.solve.attempts} guesses left`));

  let inFlight = false;   // guard: Enter-key repeats can't double-submit
  const submit = async () => {
    if (inFlight) return;
    const g = (store.solve.draft || "").trim();
    if (!g || !wh.length) return;
    inFlight = true;
    const { marks, correct, raw } = await grade(g, wh, salt);
    store.solve.attempts += 1;
    store.solve.marks = marks;
    store.solve.draft = "";
    correct.forEach((pos) => { if (pos < raw.length) store.solve.revealed[pos] = raw[pos]; });
    const solvedAll = slots.length > 0 && Object.keys(store.solve.revealed).length === slots.length;
    if (solvedAll) { fireConfetti(); await submitSolve(true, store.solve.attempts); return; }
    if (store.solve.attempts >= 6) { await submitSolve(false, store.solve.attempts); return; }
    store.solve.refocus = true;   // keep the keyboard up between guesses
    store.solve.wrong = true; render();
    setTimeout(() => { store.solve.wrong = false; render(); }, 420);
    inFlight = false;   // more guesses to go — re-arm (submit paths leave it locked; round re-renders anyway)
  };
  send.onclick = submit;
  gi.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  // Keep the keyboard up: first mount, mid-draft re-renders, and after each guess.
  if (store.solve.draft || store.solve.attempts === 0 || store.solve.refocus) {
    store.solve.refocus = false;
    setTimeout(() => { gi.focus(); const n = gi.value.length; gi.setSelectionRange(n, n); }, 20);
  }
  return c;
}

// ---- Finished ----
function finishedScreen() {
  const s = el("div", "screen");
  s.append(topbar(leaveBtn()));
  const c = el("div", "stack"); c.style.marginTop = "10px";
  const h = el("div", "wait");
  h.append(el("div", "big-emoji", "🏆"));
  h.append(el("div", "title", "Final scores"));
  c.append(h);

  const board = el("div", "stack");
  c.append(board);
  const sorted = [...members()].sort((a, b) => b.score - a.score);
  sorted.forEach((m, i) => {
    const row = el("div", "leader-row" + (i === 0 ? " first" : ""));
    row.append(el("span", "rank", `${i + 1}`));
    row.append(avatarEl(m.display_name, i === 0 ? 0xffffff : m.avatar_color, 34));
    if (i === 0) row.lastChild.style.color = "var(--accent)";
    row.append(el("span", "lname", m.display_name + (m.user_id === store.myId ? " (you)" : "")));
    row.append(el("span", "lscore", String(m.score)));
    board.append(row);
  });

  s.append(c);
  s.append(el("div", "spacer"));
  const btn = el("button", "btn-outline", "Leave room");
  btn.onclick = leave;
  s.append(btn);
  return s;
}

// ---- Confetti ----
function fireConfetti() {
  const palette = ["#6C5CE0", "#C5F04A", "#F0A73B", "#3FA36B", "#5B8DEF", "#C4536E", "#F06CC2"];
  const layer = el("div"); layer.id = "confetti"; document.body.append(layer);
  const N = 40;
  for (let i = 0; i < N; i++) {
    const p = el("div", "confetti-piece");
    const circle = Math.random() < 0.5;
    const w = 6 + Math.random() * 5;
    p.style.width = w + "px";
    p.style.height = (circle ? w : w * 0.55) + "px";
    p.style.background = palette[i % palette.length];
    p.style.borderRadius = circle ? "50%" : "2px";
    p.style.left = Math.random() * 100 + "%";
    const drift = (Math.random() * 140 - 70) + "px";
    const dur = 1.3 + Math.random() * 0.7;
    const delay = Math.random() * 0.25;
    const spin = (160 + Math.random() * 360) * (Math.random() < 0.5 ? 1 : -1);
    p.animate(
      [
        { transform: `translate(0, -20px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${drift}, 100vh) rotate(${spin}deg)`, opacity: 0.9, offset: 0.85 },
        { transform: `translate(${drift}, 110vh) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: dur * 1000, delay: delay * 1000, easing: "ease-in", fill: "forwards" }
    );
    layer.append(p);
  }
  setTimeout(() => layer.remove(), 2600);
}

// ---- Boot ----
window.addEventListener("hashchange", () => {
  const c = cleanCode(location.hash.replace(/^#\/?/, ""));
  if (c && !store.state) { store.code = c; render(); }
});
render();
