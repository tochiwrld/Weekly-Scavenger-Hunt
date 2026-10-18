/* Weekly Hunt — single-page app (no build step) */
const app = document.getElementById("app");
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => new Date(d).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let me = null, offset = 0, unread = 0, token = 0, ticker = null, poller = null;
const nowMs = () => Date.now() + offset;

/* ---------- api ---------- */
async function api(path, { method = "GET", json, form } = {}) {
  const opt = { method, headers: {}, credentials: "same-origin" };
  if (json) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(json); }
  if (form) opt.body = form;
  const r = await fetch("/api" + path, opt);
  let d = null;
  try { d = await r.json(); } catch {}
  if (!r.ok) {
    if (r.status === 401 && me && !path.startsWith("/auth")) { me = null; render(); }
    throw new Error(d?.error || "Something went wrong. Try again.");
  }
  return d;
}

/* ---------- small ui helpers ---------- */
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
function burst() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#FFC800", "#14110F", "#00A86B", "#2457FF", "#E5382F", "#fff"];
  for (let i = 0; i < 28; i++) {
    const c = document.createElement("i");
    c.className = "confetti";
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 190;
    c.style.cssText = `background:${colors[i % colors.length]};--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d + 80}px;--rot:${Math.random() * 720}deg`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 1200);
  }
}
function countUp() {
  $$(".count").forEach((el) => {
    const to = +el.dataset.to, t0 = performance.now();
    if (!to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to; return; }
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 800);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function fmtLeft(ms) {
  if (ms <= 0) return "Challenge closed";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d === 0 && h === 0) return `${m} min ${s % 60} sec left`;
  const p = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `${d ? p(d, "day") + " " : ""}${p(h, "hour")} ${p(m, "minute")} left`;
}
function startTicker() {
  clearInterval(ticker);
  const tick = () => {
    $$(".cd[data-end]").forEach((el) => {
      const ms = new Date(el.dataset.end) - nowMs();
      el.textContent = fmtLeft(ms);
      el.classList.toggle("low", ms > 0 && ms < 86400000);
      if (ms <= 0 && !el.dataset.done) { el.dataset.done = 1; setTimeout(render, 800); }
    });
  };
  tick();
  ticker = setInterval(tick, 1000);
}
function sheet(html) {
  const el = document.createElement("div");
  el.className = "scrim";
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><button class="x" data-close aria-label="Close">×</button>${html}</div>`;
  document.body.appendChild(el);
  document.body.style.overflow = "hidden";
  const close = () => { el.remove(); document.body.style.overflow = ""; };
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) close(); });
  return { el, close };
}
const empty = (icon, title, text = "", btn = "") =>
  `<div class="card empty"><div class="big">${icon}</div><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${btn}</div>`;
const medal = (r, pts) => (pts > 0 && r <= 3 ? ["🥇", "🥈", "🥉"][r - 1] : r + ".");
function lbRows(rows, { limit } = {}) {
  return `<div class="lb">${rows.slice(0, limit || rows.length).map((r, i) =>
    `<div class="r ${r.me ? "me" : ""} ${r.points > 0 && r.rank <= 3 ? "top" + r.rank : ""}" style="animation:drop .35s both;animation-delay:${Math.min(i, 12) * 35}ms">
       <div class="pos">${medal(r.rank, r.points)}</div><div class="nm">${esc(r.nickname)}${r.me ? " (you)" : ""}</div>
       <div class="muted">${r.items} item${r.items === 1 ? "" : "s"}</div><div class="pt">${r.points}</div></div>`).join("")}</div>`;
}
const statusLabel = { not_submitted: "Not submitted", pending: "Pending review", approved: "Approved", rejected: "Rejected" };
const statusIcon = { not_submitted: "⬜", pending: "⏳", approved: "✅", rejected: "❌" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- image shrinking (fast uploads on mobile data) ---------- */
async function shrink(file, max = 1600, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    return blob || file;
  } catch { return file; }
}

/* ---------- shell & router ---------- */
function shell(path) {
  const admin = me.role === "admin";
  const item = (href, icon, label, on, dot = "") => `<a href="${href}" class="${on ? "on" : ""}"><span class="ic">${icon}</span>${label}${dot}</a>`;
  const p = path;
  app.innerHTML = `
    <header class="top"><div class="logo">🎯 WEEKLY HUNT</div><div class="who"><span>${esc(me.nickname)}</span><button data-act="logout">Log out</button></div></header>
    <main id="view"></main>
    <nav class="nav">
      ${admin ? item("#/admin/review", "🛡️", "Admin", p.startsWith("/admin")) : ""}
      ${item("#/", "🏠", "Home", p === "/")}
      ${item("#/hunt", "📷", "Hunt", p === "/hunt")}
      ${item("#/ranks", "🏆", "Ranks", p === "/ranks")}
      ${admin ? "" : item("#/history", "📜", "Past", p.startsWith("/history") || p.startsWith("/results"))}
      ${item("#/alerts", "🔔", "Alerts", p === "/alerts", unread ? `<span class="dot">${unread > 9 ? "9+" : unread}</span>` : "")}
    </nav>`;
}

async function render() {
  const my = ++token;
  clearInterval(ticker);
  if (!me) return authView();
  const path = location.hash.slice(1) || "/";
  shell(path);
  const v = $("#view");
  v.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  window.scrollTo(0, 0);
  try {
    let html;
    if (path === "/") html = await dashboard();
    else if (path === "/hunt") html = await huntView();
    else if (path === "/ranks") html = await ranksView();
    else if (path === "/history") html = await historyView();
    else if (path.startsWith("/results/")) html = await resultsView(path.split("/")[2]);
    else if (path === "/alerts") html = await alertsView();
    else if (path.startsWith("/admin") && me.role === "admin") html = await adminView(path);
    else html = empty("🤷", "Page not found", "", '<a class="btn" href="#/">Go home</a>');
    if (my !== token) return;
    v.innerHTML = html;
    if (path === "/admin/subs") loadSubs();
    countUp();
    startTicker();
  } catch (e) {
    if (my !== token) return;
    v.innerHTML = empty("😵", "Couldn't load this page", e.message, '<button class="btn" data-act="reload">Try again</button>');
  }
}
window.addEventListener("hashchange", render);

/* ---------- auth ---------- */
function authView(mode = "login", msg = "") {
  clearInterval(poller);
  app.innerHTML = `
  <div class="auth">
    <div class="hero">WEEKLY<br>HUNT</div>
    <div class="tag">Find it. Snap it twice. Climb the board.</div>
    <div class="stripe-band"></div>
    <div class="tabs"><a class="tab ${mode === "login" ? "on" : ""}" data-act="auth-mode" data-mode="login">Log in</a><a class="tab ${mode === "register" ? "on" : ""}" data-act="auth-mode" data-mode="register">Join the hunt</a></div>
    <form class="card" id="authform" novalidate>
      ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
      ${mode === "register" ? `<div class="field"><label for="nickname">Nickname</label><input id="nickname" name="nickname" autocomplete="nickname" maxlength="20" required><div class="muted">Shown on the leaderboard. Your email stays private.</div></div>` : ""}
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" inputmode="email" autocomplete="email" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" required></div>
      ${mode === "register" ? `<div class="field"><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required></div>` : ""}
      <button class="btn block" type="submit">${mode === "login" ? "Log in" : "Create my account"}</button>
    </form>
  </div>`;
  $("#authform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target);
    btn.classList.add("spin"); btn.disabled = true;
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await api(mode === "login" ? "/auth/login" : "/auth/register", { method: "POST", json: data });
      await boot(true);
    } catch (err) {
      authView(mode, err.message);
    }
  });
}

/* ---------- participant views ---------- */
async function dashboard() {
  const d = await api("/dashboard");
  offset = d.now - Date.now();
  const upcoming = d.upcoming ? `<div class="card mist"><h3>Next hunt: ${esc(d.upcoming.title)}</h3><p class="muted" style="margin:6px 0 0">Starts ${fmtDate(d.upcoming.start_at)}</p></div>` : "";
  if (d.phase === "none") {
    return empty("⏳", "No hunt is live yet", "The admin will publish the next challenge soon. You'll get an alert when it starts.") + upcoming;
  }
  const c = d.challenge, active = d.phase === "active";
  let bump = "";
  const key = `rank:${c.id}`, prev = +localStorage.getItem(key) || 0;
  if (d.rank && prev && d.rank < prev) bump = `<span class="bump">▲ ${prev - d.rank}</span>`;
  if (d.rank) localStorage.setItem(key, d.rank);
  const pct = d.items_total ? Math.round((d.items_done / d.items_total) * 100) : 0;
  const by = (s) => d.recent.filter((r) => r.status === s);
  const subList = (arr, kind) => arr.length ? `<div class="stack">${arr.map((r) => `<div class="card flat row between"><div class="grow"><b>${esc(r.title)}</b><div class="muted">${kind === "pending" ? "Sent " + fmtDate(r.submitted_at) : fmtDate(r.reviewed_at)}${r.rejection_reason ? " · " + esc(r.rejection_reason) : ""}</div></div>${kind === "approved" ? `<span class="pts" style="color:var(--ok)">+${r.points}</span>` : `<span class="st ${kind}">${statusIcon[kind]}</span>`}</div>`).join("")}</div>` : "";
  const section = (title, arr, kind) => arr.length ? `<div class="sec-title"><h2>${title}</h2></div>${subList(arr, kind)}` : "";
  return `
  <section class="plate"><div class="stripe"></div><div class="in">
    <div class="muted" style="color:#c9c2b4">${active ? "This week" : "Last week"}</div>
    <div class="week">${esc(c.title)}</div>
    ${active ? `<div class="cd" data-end="${c.end_at}"></div>` : `<div class="cd">Challenge closed</div>`}
    <div style="margin-top:16px"><div class="muted" style="color:#c9c2b4">Your score</div>
      <div class="bignum"><span class="count" data-to="${d.score}">0</span><small>points</small></div></div>
    <div class="stats">
      <div class="stat"><b>${d.rank ? "#" + d.rank : "–"}${bump}</b><span>${d.rank ? `Your rank of ${d.total}` : "Admins don't play"}</span></div>
      <div class="stat"><b>${d.items_done} / ${d.items_total}</b><span>Items done${d.pending ? ` · ${d.pending} waiting` : ""}</span></div>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${d.rank > 1 && d.gap ? `<p style="margin:10px 0 0;color:#c9c2b4">${d.gap} more point${d.gap === 1 ? "" : "s"} to pass ${esc(d.above)}</p>` : ""}
  </div></section>
  ${active ? `<a class="btn block" href="#/hunt">📷 View challenge</a>` : `<a class="btn block" href="#/results/${c.id}">🏁 See the final results</a>`}
  ${upcoming}
  ${section("Waiting for review", by("pending"), "pending")}
  ${section("Approved", by("approved"), "approved")}
  ${section("Rejected: try again", by("rejected"), "rejected")}
  <div class="sec-title"><h2>Leaderboard</h2><a href="#/ranks" class="muted">See all</a></div>
  ${lbRows(d.leaderboard, { limit: 5 })}`;
}

let huntItems = [];
async function huntView() {
  const d = await api("/challenge/current");
  offset = d.now - Date.now();
  if (d.phase !== "active") {
    return empty("⏳", d.phase === "upcoming" ? "The next hunt hasn't started" : "No hunt is live", d.phase === "upcoming" ? `${d.upcoming.title} starts ${fmtDate(d.upcoming.start_at)}.` : "Check back soon.");
  }
  huntItems = d.items;
  const c = d.challenge;
  return `
  <section class="plate"><div class="stripe"></div><div class="in">
    <div class="week">${esc(c.title)}</div><div class="cd" data-end="${c.end_at}"></div>
    ${c.description ? `<p style="margin:10px 0 0;color:#e7e1d3">${esc(c.description)}</p>` : ""}
    ${c.rules ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:700;color:var(--danfo)">Rules</summary><p style="white-space:pre-wrap;margin:8px 0 0;color:#e7e1d3">${esc(c.rules)}</p></details>` : ""}
  </div></section>
  ${d.items.map(itemCard).join("")}`;
}
function itemCard(it) {
  let cta = "";
  if (it.status === "not_submitted") cta = `<button class="btn block" data-act="submit" data-id="${it.id}">📷 Submit photos</button>`;
  if (it.status === "pending") cta = `<p class="muted" style="margin:10px 0 0">Both photos are in. Points arrive once the admin approves.</p>`;
  if (it.status === "rejected") cta = `<div class="reason"><b>Rejected:</b> ${esc(it.rejection_reason)}</div><button class="btn block" style="margin-top:10px" data-act="submit" data-id="${it.id}">📷 Submit new photos</button>`;
  return `<article class="card item ${it.status}">
    ${it.status === "approved" ? `<div class="stamp">+${it.points} PTS</div>` : ""}
    <div class="row wrap"><span class="num">Item ${it.number}</span><span class="chip ${it.difficulty}">${cap(it.difficulty)}</span></div>
    <h3>${esc(it.title)}</h3>
    ${it.description ? `<p>${esc(it.description)}</p>` : ""}
    ${it.instructions ? `<p class="muted">${esc(it.instructions)}</p>` : ""}
    ${it.hint ? `<details><summary>💡 Need a hint?</summary><p class="muted" style="margin-top:6px">${esc(it.hint)}</p></details>` : ""}
    <div class="row between" style="margin-top:10px"><span class="pts">${it.points} pts</span><span class="st ${it.status}">${statusIcon[it.status]} ${statusLabel[it.status]}</span></div>
    ${cta}</article>`;
}

function openSubmit(it) {
  const photos = [null, null];
  const { el, close } = sheet(`
    <h2>Item ${it.number}</h2>
    <p style="margin:6px 0"><b>${esc(it.title)}</b> · ${it.points} points</p>
    <p class="muted">${esc(it.instructions || it.description || "Take two clear photos as proof.")}</p>
    <div class="slots">${[0, 1].map((i) => `<label class="slot" data-i="${i}"><span class="lbl">Photo ${i + 1}</span><span class="ph"><span class="cam">📷</span>Add photo ${i + 1}</span><input type="file" accept="image/*"></label>`).join("")}</div>
    <div class="err hidden"></div>
    <button class="btn block ok" disabled>Submit both photos</button>
    <p class="muted" style="margin:10px 0 0;text-align:center">You can retake either photo before you submit.</p>`);
  const btn = $(".btn.ok", el), err = $(".err", el);
  $$(".slot", el).forEach((slot) => {
    $("input", slot).addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const i = +slot.dataset.i;
      slot.classList.add("filled");
      $(".ph", slot)?.remove();
      slot.insertAdjacentHTML("afterbegin", `<span class="ph" style="padding:8px">Preparing…</span>`);
      photos[i] = await shrink(f);
      $(".ph", slot)?.remove(); $("img", slot)?.remove(); $(".retake", slot)?.remove();
      const img = new Image();
      img.src = URL.createObjectURL(photos[i]);
      slot.prepend(img);
      slot.insertAdjacentHTML("beforeend", `<span class="retake">Tap to retake</span>`);
      btn.disabled = !(photos[0] && photos[1]);
    });
  });
  btn.addEventListener("click", async () => {
    err.classList.add("hidden");
    btn.classList.add("spin"); btn.disabled = true;
    const fd = new FormData();
    fd.append("photo1", photos[0], "photo1.jpg");
    fd.append("photo2", photos[1], "photo2.jpg");
    try {
      await api(`/items/${it.id}/submit`, { method: "POST", form: fd });
      close();
      toast("⏳ Submission pending. Keep hunting!", "good");
      render();
    } catch (e) {
      err.textContent = e.message; err.classList.remove("hidden");
      btn.classList.remove("spin"); btn.disabled = false;
    }
  });
}

async function ranksView() {
  const d = await api("/leaderboard");
  if (d.phase === "none") return empty("🏆", "No leaderboard yet", "It appears when the first hunt goes live.");
  const m = d.me;
  return `
  <div><h1>${esc(d.challenge.title)}</h1><p class="muted">${d.phase === "active" ? "Weekly leaderboard. It resets when the next hunt starts." : "Final standings"}</p></div>
  ${m ? `<div class="card dark"><div class="row between"><div><div class="muted" style="color:#c9c2b4">Your rank</div><div class="bignum" style="font-size:44px">#${m.rank}</div></div>
     <div style="text-align:right"><div class="pts" style="color:var(--danfo)">${m.points} pts</div><div class="muted" style="color:#c9c2b4">${m.items} item${m.items === 1 ? "" : "s"} complete</div></div></div>
     ${m.above ? `<p style="margin:10px 0 0;color:#e7e1d3">${m.gap} more point${m.gap === 1 ? "" : "s"} to pass ${esc(m.above)}</p>` : `<p style="margin:10px 0 0;color:var(--danfo);font-weight:700">You're in front. Hold on to it.</p>`}</div>` : ""}
  ${lbRows(d.rows)}
  <p class="muted">Tied on points? Whoever reached that score first ranks higher.</p>`;
}

async function historyView() {
  const d = await api("/results");
  if (!d.results.length) return empty("📜", "No finished hunts yet", "Final results show up here when a challenge ends.");
  return `<h1>Past hunts</h1>` + d.results.map((r) => `
    <a href="#/results/${r.id}" class="card" style="text-decoration:none;display:block">
      <h3>${esc(r.title)}</h3><p class="muted" style="margin:4px 0 8px">Ended ${fmtDate(r.end_at)}</p>
      <div class="row between"><span>${r.winner ? "🥇 " + esc(r.winner) : "No winner"}</span><span class="st approved">${r.my_rank ? "You: #" + r.my_rank + " · " + r.my_points + " pts" : "Did not play"}</span></div></a>`).join("");
}

async function resultsView(id) {
  const d = await api("/results/" + encodeURIComponent(id));
  const podium = d.rows.filter((r) => r.points > 0 && r.rank <= 3);
  const m = d.me;
  return `
  <div><h1>${esc(d.challenge.title)}</h1><p class="muted">Results</p></div>
  ${d.finalized ? "" : `<div class="card mist">Some submissions are still being reviewed, so these standings may change.</div>`}
  <div class="card dark stack">
    ${podium.length ? podium.map((r) => `<div class="row between"><span style="font-family:var(--display);font-size:18px">${medal(r.rank, r.points)} ${["1st", "2nd", "3rd"][r.rank - 1]} · ${esc(r.nickname)}</span><span class="pts" style="color:var(--danfo)">${r.points} pts</span></div>`).join("") : "<p>Nobody scored this week.</p>"}
  </div>
  ${m ? `<div class="card"><h2>Your week</h2><dl class="kv" style="margin-top:10px"><dt>Final rank</dt><dd>#${m.rank}</dd><dt>Final score</dt><dd>${m.points} points</dd><dt>Items completed</dt><dd>${d.completed.length}</dd><dt>Items missed</dt><dd>${d.missed.length}</dd><dt>Approved submissions</dt><dd>${d.approved.length}</dd></dl>
    ${d.completed.length ? `<p style="margin:12px 0 4px"><b>Completed</b></p>${d.completed.map((i) => `<div class="row between"><span>✅ ${esc(i.title)}</span><b>+${i.points}</b></div>`).join("")}` : ""}
    ${d.missed.length ? `<p style="margin:12px 0 4px"><b>Missed</b></p>${d.missed.map((i) => `<div class="row between muted"><span>⬜ ${esc(i.title)}</span><span>${i.points}</span></div>`).join("")}` : ""}</div>` : ""}
  <div class="sec-title"><h2>Full standings</h2></div>${lbRows(d.rows)}
  <a class="btn ghost block" href="#/history">Back to past hunts</a>`;
}

async function alertsView() {
  const d = await api("/notifications");
  api("/notifications/read", { method: "POST" }).then(() => { unread = 0; $$(".nav .dot").forEach((x) => x.remove()); }).catch(() => {});
  if (!d.notifications.length) return empty("🔔", "No alerts yet", "New challenges, approvals and reminders land here.");
  return `<h1>Alerts</h1>` + d.notifications.map((n) => `
    <a href="${esc(n.link || "#/")}" class="card flat" style="text-decoration:none;display:block;${n.read ? "" : "border-color:var(--wait);background:#F3F6FF"}">
      <div>${esc(n.message)}</div><div class="muted">${fmtDate(n.created_at)}</div></a>`).join("");
}

/* ---------- admin views ---------- */
const ADMIN_TABS = [["review", "Review"], ["overview", "Overview"], ["hunts", "Hunts"], ["subs", "Submissions"], ["users", "People"], ["settings", "Alerts"], ["audit", "Log"]];
const adminTabs = (on, pending) => `<div class="tabs">${ADMIN_TABS.map(([k, l]) => `<a class="tab ${on === k ? "on" : ""}" href="#/admin/${k}">${l}${k === "review" && pending ? `<span class="n">${pending}</span>` : ""}</a>`).join("")}</div>`;

async function adminView(path) {
  const parts = path.split("/");
  const page = parts[2] || "review";
  if (page === "review") return adminReview();
  if (page === "overview") return adminOverview();
  if (page === "hunts") return adminHunts();
  if (page === "challenge") return adminChallenge(parts[3]);
  if (page === "subs") return adminSubs();
  if (page === "users") return adminUsers();
  if (page === "settings") return adminSettings();
  if (page === "audit") return adminAudit();
  return empty("🤷", "Not found");
}

function reviewCard(s, actions = true) {
  const hist = (s.history || []).map((h) => `<div class="hist">Earlier rejection: ${esc(h.reason)}</div>`).join("");
  return `<article class="card review" data-sub="${s.id}">
    <div class="row between wrap"><b>${esc(s.nickname)}</b><span class="st ${s.status}">${statusIcon[s.status]} ${cap(s.status)}</span></div>
    <div style="margin-top:4px"><b>${esc(s.item_title)}</b> · ${s.points} pts</div>
    <div class="muted">${esc(s.challenge_title)} · ${fmtDate(s.submitted_at)}</div>
    ${s.instructions ? `<p class="muted" style="margin:6px 0 0">${esc(s.instructions)}</p>` : ""}
    <div class="photos"><img loading="lazy" src="/api/photo/${s.id}/1" alt="Photo 1" data-act="zoom"><img loading="lazy" src="/api/photo/${s.id}/2" alt="Photo 2" data-act="zoom"></div>
    ${s.status === "rejected" && s.rejection_reason ? `<div class="reason"><b>Reason:</b> ${esc(s.rejection_reason)}</div>` : ""}
    ${hist}
    ${actions && s.status === "pending" ? `
      <div class="acts"><button class="btn ok" data-act="approve">✅ Approve</button><button class="btn bad" data-act="reject-open">❌ Reject</button></div>
      <div class="rj hidden stack" style="margin-top:10px"><textarea placeholder="Why is it rejected? The participant will see this." maxlength="300"></textarea><button class="btn bad block" data-act="reject">Send rejection</button></div>` : ""}
  </article>`;
}

async function adminReview() {
  const d = await api("/admin/review");
  return adminTabs("review", d.queue.length) + `<div id="queue" class="stack">${d.queue.map((s) => reviewCard(s)).join("") || empty("🎉", "All caught up", "No submissions are waiting.")}</div>`;
}

async function adminOverview() {
  const d = await api("/admin/overview");
  offset = d.now - Date.now();
  const c = d.challenge;
  const stat = (n, l) => `<div class="card"><div class="pts">${n}</div><div class="muted">${l}</div></div>`;
  return adminTabs("overview", d.pending_all) + (c ? `
    <div class="plate"><div class="stripe"></div><div class="in"><div class="muted" style="color:#c9c2b4">${d.phase === "active" ? "Active challenge" : "Last challenge"}</div><div class="week">${esc(c.title)}</div>${d.phase === "active" ? `<div class="cd" data-end="${c.end_at}"></div>` : `<div class="cd">Closed</div>`}</div></div>
    <div class="stats" style="margin:0">${stat(d.participants, "Participants")}${stat(d.counts.total, "Total submissions")}${stat(d.counts.pending, "Pending")}${stat(d.counts.approved, "Approved")}${stat(d.counts.rejected, "Rejected")}</div>
    <div class="sec-title"><h2>Leaderboard</h2></div>${d.leaderboard.length ? lbRows(d.leaderboard.map((r) => ({ ...r, me: false }))) : empty("👥", "No participants yet")}`
    : empty("📅", "No challenge yet", "Create one under Hunts.")) +
    (d.upcoming ? `<div class="card mist">Next up: <b>${esc(d.upcoming.title)}</b>, starts ${fmtDate(d.upcoming.start_at)}</div>` : "");
}

async function adminHunts() {
  const d = await api("/admin/challenges");
  const chip = { draft: "Draft", upcoming: "Scheduled", active: "Live", closed: "Closed" };
  return adminTabs("hunts") + `<a class="btn block" href="#/admin/challenge/new">＋ New challenge</a>` +
    (d.challenges.map((c) => `<a href="#/admin/challenge/${c.id}" class="card" style="text-decoration:none;display:block">
      <div class="row between"><h3>${esc(c.title)}</h3><span class="st ${c.phase === "active" ? "approved" : c.phase === "draft" ? "not_submitted" : "pending"}">${chip[c.phase]}</span></div>
      <p class="muted" style="margin:6px 0 0">${fmtDate(c.start_at)} → ${fmtDate(c.end_at)}</p>
      <p class="muted" style="margin:2px 0 0">${c.item_count} items · ${c.submission_count} submissions</p></a>`).join("") || empty("📅", "No challenges yet", "Create your first weekly hunt."));
}

const toLocalInput = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

async function adminChallenge(id) {
  const isNew = id === "new";
  let c = { title: "", description: "", rules: "", start_at: new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString(), phase: "draft", status: "draft" }, items = [];
  c.end_at = new Date(new Date(c.start_at).getTime() + 7 * 86400000).toISOString();
  if (!isNew) { const d = await api("/admin/challenges/" + encodeURIComponent(id)); c = d.challenge; items = d.items; }
  const published = c.status === "published";
  return `${adminTabs("hunts")}
  <form class="card" id="chform" data-id="${isNew ? "" : c.id}">
    <h2>${isNew ? "New challenge" : "Edit challenge"}</h2>
    ${published ? `<p class="muted">${c.phase === "active" ? "This challenge is live." : c.phase === "closed" ? "This challenge is closed." : "This challenge is scheduled."}</p>` : `<p class="muted">Draft: participants can't see it until you publish.</p>`}
    <div class="field" style="margin-top:12px"><label>Challenge name</label><input name="title" value="${esc(c.title)}" maxlength="120" placeholder="Week 04: City hunt" required></div>
    <div class="field"><label>Description</label><textarea name="description" maxlength="2000">${esc(c.description)}</textarea></div>
    <div class="field"><label>Rules</label><textarea name="rules" maxlength="4000">${esc(c.rules)}</textarea></div>
    <div class="field"><label>Starts</label><input type="datetime-local" name="start_at" value="${toLocalInput(c.start_at)}" required></div>
    <div class="field"><label>Ends</label><input type="datetime-local" name="end_at" value="${toLocalInput(c.end_at)}" required><div class="muted">Defaults to exactly 7 days after the start.</div></div>
    <div class="err hidden"></div>
    <button class="btn block" type="submit">Save challenge</button>
  </form>
  ${isNew ? "" : `
  <div class="sec-title"><h2>Items (${items.length})</h2></div>
  ${items.map((i, n) => `<div class="card flat" data-item='${esc(JSON.stringify(i))}'><div class="row between"><div class="grow"><b>${n + 1}. ${esc(i.title)}</b><div class="muted">${cap(i.difficulty)} · ${i.points} pts</div></div>
    <button class="btn sm ghost" data-act="item-edit">Edit</button><button class="btn sm bad" data-act="item-del" data-id="${i.id}">✕</button></div></div>`).join("")}
  <button class="btn block ghost" data-act="item-add" data-cid="${c.id}">＋ Add item</button>
  <div class="card stack">
    ${published ? `<button class="btn block ghost" data-act="unpublish" data-id="${c.id}">Unpublish (back to draft)</button>` : `<button class="btn block ok" data-act="publish" data-id="${c.id}">🚀 Publish challenge</button>`}
    <button class="btn block bad" data-act="ch-del" data-id="${c.id}">${c.submission_count ? "Archive challenge" : "Delete challenge"}</button>
  </div>`}`;
}

function itemForm(it, cid, done) {
  const { el, close } = sheet(`
    <h2>${it ? "Edit item" : "Add item"}</h2>
    <form class="stack" style="margin-top:12px" novalidate>
      <div><label>Item name</label><input name="title" maxlength="160" value="${esc(it?.title)}" placeholder="Find a yellow taxi" required></div>
      <div><label>Description</label><textarea name="description" maxlength="1000">${esc(it?.description)}</textarea></div>
      <div><label>Instructions for the photos</label><textarea name="instructions" maxlength="2000">${esc(it?.instructions)}</textarea></div>
      <div class="row"><div class="grow"><label>Difficulty</label><select name="difficulty">${["easy", "medium", "hard", "extreme"].map((d) => `<option value="${d}" ${it?.difficulty === d ? "selected" : ""}>${cap(d)}</option>`).join("")}</select></div>
      <div class="grow"><label>Points</label><input name="points" type="number" inputmode="numeric" min="0" max="10000" value="${esc(it?.points ?? 10)}"></div></div>
      <div><label>Hint (optional)</label><input name="hint" maxlength="500" value="${esc(it?.hint)}"></div>
      <div class="err hidden"></div>
      <button class="btn block" type="submit">Save item</button>
    </form>`);
  $("form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await api(it ? `/admin/items/${it.id}` : `/admin/challenges/${cid}/items`, { method: it ? "PUT" : "POST", json: data });
      close(); done();
    } catch (err) { const x = $(".err", el); x.textContent = err.message; x.classList.remove("hidden"); }
  });
}

async function adminSubs() {
  const [ch] = await Promise.all([api("/admin/challenges")]);
  return adminTabs("subs") + `
    <div class="card stack" id="subfilters">
      <input id="sq" type="search" placeholder="Search participant or item">
      <div class="row"><select id="sstatus" class="grow"><option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
      <select id="schal" class="grow"><option value="">All challenges</option>${ch.challenges.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("")}</select></div>
    </div><div id="sublist" class="stack"><div class="skel"></div></div>`;
}
async function loadSubs() {
  const list = $("#sublist");
  if (!list) return;
  const p = new URLSearchParams({ q: $("#sq").value, status: $("#sstatus").value, challenge: $("#schal").value });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  try {
    const d = await api("/admin/submissions?" + p);
    list.innerHTML = d.submissions.map((s) => reviewCard(s)).join("") || empty("🔎", "Nothing matches", "Try a different filter.");
  } catch (e) { list.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

let userQuery = "";
async function adminUsers() {
  const d = await api("/admin/users?q=" + encodeURIComponent(userQuery));
  window.__usersCh = d.active_challenge;
  return adminTabs("users") + `<input id="uq" type="search" placeholder="Search nickname or email" value="${esc(userQuery)}">` +
    (d.users.map((u) => `<div class="card flat" data-u='${esc(JSON.stringify({ id: u.id, nickname: u.nickname, score: u.score }))}'>
      <div class="row between"><b>${esc(u.nickname)}${u.role === "admin" ? " 🛡️" : ""}</b><span class="st ${u.status === "active" ? "approved" : "rejected"}">${cap(u.status)}</span></div>
      <div class="muted">${esc(u.email)}</div>
      <div class="muted">${u.submissions} submissions · ${u.approved} approved · ${u.score} pts this week</div>
      ${u.role === "participant" ? `<div class="row wrap" style="margin-top:10px"><button class="btn sm ghost" data-act="adjust">Adjust score</button>
        <button class="btn sm ghost" data-act="toggle-user" data-status="${u.status === "active" ? "disabled" : "active"}">${u.status === "active" ? "Disable" : "Enable"}</button>
        <button class="btn sm bad" data-act="remove-user">Remove</button></div>` : ""}
    </div>`).join("") || empty("👥", "No one found"));
}

async function adminSettings() {
  const d = await api("/admin/settings");
  const s = d.settings;
  const sw = (k, label, sub = "") => `<div class="sw"><div><b>${label}</b>${sub ? `<div class="muted">${sub}</div>` : ""}</div><input type="checkbox" data-set="${k}" ${s[k] ? "checked" : ""}></div>`;
  return adminTabs("settings") + `<div class="card"><h2>Notifications</h2>
    ${sw("notify_new_challenge", "New challenge is live")}${sw("notify_approved", "Submission approved")}${sw("notify_rejected", "Submission rejected")}${sw("notify_ending", "Challenge ending reminder")}
    <div class="sw"><div><b>Reminder time</b><div class="muted">Hours before the challenge closes</div></div><input type="number" min="1" max="72" value="${s.reminder_hours}" data-set="reminder_hours" style="width:90px"></div>
    ${sw("email_enabled", "Send emails too", d.email_configured ? "Email delivery is set up." : "Email isn't set up yet, so only in-app alerts go out. See the README.")}
  </div>`;
}

async function adminAudit() {
  const d = await api("/admin/audit");
  const line = (l) => { const x = l.details || {}; return l.action === "adjust_score" ? `${x.participant}: ${x.previous} → ${x.new} (${x.difference > 0 ? "+" : ""}${x.difference}). ${x.reason}` : Object.entries(x).map(([k, v]) => `${k}: ${v}`).join(" · "); };
  return adminTabs("audit") + (d.logs.map((l) => `<div class="card flat"><div class="row between"><b>${esc(l.action.replace(/_/g, " "))}</b><span class="muted">${fmtDate(l.created_at)}</span></div><div class="muted">by ${esc(l.admin || "unknown")}${line(l) ? " · " + esc(line(l)) : ""}</div></div>`).join("") || empty("📋", "Nothing logged yet"));
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const run = async (fn) => { t.classList.add("spin"); t.disabled = true; try { await fn(); } catch (err) { toast(err.message, "bad"); t.classList.remove("spin"); t.disabled = false; } };
  if (act === "auth-mode") return authView(t.dataset.mode);
  if (act === "logout") { await api("/auth/logout", { method: "POST" }).catch(() => {}); me = null; unread = 0; return render(); }
  if (act === "reload") return render();
  if (act === "submit") return openSubmit(huntItems.find((i) => i.id == t.dataset.id));
  if (act === "zoom") { const lb = $("#lightbox"); lb.innerHTML = `<img src="${t.src}" alt="">`; lb.hidden = false; lb.onclick = () => { lb.hidden = true; }; return; }

  const card = t.closest("[data-sub]");
  if (act === "approve") return run(async () => {
    await api(`/admin/submissions/${card.dataset.sub}/approve`, { method: "POST" });
    toast("✅ Approved. Points awarded.", "good"); burst();
    if (location.hash.includes("review")) { card.classList.add("gone"); setTimeout(() => { card.remove(); if (!$(".review")) render(); }, 350); } else loadSubs();
  });
  if (act === "reject-open") { $(".rj", card).classList.toggle("hidden"); return $(".rj textarea", card).focus(); }
  if (act === "reject") return run(async () => {
    const reason = $(".rj textarea", card).value.trim();
    if (reason.length < 3) throw new Error("Give the participant a reason");
    await api(`/admin/submissions/${card.dataset.sub}/reject`, { method: "POST", json: { reason } });
    toast("Rejected. The participant has been told.");
    if (location.hash.includes("review")) { card.classList.add("gone"); setTimeout(() => { card.remove(); if (!$(".review")) render(); }, 350); } else loadSubs();
  });

  if (act === "publish") return run(async () => { await api(`/admin/challenges/${t.dataset.id}/publish`, { method: "POST" }); toast("🚀 Published", "good"); render(); });
  if (act === "unpublish") return run(async () => { await api(`/admin/challenges/${t.dataset.id}/unpublish`, { method: "POST" }); toast("Back to draft"); render(); });
  if (act === "ch-del") { if (!confirm("Are you sure? Challenges with submissions are archived instead of deleted.")) return;
    return run(async () => { const r = await api(`/admin/challenges/${t.dataset.id}`, { method: "DELETE" }); toast(r.result === "archived" ? "Archived" : "Deleted"); location.hash = "#/admin/hunts"; }); }
  if (act === "item-add") return itemForm(null, t.dataset.cid, render);
  if (act === "item-edit") { const it = JSON.parse(t.closest("[data-item]").dataset.item); return itemForm(it, it.challenge_id, render); }
  if (act === "item-del") { if (!confirm("Delete this item?")) return; return run(async () => { await api(`/admin/items/${t.dataset.id}`, { method: "DELETE" }); render(); }); }

  const u = t.closest("[data-u]") && JSON.parse(t.closest("[data-u]").dataset.u);
  if (act === "toggle-user") return run(async () => { await api(`/admin/users/${u.id}/status`, { method: "POST", json: { status: t.dataset.status } }); render(); });
  if (act === "remove-user") { if (!confirm(`Remove ${u.nickname} and all their photos? This can't be undone.`)) return; return run(async () => { await api(`/admin/users/${u.id}`, { method: "DELETE" }); toast("Removed"); render(); }); }
  if (act === "adjust") {
    const ch = window.__usersCh;
    if (!ch) return toast("No active challenge to adjust", "bad");
    const { el, close } = sheet(`<h2>Adjust score</h2><p class="muted" style="margin:6px 0 12px">${esc(u.nickname)} · ${esc(ch.title)} · now ${u.score} pts</p>
      <form class="stack" novalidate><div><label>New score</label><input name="new_score" type="number" inputmode="numeric" min="0" value="${u.score}"></div>
      <div><label>Reason (saved in the log)</label><textarea name="reason" maxlength="300"></textarea></div><div class="err hidden"></div><button class="btn block" type="submit">Save adjustment</button></form>`);
    $("form", el).addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try { await api(`/admin/users/${u.id}/adjust`, { method: "POST", json: Object.fromEntries(new FormData(ev.target)) }); close(); toast("Score adjusted and logged", "good"); render(); }
      catch (err) { const x = $(".err", el); x.textContent = err.message; x.classList.remove("hidden"); }
    });
  }
});

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "chform") return;
  e.preventDefault();
  const f = e.target, id = f.dataset.id, err = $(".err", f);
  const data = Object.fromEntries(new FormData(f));
  data.start_at = new Date(data.start_at).toISOString();
  data.end_at = new Date(data.end_at).toISOString();
  const btn = $("button[type=submit]", f);
  btn.classList.add("spin"); btn.disabled = true; err.classList.add("hidden");
  try {
    const r = await api(id ? `/admin/challenges/${id}` : "/admin/challenges", { method: id ? "PUT" : "POST", json: data });
    toast("Saved", "good");
    if (!id) location.hash = "#/admin/challenge/" + r.id; else render();
  } catch (ex) { err.textContent = ex.message; err.classList.remove("hidden"); btn.classList.remove("spin"); btn.disabled = false; }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "uq") { clearTimeout(window.__uqt); window.__uqt = setTimeout(async () => { userQuery = e.target.value; const pos = e.target.selectionStart; await render(); const n = $("#uq"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 350); }
  if (e.target.id === "sq") { clearTimeout(window.__sqt); window.__sqt = setTimeout(loadSubs, 350); }
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "sstatus" || e.target.id === "schal") return loadSubs();
  const k = e.target.dataset.set;
  if (!k) return;
  const val = e.target.type === "checkbox" ? e.target.checked : Number(e.target.value);
  try { await api("/admin/settings", { method: "PUT", json: { [k]: val } }); toast("Saved", "good"); } catch (err) { toast(err.message, "bad"); render(); }
});

/* ---------- notifications: celebrate new approvals ---------- */
async function checkAlerts() {
  if (!me || document.hidden) return;
  try {
    const m = await api("/me");
    if (!m.user) return;
    offset = m.now - Date.now();
    if (m.unread !== unread) {
      unread = m.unread;
      const nav = $(".nav a[href='#/alerts']");
      if (nav) { $(".dot", nav)?.remove(); if (unread) nav.insertAdjacentHTML("beforeend", `<span class="dot">${unread > 9 ? "9+" : unread}</span>`); }
    }
    const d = await api("/notifications");
    const last = +localStorage.getItem("lastNid") || 0;
    const fresh = d.notifications.filter((n) => !n.read && n.id > last).reverse();
    if (d.notifications[0]) localStorage.setItem("lastNid", Math.max(last, d.notifications[0].id));
    fresh.slice(-3).forEach((n) => toast(n.message, n.type === "approved" ? "good" : n.type === "rejected" ? "bad" : ""));
    if (fresh.some((n) => n.type === "approved")) { burst(); if ((location.hash || "#/") === "#/" || location.hash === "#/hunt") render(); }
  } catch {}
}

/* ---------- boot ---------- */
async function boot(afterLogin = false) {
  try {
    const d = await api("/me");
    me = d.user; unread = d.unread || 0; offset = d.now - Date.now();
  } catch { me = null; }
  if (afterLogin && !location.hash) location.hash = "#/";
  await render();
  if (me) { clearInterval(poller); poller = setInterval(checkAlerts, 30000); checkAlerts(); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkAlerts(); });
boot();
