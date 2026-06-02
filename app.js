/* Job Search CRM — vanilla JS, IndexedDB persistence, no backend. */
(() => {
  "use strict";

  const COLUMNS = [
    { id: "listings",  label: "Listings"  },
    { id: "applied",   label: "Applied"   },
    { id: "interview", label: "Interview" },
    { id: "offer",     label: "Offer"     },
    { id: "rejected",  label: "Rejected"  },
  ];
  const CONTACT_STATUSES = ["To reach out", "Reached out", "Replied", "Spoke"];
  const C_ICON = { linkedin: "↗", email: "✉", phone: "☎" };
  const contactHref = (kind, v) => !v ? "#" : kind === "email" ? "mailto:" + v : kind === "phone" ? "tel:" + v.replace(/[^\d+]/g, "") : v;
  const GREETINGS = {
    morning: [
      "Rise and shine, {name}!",
      "Good morning, {name}!",
      "Morning, {name} ☕",
      "Bright and early, {name}.",
    ],
    afternoon: [
      "Afternoon, {name}~",
      "Back to it, {name}!",
      "Good afternoon, {name}.",
      "Hope the day's treating you well, {name}.",
    ],
    evening: [
      "Hey! Evening, {name}.",
      "Keeping at it, I see ;)",
      "Evening, {name}.",
      "Winding down or ramping up, {name}?",
    ],
    night: [
      "Hey {name}, ready to burn the midnight oil?",
      "A little after-hours before getting to bed, I see.",
      "Up late, {name}?",
      "The night shift, {name}? Respect.",
    ],
    generic: [
      "Welcome back, {name}.",
      "Good to see you, {name}.",
      "Here we go, {name}.",
      "Let's find you something great, {name}.",
    ],
  };
  function timeBucket(h) {
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 21) return "evening";
    return "night";
  }
  // Date types surfaced in the to-do / reminders list, in display order.
  const DUE_TYPES = [
    { key: "deadline", label: "Deadline" },
    { key: "coverDue", label: "Cover letter" },
  ];
  const jobFollowUps = (j) => (Array.isArray(j.followUps) ? j.followUps : []);

  /* ---------------- IndexedDB ---------------- */
  // Stores: "jobs" (job records), "assets" (links + resume/cover files w/ blobs),
  //         "files" (legacy per-card uploads — migrated into assets on load).
  let db;
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("jobcrm", 2);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains("jobs")) d.createObjectStore("jobs", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files");
        if (!d.objectStoreNames.contains("assets")) d.createObjectStore("assets", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  const dbApi = {
    allJobs: () => reqP(tx("jobs", "readonly").getAll()),
    putJob: (job) => reqP(tx("jobs", "readwrite").put(job)),
    delJob: (id) => reqP(tx("jobs", "readwrite").delete(id)),
    allAssets: () => reqP(tx("assets", "readonly").getAll()),
    putAsset: (a) => reqP(tx("assets", "readwrite").put(a)),
    delAsset: (id) => reqP(tx("assets", "readwrite").delete(id)),
    allFileKeys: () => reqP(tx("files", "readonly").getAllKeys()),
    allFiles: () => reqP(tx("files", "readonly").getAll()),
    delFile: (key) => reqP(tx("files", "readwrite").delete(key)),
  };

  /* ---------------- State ---------------- */
  let jobs = [];          // in-memory mirror for snappy rendering
  let assets = [];        // {id, category:'link'|'resume'|'cover', label, url, fileName, fileType, blob, createdAt}
  let search = "";
  let view = "home";
  let sortMode = "smart";
  let filterSource = "";
  let filterTag = "";
  let showArchived = false;
  const collapsedCols = new Set(JSON.parse(localStorage.getItem("jobcrm_collapsed") || "[]"));
  let editing = null;     // job being edited in modal (or null)
  let dragId = null;
  let urlTargetId = null; // job awaiting a link in the quick-add URL prompt
  let modalContacts = []; // working copy of the open card's contacts
  let modalFollowUps = []; // working copy of the open card's follow-up dates

  const uid = (p = "j") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const fmt = (iso) => {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${+m}/${+d}/${y.slice(2)}`;
  };
  // Format a plain date (yyyy-mm-dd) or a datetime-local value (yyyy-mm-ddTHH:MM).
  const fmtWhen = (s) => {
    if (!s) return "";
    if (!s.includes("T")) return fmt(s);
    const [d, t] = s.split("T");
    let [h, mn] = t.split(":").map(Number);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${fmt(d)} ${h}:${String(mn).padStart(2, "0")} ${ap}`;
  };
  const esc = (s) =>
    (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const $ = (id) => document.getElementById(id);
  const isoOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const jobTags = (j) => (Array.isArray(j.tags) ? j.tags : []);
  const jobDues = (j) => DUE_TYPES.map((t) => (j[t.key] ? { date: j[t.key], label: t.label } : null))
    .filter(Boolean)
    .concat(j.interview ? [{ date: j.interview, label: "Interview" }] : [])
    .concat(jobFollowUps(j).filter((f) => f.date).map((f) => ({ date: f.date, label: f.action || "Follow-up" })))
    .sort((a, b) => a.date.localeCompare(b.date));
  const earliestDue = (j) => (jobDues(j)[0] ? jobDues(j)[0].date : "");

  const TAG_COLORS = ["#0052cc", "#36b37e", "#ff8b00", "#6554c0", "#00b8d9", "#de350b", "#5243aa", "#ff5630"];
  function tagColor(t) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return TAG_COLORS[h % TAG_COLORS.length];
  }

  const resumeAssets = () => assets.filter((a) => a.category === "resume");
  const coverAssets = () => assets.filter((a) => a.category === "cover");
  const linkAssets = () => assets.filter((a) => a.category === "link");
  const assetById = (id) => assets.find((a) => a.id === id);

  /* ---------------- Migration / seed ---------------- */
  async function migrateLegacyFiles() {
    const keys = await dbApi.allFileKeys();
    if (!keys.length) return;
    const vals = await dbApi.allFiles();
    for (let i = 0; i < keys.length; i++) {
      const key = String(keys[i]); // "jobId:resume" | "jobId:cover"
      const rec = vals[i];
      const sep = key.lastIndexOf(":");
      const jobId = key.slice(0, sep);
      const kind = key.slice(sep + 1); // resume | cover
      const job = jobs.find((j) => j.id === jobId);
      const asset = {
        id: uid("a"), category: kind === "cover" ? "cover" : "resume",
        label: rec.name || (kind === "cover" ? "Cover letter" : "Resume"),
        fileName: rec.name, fileType: rec.type, blob: rec.blob, createdAt: Date.now(),
      };
      assets.push(asset);
      await dbApi.putAsset(asset);
      if (job) {
        job[kind === "cover" ? "coverId" : "resumeId"] = asset.id;
        await dbApi.putJob(job);
      }
      await dbApi.delFile(keys[i]);
    }
  }

  // Old freeform "People of importance" text → preserved in Notes (contacts are now structured).
  async function migrateLegacyPeople() {
    for (const j of jobs) {
      if (j.people && j.people.trim()) {
        j.notes = (j.notes ? j.notes + "\n\n" : "") + "People of importance:\n" + j.people;
        j.people = "";
        await dbApi.putJob(j);
      }
    }
  }

  // Split the old single contact "link" into linkedin/email based on its shape.
  async function migrateContactLinks() {
    for (const j of jobs) {
      const cs = Array.isArray(j.contacts) ? j.contacts : [];
      let changed = false;
      for (const c of cs) {
        if (c.link === undefined) continue;
        const v = (c.link || "").trim();
        if (v && c.email === undefined && /@/.test(v) && !/^https?:|linkedin\.com/i.test(v)) c.email = v;
        else if (v && c.linkedin === undefined) c.linkedin = v;
        delete c.link;
        changed = true;
      }
      if (changed) await dbApi.putJob(j);
    }
  }

  // Fold the old single followUp date and the freeform "Key dates" text into the followUps list.
  async function migrateFollowUps() {
    for (const j of jobs) {
      if (Array.isArray(j.followUps)) continue;
      if (j.followUp === undefined && j.dates === undefined) continue;
      const list = [];
      if (j.followUp) list.push({ date: j.followUp, action: "" });
      if (j.dates && j.dates.trim()) list.push({ date: "", action: j.dates.trim() });
      j.followUps = list;
      delete j.followUp;
      delete j.dates;
      await dbApi.putJob(j);
    }
  }

  async function seedDefaultLinks() {
    if (localStorage.getItem("jobcrm_seeded")) return;
    localStorage.setItem("jobcrm_seeded", "1");
    if (linkAssets().length) return;
    for (const label of ["Personal Website", "LinkedIn", "GitHub"]) {
      const a = { id: uid("a"), category: "link", label, url: "", createdAt: Date.now() };
      assets.push(a);
      await dbApi.putAsset(a);
    }
  }

  /* ---------------- View switching ---------------- */
  function setView(v) {
    view = v;
    const onBoard = v === "board";
    $("homeView").hidden = v !== "home";
    $("boardToolbar").hidden = !onBoard;
    $("board").hidden = !onBoard;
    $("remindersView").hidden = v !== "reminders";
    $("assetsView").hidden = v !== "assets";
    $("boardActions").style.display = onBoard ? "" : "none";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    if (v === "home") renderHome();
    if (v === "assets") renderAssets();
    if (v === "reminders") renderReminders();
  }

  /* ---------------- Board rendering ---------------- */
  const board = document.getElementById("board");

  function visible(job) {
    if (!showArchived && job.archived) return false;
    if (filterSource && (job.source || "") !== filterSource) return false;
    if (filterTag && !jobTags(job).includes(filterTag)) return false;
    if (search) {
      const contactsText = (Array.isArray(job.contacts) ? job.contacts : []).map((c) => `${c.name || ""} ${c.title || ""} ${c.email || ""} ${c.phone || ""}`).join(" ");
      const followUpsText = jobFollowUps(job).map((f) => f.action || "").join(" ");
      const hay = [job.role, job.company, job.location, job.source, contactsText, job.notes, followUpsText, jobTags(job).join(" ")]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }

  function sortJobs(list) {
    switch (sortMode) {
      case "applied":  return list.sort((a, b) => (b.dateApplied || "").localeCompare(a.dateApplied || ""));
      case "listed":   return list.sort((a, b) => (b.dateListed || "").localeCompare(a.dateListed || ""));
      case "deadline": return list.sort((a, b) => (earliestDue(a) || "9999").localeCompare(earliestDue(b) || "9999"));
      case "company":  return list.sort((a, b) => (a.company || "").localeCompare(b.company || ""));
      default:         return list.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    }
  }

  function fillFilter(sel, vals, cur) {
    const val = vals.includes(cur) ? cur : "";
    sel.innerHTML = `<option value="">All</option>` +
      vals.map((v) => `<option value="${esc(v)}"${v === val ? " selected" : ""}>${esc(v)}</option>`).join("");
    return val;
  }
  function refreshFilters() {
    const pool = jobs.filter((j) => showArchived || !j.archived);
    filterSource = fillFilter($("sourceFilter"), [...new Set(pool.map((j) => j.source).filter(Boolean))].sort(), filterSource);
    filterTag = fillFilter($("tagFilter"), [...new Set(pool.flatMap(jobTags))].sort(), filterTag);
  }

  function render() {
    refreshFilters();
    updateDueBadge();
    if (view === "home") renderHome();
    if (view === "reminders") renderReminders();
    board.innerHTML = "";
    for (const col of COLUMNS) {
      const list = sortJobs(jobs.filter((j) => j.status === col.id && visible(j)));
      const collapsed = collapsedCols.has(col.id);

      const colEl = document.createElement("section");
      colEl.className = "column" + (collapsed ? " collapsed" : "");
      colEl.dataset.status = col.id;

      if (collapsed) {
        colEl.innerHTML = `
          <div class="column-head">
            <button class="col-collapse icon-btn" aria-label="Expand column">+</button>
            <span class="col-count">${list.length}</span>
            <span class="col-vlabel"><span class="col-dot"></span>${col.label}</span>
          </div>`;
        colEl.querySelector(".column-head").addEventListener("click", () => toggleCollapse(col.id));
      } else {
        colEl.innerHTML = `
          <div class="column-head">
            <span class="col-title"><span class="col-dot"></span>${col.label}</span>
            <span class="col-right"><span class="col-count">${list.length}</span>
              <button class="col-collapse icon-btn" aria-label="Collapse column">–</button></span>
          </div>
          <div class="column-body" data-status="${col.id}"></div>`;
        colEl.querySelector(".col-collapse").addEventListener("click", () => toggleCollapse(col.id));
        const body = colEl.querySelector(".column-body");
        if (!list.length) {
          const hint = document.createElement("div");
          hint.className = "empty-hint";
          hint.textContent = search ? "No matches" : "Drop cards here";
          body.appendChild(hint);
        }
        for (const job of list) body.appendChild(cardEl(job));
        body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
        body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
        body.addEventListener("drop", (e) => {
          e.preventDefault();
          body.classList.remove("drag-over");
          if (dragId) moveJob(dragId, col.id);
        });
      }

      // Collapsed columns still accept drops so you can file a card into them.
      colEl.addEventListener("dragover", (e) => { if (collapsed) { e.preventDefault(); colEl.classList.add("drag-over"); } });
      colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
      colEl.addEventListener("drop", (e) => {
        if (!collapsed) return;
        e.preventDefault();
        colEl.classList.remove("drag-over");
        if (dragId) moveJob(dragId, col.id);
      });

      board.appendChild(colEl);
    }
  }

  function toggleCollapse(status) {
    if (collapsedCols.has(status)) collapsedCols.delete(status);
    else collapsedCols.add(status);
    localStorage.setItem("jobcrm_collapsed", JSON.stringify([...collapsedCols]));
    render();
  }

  function cardEl(job) {
    const el = document.createElement("article");
    el.className = "card" + ((job.priority || 0) >= 4 ? " prio-high" : "") + (job.archived ? " archived" : "");
    el.draggable = true;
    el.dataset.id = job.id;

    const meta = [];
    if (job.dateListed) meta.push(`<span class="tag">listed ${fmt(job.dateListed)}</span>`);
    if (job.dateApplied) meta.push(`<span class="tag">applied ${fmt(job.dateApplied)}</span>`);
    if (job.location) meta.push(`<span class="tag">${esc(job.location)}</span>`);
    const resume = job.resumeId && assetById(job.resumeId);
    if (resume) meta.push(`<span class="tag">📄 ${esc(resume.label)}</span>`);

    const stars = job.priority ? `<div class="card-stars">${"★".repeat(job.priority)}</div>` : "";

    let flags = "";
    if (job.status !== "rejected") {
      const next = jobDues(job)[0];
      if (next) {
        const overdue = next.date <= todayISO() && job.status !== "offer";
        flags = `<div class="card-flags${overdue ? " flag-due" : ""}">⚑ ${next.label.toLowerCase()}${overdue ? " due" : " " + fmtWhen(next.date)}</div>`;
      }
    }

    const tags = jobTags(job);
    const chips = tags.length
      ? `<div class="card-tags">${tags.map((t) => `<span class="chip" style="background:${tagColor(t)}">${esc(t)}</span>`).join("")}</div>`
      : "";

    el.innerHTML = `
      <div class="card-role">${esc(job.role) || "Untitled"}</div>
      <div class="card-company">${esc(job.company) || ""}</div>
      ${meta.length ? `<div class="card-meta">${meta.join("")}</div>` : ""}
      ${chips}${stars}${flags}`;

    el.addEventListener("click", () => openModal(job));
    el.addEventListener("dragstart", () => { dragId = job.id; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => { dragId = null; el.classList.remove("dragging"); });
    return el;
  }

  async function moveJob(id, status) {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status === status) return;
    job.status = status;
    job.updatedAt = Date.now();
    if (status === "applied" && !job.dateApplied) job.dateApplied = todayISO();
    await dbApi.putJob(job);
    render();
  }

  async function quickAdd(text) {
    text = text.trim();
    if (!text) return;
    let role = text, company = "";
    const at = text.indexOf("@");
    if (at >= 0) { role = text.slice(0, at).trim(); company = text.slice(at + 1).trim(); }
    const job = {
      id: uid(), createdAt: Date.now(), updatedAt: Date.now(), status: "listings",
      dateListed: "", role: role || "Untitled", company, priority: 0, tags: [],
    };
    await dbApi.putJob(job);
    jobs.push(job);
    render();
    openUrlModal(job);
  }

  // Parse the "Role @ Company" quick-add syntax from the search bar. Null if no "@".
  function parseQuickAdd(text) {
    text = (text || "").trim();
    const at = text.indexOf("@");
    if (at < 0) return null;
    const role = text.slice(0, at).trim();
    const company = text.slice(at + 1).trim();
    if (!role && !company) return null;
    return { role, company };
  }

  function updateSearchHint(text) {
    const qa = parseQuickAdd(text);
    const hint = $("searchHint");
    if (qa) {
      hint.innerHTML = `<strong>↵ Add</strong> “${esc(qa.role || "Untitled")}”` +
        (qa.company ? ` <span class="muted">at</span> “${esc(qa.company)}”` : "");
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  async function quickAddFromSearch() {
    const qa = parseQuickAdd($("searchInput").value);
    if (!qa) return;
    $("searchInput").value = "";
    search = "";
    $("searchHint").hidden = true;
    await quickAdd((qa.role || "Untitled") + (qa.company ? " @ " + qa.company : ""));
  }

  function openUrlModal(job) {
    urlTargetId = job.id;
    $("urlModalSub").textContent = job.role + (job.company ? " @ " + job.company : "");
    $("urlInput").value = "";
    $("urlModal").hidden = false;
    $("urlInput").focus();
  }
  function closeUrlModal() { $("urlModal").hidden = true; urlTargetId = null; }
  async function saveUrl() {
    const job = jobs.find((j) => j.id === urlTargetId);
    const url = $("urlInput").value.trim();
    if (job && url) { job.link = url; job.updatedAt = Date.now(); await dbApi.putJob(job); render(); }
    closeUrlModal();
  }

  /* GitHub-style applications-per-day heatmap (last 53 weeks). */
  function activityGrid() {
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DAYNAMES = ["", "Mon", "", "Wed", "", "Fri", ""];
    const counts = {};
    jobs.forEach((j) => { if (j.dateApplied) counts[j.dateApplied] = (counts[j.dateApplied] || 0) + 1; });

    const WEEKS = 53;
    const todayStr = todayISO();
    const today = new Date(todayStr + "T00:00:00Z");
    const startMs = today.getTime() - ((WEEKS - 1) * 7 + today.getUTCDay()) * 86400000; // back to a Sunday

    let cells = "", months = "", total = 0, prevMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const m = new Date(startMs + w * 7 * 86400000).getUTCMonth();
      months += `<span>${m !== prevMonth ? MONTHS[m] : ""}</span>`;
      prevMonth = m;
      for (let d = 0; d < 7; d++) {
        const iso = new Date(startMs + (w * 7 + d) * 86400000).toISOString().slice(0, 10);
        if (iso > todayStr) { cells += `<span class="gh-cell" data-lvl="f"></span>`; continue; }
        const n = counts[iso] || 0;
        total += n;
        const lvl = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4;
        cells += `<span class="gh-cell" data-lvl="${lvl}" data-tip="${n} application${n === 1 ? "" : "s"} · ${fmt(iso)}"></span>`;
      }
    }
    return `
      <h2>Application activity <span class="count">${total}</span></h2>
      <div class="gh">
        <div class="gh-body">
          <div class="gh-corner"></div>
          <div class="gh-months">${months}</div>
          <div class="gh-days">${DAYNAMES.map((d) => `<span>${d}</span>`).join("")}</div>
          <div class="gh-grid">${cells}</div>
        </div>
        <div class="gh-legend">Less <span class="gh-cell" data-lvl="0"></span><span class="gh-cell" data-lvl="1"></span><span class="gh-cell" data-lvl="2"></span><span class="gh-cell" data-lvl="3"></span><span class="gh-cell" data-lvl="4"></span> More</div>
      </div>`;
  }

  /* ---------------- Home / dashboard ---------------- */
  function renderHome() {
    const active = jobs.filter((j) => !j.archived);
    const counts = {};
    COLUMNS.forEach((c) => { counts[c.id] = 0; });
    active.forEach((j) => { counts[j.status] = (counts[j.status] || 0) + 1; });
    const weekAgo = isoOffset(-7);
    const appliedThisWeek = active.filter((j) => j.dateApplied && j.dateApplied >= weekAgo).length;
    const everApplied = active.filter((j) => j.dateApplied || ["applied", "interview", "offer", "rejected"].includes(j.status)).length;
    const responses = active.filter((j) => ["interview", "offer"].includes(j.status)).length;
    const rate = everApplied ? Math.round((responses / everApplied) * 100) : 0;
    const tiles = [
      ["Active", active.length],
      ["Applied this week", appliedThisWeek],
      ["Interviewing", counts.interview || 0],
      ["Offers", counts.offer || 0],
      ["Response rate", rate + "%"],
    ];

    const maxC = Math.max(1, ...COLUMNS.map((c) => counts[c.id]));
    const pipeline = COLUMNS.map((c) => `
      <div class="pipe-row">
        <span class="pipe-label">${c.label}</span>
        <span class="pipe-bar"><span class="pipe-fill" data-status="${c.id}" style="width:${(counts[c.id] / maxC) * 100}%"></span></span>
        <span class="pipe-n">${counts[c.id]}</span>
      </div>`).join("");

    const today = todayISO(), horizon = isoOffset(7);
    const soon = dueItems().filter((it) => it.date <= horizon);
    const comingUp = soon.length
      ? soon.map((it) => `
        <div class="rem-row" data-id="${it.job.id}">
          <span class="rem-date${it.date < today ? " overdue-d" : ""}">${fmtWhen(it.date)}</span>
          <span class="rem-type">${it.type}</span>
          <span class="rem-title">${esc(it.job.role)} <span class="muted">@ ${esc(it.job.company)}</span></span>
          <span class="rem-status">${it.job.status}</span>
        </div>`).join("")
      : `<div class="list-empty">Nothing due in the next 7 days.</div>`;

    $("homeView").innerHTML = `
      <h2>Overview</h2>
      <div class="home-stats">${tiles.map(([l, v]) => `<div class="stat"><div class="stat-v">${v}</div><div class="stat-l">${l}</div></div>`).join("")}</div>
      <h2>Pipeline</h2>
      ${pipeline}
      ${activityGrid()}
      <h2>Coming up <span class="count">${soon.length}</span></h2>
      ${comingUp}`;

    $("homeView").querySelectorAll(".rem-row").forEach((el) =>
      el.addEventListener("click", () => { const j = jobs.find((x) => x.id === el.dataset.id); if (j) openModal(j); }));

    const grid = $("homeView").querySelector(".gh-grid");
    if (grid) {
      grid.addEventListener("mouseover", (e) => {
        const cell = e.target.closest(".gh-cell[data-tip]");
        if (cell) showGhTip(cell);
      });
      grid.addEventListener("mouseout", (e) => {
        if (e.target.closest(".gh-cell")) hideGhTip();
      });
    }
  }

  let ghTipEl = null;
  function showGhTip(cell) {
    if (!ghTipEl) {
      ghTipEl = document.createElement("div");
      ghTipEl.className = "gh-tip";
      document.body.appendChild(ghTipEl);
    }
    ghTipEl.textContent = cell.dataset.tip;
    const r = cell.getBoundingClientRect();
    ghTipEl.style.display = "block";
    ghTipEl.style.left = r.left + r.width / 2 + "px";
    ghTipEl.style.top = r.top - 6 + "px";
  }
  function hideGhTip() { if (ghTipEl) ghTipEl.style.display = "none"; }

  /* ---------------- Reminders ---------------- */
  function dueItems() {
    const out = [];
    for (const j of jobs) {
      if (j.archived || j.status === "rejected") continue;
      for (const t of DUE_TYPES) {
        if (!j[t.key]) continue;
        if (t.key === "deadline" && j.dateApplied) continue; // already applied → deadline no longer a task
        out.push({ job: j, date: j[t.key], type: t.label });
      }
      if (j.interview) out.push({ job: j, date: j.interview, type: "Interview" });
      for (const f of jobFollowUps(j)) {
        if (f.date) out.push({ job: j, date: f.date, type: f.action || "Follow-up" });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function updateDueBadge() {
    const horizon = isoOffset(7);
    const n = dueItems().filter((it) => it.date <= horizon).length;
    const b = $("dueBadge");
    if (n) { b.textContent = n; b.hidden = false; } else { b.hidden = true; }
  }

  function renderReminders() {
    const items = dueItems();
    const v = $("remindersView");
    if (!items.length) {
      v.innerHTML = `<div class="list-empty">No follow-ups or deadlines set. Add a “Next follow-up” or “Deadline” date in a card to see it here.</div>`;
      return;
    }
    const today = todayISO(), horizon = isoOffset(7);
    const groups = { Overdue: [], "This week": [], Later: [] };
    for (const it of items) {
      if (it.date < today) groups.Overdue.push(it);
      else if (it.date <= horizon) groups["This week"].push(it);
      else groups.Later.push(it);
    }
    const rowHtml = (it) => `
      <div class="rem-row" data-id="${it.job.id}">
        <span class="rem-date">${fmtWhen(it.date)}</span>
        <span class="rem-type">${it.type}</span>
        <span class="rem-title">${esc(it.job.role)} <span class="muted">@ ${esc(it.job.company)}</span></span>
        <span class="rem-status">${it.job.status}</span>
      </div>`;
    v.innerHTML = Object.entries(groups).map(([name, arr]) => arr.length ? `
      <div class="rem-group ${name === "Overdue" ? "overdue" : ""}">
        <h3>${name} <span class="count">${arr.length}</span></h3>
        ${arr.map(rowHtml).join("")}
      </div>` : "").join("");
    v.querySelectorAll(".rem-row").forEach((el) =>
      el.addEventListener("click", () => { const j = jobs.find((x) => x.id === el.dataset.id); if (j) openModal(j); }));
  }

  /* ---------------- Assets view rendering ---------------- */
  function downloadAsset(asset) {
    if (!asset || !asset.blob) return;
    const url = URL.createObjectURL(asset.blob);
    const a = document.createElement("a");
    a.href = url; a.download = asset.fileName || asset.label || "file"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderAssets() {
    const v = $("assetsView");
    v.innerHTML = `
      <div class="asset-section" id="sec-link">
        <div class="asset-section-head"><h2>Links</h2>
          <button class="btn small" data-add="link">+ Add link</button></div>
        <div class="asset-list" data-cat="link"></div>
      </div>
      <div class="asset-section" id="sec-resume">
        <div class="asset-section-head"><h2>Resumes</h2>
          <button class="btn small" data-add="resume">+ Upload resume</button></div>
        <div class="asset-list" data-cat="resume"></div>
      </div>
      <div class="asset-section" id="sec-cover">
        <div class="asset-section-head"><h2>Cover Letters</h2>
          <button class="btn small" data-add="cover">+ Upload cover letter</button></div>
        <div class="asset-list" data-cat="cover"></div>
      </div>
      <input type="file" id="assetFileInput" hidden />`;

    renderAssetList("link");
    renderAssetList("resume");
    renderAssetList("cover");

    v.querySelectorAll("[data-add]").forEach((btn) => {
      btn.addEventListener("click", () => addAsset(btn.dataset.add));
    });
  }

  function renderAssetList(cat) {
    const wrap = $("assetsView").querySelector(`.asset-list[data-cat="${cat}"]`);
    const list = assets.filter((a) => a.category === cat);
    wrap.innerHTML = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "asset-empty";
      e.textContent = cat === "link" ? "No links yet." : "Nothing uploaded yet.";
      wrap.appendChild(e);
      return;
    }
    for (const a of list) wrap.appendChild(cat === "link" ? linkRow(a) : fileRow(a));
  }

  function linkRow(a) {
    const row = document.createElement("div");
    row.className = "asset-row";
    row.innerHTML = `
      <input class="a-label" value="${esc(a.label)}" placeholder="Label" />
      <input class="a-url" value="${esc(a.url || "")}" placeholder="https://…" />
      <a class="btn small a-open" target="_blank" rel="noopener" ${a.url ? "" : "hidden"}>Open ↗</a>
      <button class="icon-btn a-del" aria-label="Delete">&times;</button>`;
    const labelI = row.querySelector(".a-label");
    const urlI = row.querySelector(".a-url");
    const open = row.querySelector(".a-open");
    const save = async () => {
      a.label = labelI.value.trim() || "Untitled";
      a.url = urlI.value.trim();
      open.href = a.url; open.hidden = !a.url;
      await dbApi.putAsset(a);
    };
    labelI.addEventListener("change", save);
    urlI.addEventListener("change", () => { save(); });
    urlI.addEventListener("input", () => { open.href = urlI.value.trim(); open.hidden = !urlI.value.trim(); });
    open.href = a.url || "#";
    row.querySelector(".a-del").addEventListener("click", () => removeAsset(a));
    return row;
  }

  function fileRow(a) {
    const row = document.createElement("div");
    row.className = "asset-row";
    row.innerHTML = `
      <input class="a-name a-grow" value="${esc(a.label)}" placeholder="Label" />
      <span class="hint" style="margin:0;white-space:nowrap">${esc(a.fileName || "")}</span>
      <button class="btn small a-dl">Download</button>
      <button class="btn small a-rep">Replace</button>
      <button class="icon-btn a-del" aria-label="Delete">&times;</button>`;
    const nameI = row.querySelector(".a-name");
    nameI.addEventListener("change", async () => { a.label = nameI.value.trim() || a.fileName || "File"; await dbApi.putAsset(a); render(); });
    row.querySelector(".a-dl").addEventListener("click", () => downloadAsset(a));
    row.querySelector(".a-rep").addEventListener("click", () => replaceAssetFile(a));
    row.querySelector(".a-del").addEventListener("click", () => removeAsset(a));
    return row;
  }

  async function addAsset(cat) {
    if (cat === "link") {
      const a = { id: uid("a"), category: "link", label: "New link", url: "", createdAt: Date.now() };
      assets.push(a);
      await dbApi.putAsset(a);
      renderAssetList("link");
      return;
    }
    // resume / cover: pick a file
    const input = $("assetFileInput");
    input.onchange = async () => {
      const f = input.files[0];
      input.value = "";
      if (!f) return;
      const a = {
        id: uid("a"), category: cat, label: f.name.replace(/\.[^.]+$/, ""),
        fileName: f.name, fileType: f.type, blob: f, createdAt: Date.now(),
      };
      assets.push(a);
      await dbApi.putAsset(a);
      renderAssetList(cat);
    };
    input.click();
  }

  async function replaceAssetFile(a) {
    const input = $("assetFileInput");
    input.onchange = async () => {
      const f = input.files[0];
      input.value = "";
      if (!f) return;
      a.fileName = f.name; a.fileType = f.type; a.blob = f;
      await dbApi.putAsset(a);
      renderAssetList(a.category);
    };
    input.click();
  }

  async function removeAsset(a) {
    const refs = jobs.filter((j) => j.resumeId === a.id || j.coverId === a.id).length;
    const extra = refs ? `\nIt is attached to ${refs} job${refs > 1 ? "s" : ""}; those will be cleared.` : "";
    if (!confirm(`Delete "${a.label}"?${extra}`)) return;
    await dbApi.delAsset(a.id);
    assets = assets.filter((x) => x.id !== a.id);
    for (const j of jobs) {
      let changed = false;
      if (j.resumeId === a.id) { j.resumeId = ""; changed = true; }
      if (j.coverId === a.id) { j.coverId = ""; changed = true; }
      if (changed) await dbApi.putJob(j);
    }
    renderAssetList(a.category);
    render();
  }

  /* ---------------- Job modal ---------------- */
  const modal = document.getElementById("modal");
  const fields = {
    id: $("f_id"), role: $("f_role"), company: $("f_company"), status: $("f_status"),
    dateListed: $("f_dateListed"), dateApplied: $("f_dateApplied"), link: $("f_link"),
    location: $("f_location"), salary: $("f_salary"), source: $("f_source"),
    deadline: $("f_deadline"), interview: $("f_interview"), coverDue: $("f_coverDue"), hasCover: $("f_hasCover"),
    resumeId: $("f_resumeId"), coverId: $("f_coverId"),
    tags: $("f_tags"), notes: $("f_notes"),
  };
  const starsEl = $("f_priority");

  function setStars(v) {
    starsEl.dataset.value = v;
    starsEl.querySelectorAll("span").forEach((s) => s.classList.toggle("on", +s.dataset.v <= v));
  }

  function fillAssetSelect(sel, list, current) {
    sel.innerHTML = `<option value="">— None —</option>` +
      list.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join("");
    sel.value = current && list.some((a) => a.id === current) ? current : "";
  }

  function renderContacts() {
    const wrap = $("contactsList");
    if (!modalContacts.length) { wrap.innerHTML = `<div class="hint" style="margin:0">No contacts yet — add the hiring manager, a recruiter, or a future peer.</div>`; return; }
    const reach = (i, c, kind, ph) => {
      const v = c[kind] || "";
      return `<div class="link-row">
        <input data-i="${i}" data-f="${kind}" placeholder="${ph}" value="${esc(v)}" />
        <a class="btn small c-open" data-k="${kind}" target="_blank" rel="noopener" href="${esc(contactHref(kind, v))}"${v ? "" : " hidden"}>${C_ICON[kind]}</a>
      </div>`;
    };
    wrap.innerHTML = modalContacts.map((c, i) => `
      <div class="contact-row">
        <div class="contact-line">
          <input data-i="${i}" data-f="name"  placeholder="Name" value="${esc(c.name || "")}" />
          <input data-i="${i}" data-f="title" placeholder="Title / role" value="${esc(c.title || "")}" />
          <select data-i="${i}" data-f="status">
            ${CONTACT_STATUSES.map((s) => `<option${(c.status || CONTACT_STATUSES[0]) === s ? " selected" : ""}>${s}</option>`).join("")}
          </select>
          <button type="button" class="icon-btn c-del" data-i="${i}" aria-label="Remove contact">&times;</button>
        </div>
        <div class="contact-line2">
          ${reach(i, c, "linkedin", "LinkedIn URL")}
          ${reach(i, c, "email", "Email")}
          ${reach(i, c, "phone", "Phone")}
        </div>
      </div>`).join("");
  }

  // Build a pre-filled LinkedIn people-search URL from company + role + hiring titles.
  function linkedInSearchUrl(company, role) {
    const titles = ['"recruiter"', '"talent acquisition"', '"hiring manager"'];
    if (role) titles.push(`"${role}"`);
    const q = `"${company}" AND (${titles.join(" OR ")})`;
    return "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent(q) + "&origin=FACETED_SEARCH";
  }

  function updateFindContacts() {
    const company = fields.company.value.trim();
    const btn = $("findContacts");
    if (company) { btn.href = linkedInSearchUrl(company, fields.role.value.trim()); btn.hidden = false; }
    else { btn.hidden = true; }
  }

  function addContact() {
    modalContacts.push({ name: "", title: "", linkedin: "", email: "", phone: "", status: CONTACT_STATUSES[0] });
    renderContacts();
    const inputs = $("contactsList").querySelectorAll('input[data-f="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function renderFollowUps() {
    const wrap = $("followUpsList");
    if (!modalFollowUps.length) { wrap.innerHTML = `<div class="hint" style="margin:0">No follow-ups yet — add a date and what you plan to do.</div>`; return; }
    wrap.innerHTML = modalFollowUps.map((f, i) => `
      <div class="followup-row">
        <input type="date" data-i="${i}" data-f="date" value="${esc(f.date || "")}" />
        <input data-i="${i}" data-f="action" placeholder="What to do — e.g. email recruiter" value="${esc(f.action || "")}" />
        <button type="button" class="icon-btn f-del" data-i="${i}" aria-label="Remove follow-up">&times;</button>
      </div>`).join("");
  }

  function addFollowUp() {
    modalFollowUps.push({ date: "", action: "" });
    renderFollowUps();
    const dates = $("followUpsList").querySelectorAll('input[data-f="date"]');
    if (dates.length) dates[dates.length - 1].focus();
  }

  function toggleCoverFields() {
    $("coverFields").hidden = !fields.hasCover.checked;
  }

  function updateDlBtn(kind) {
    const sel = kind === "resume" ? fields.resumeId : fields.coverId;
    const btn = $(kind === "resume" ? "resumeDl" : "coverDl");
    const a = assetById(sel.value);
    if (a && a.blob) { btn.hidden = false; btn.onclick = (e) => { e.preventDefault(); downloadAsset(a); }; }
    else btn.hidden = true;
  }

  function openModal(job) {
    editing = job || null;
    const j = job || {};
    fields.id.value = j.id || "";
    fields.role.value = j.role || "";
    fields.company.value = j.company || "";
    fields.status.value = j.status || "listings";
    fields.dateListed.value = j.dateListed || "";
    fields.dateApplied.value = j.dateApplied || "";
    fields.link.value = j.link || "";
    fields.location.value = j.location || "";
    fields.salary.value = j.salary || "";
    fields.source.value = j.source || "";
    fields.deadline.value = j.deadline || "";
    fields.interview.value = j.interview || "";
    fields.coverDue.value = j.coverDue || "";
    fields.hasCover.checked = !!(j.coverDue || j.coverId); // default off; on if the job already has cover data
    toggleCoverFields();
    fields.tags.value = jobTags(j).join(", ");
    modalContacts = (Array.isArray(j.contacts) ? j.contacts : []).map((c) => ({ ...c }));
    renderContacts();
    updateFindContacts();
    modalFollowUps = jobFollowUps(j).map((f) => ({ ...f }));
    renderFollowUps();
    fields.notes.value = j.notes || "";
    setStars(j.priority || 0);
    updateLinkBtn();

    const ab = $("archiveBtn");
    if (job) { ab.style.display = ""; ab.textContent = j.archived ? "Unarchive" : "Archive"; }
    else ab.style.display = "none";

    fillAssetSelect(fields.resumeId, resumeAssets(), j.resumeId);
    fillAssetSelect(fields.coverId, coverAssets(), j.coverId);
    updateDlBtn("resume");
    updateDlBtn("cover");

    $("modalTitle").textContent = job ? `${j.role || "Job"} — ${j.company || ""}` : "Add job";
    $("deleteBtn").style.visibility = job ? "visible" : "hidden";

    modal.hidden = false;
    fields.role.focus();
  }

  function closeModal() { modal.hidden = true; editing = null; }

  function updateLinkBtn() {
    const a = $("openLink");
    const url = fields.link.value.trim();
    if (url) { a.href = url; a.hidden = false; } else { a.hidden = true; }
  }

  async function saveJob(e) {
    e.preventDefault();
    if (!fields.role.value.trim() || !fields.company.value.trim()) return;
    const isNew = !fields.id.value;
    const job = isNew ? { id: uid(), createdAt: Date.now() } : jobs.find((j) => j.id === fields.id.value);

    Object.assign(job, {
      role: fields.role.value.trim(),
      company: fields.company.value.trim(),
      status: fields.status.value,
      dateListed: fields.dateListed.value,
      dateApplied: fields.dateApplied.value,
      link: fields.link.value.trim(),
      location: fields.location.value.trim(),
      salary: fields.salary.value.trim(),
      source: fields.source.value.trim(),
      priority: +starsEl.dataset.value || 0,
      deadline: fields.deadline.value,
      interview: fields.interview.value,
      coverDue: fields.hasCover.checked ? fields.coverDue.value : "",
      resumeId: fields.resumeId.value,
      coverId: fields.hasCover.checked ? fields.coverId.value : "",
      tags: fields.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      contacts: modalContacts.filter((c) => c.name || c.title || c.linkedin || c.email || c.phone),
      followUps: modalFollowUps.filter((f) => f.date || f.action),
      notes: fields.notes.value,
      updatedAt: Date.now(),
    });
    if (job.status === "applied" && !job.dateApplied) job.dateApplied = todayISO();
    if (job.status === "listings" && job.dateApplied) job.status = "applied"; // setting an applied date promotes a listing

    await dbApi.putJob(job);
    if (isNew) jobs.push(job);
    closeModal();
    render();
  }

  async function deleteJob() {
    if (!editing) return;
    if (!confirm(`Delete "${editing.role} — ${editing.company}"? This cannot be undone.`)) return;
    await dbApi.delJob(editing.id);
    jobs = jobs.filter((j) => j.id !== editing.id);
    closeModal();
    render();
  }

  async function toggleArchive() {
    if (!editing) return;
    editing.archived = !editing.archived;
    editing.updatedAt = Date.now();
    await dbApi.putJob(editing);
    closeModal();
    render();
  }

  /* ---------------- Export / Import ---------------- */
  async function exportData() {
    const out = { jobs, assets: [], exportedAt: new Date().toISOString() };
    for (const a of assets) {
      const copy = { ...a };
      if (a.blob) { copy.data = await blobToB64(a.blob); delete copy.blob; }
      out.assets.push(copy);
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jobcrm-backup-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    localStorage.setItem("jobcrm_last_export", todayISO());
    updateExportReminder();
  }

  // Nudge a daily backup: show the banner unless an export (or "Later") happened today.
  function updateExportReminder() {
    const banner = $("exportReminder");
    if (!banner) return;
    const last = localStorage.getItem("jobcrm_last_export");
    const snoozed = localStorage.getItem("jobcrm_export_snooze");
    if (!jobs.length || last === todayISO() || snoozed === todayISO()) { banner.hidden = true; return; }
    $("exportReminderText").textContent = last
      ? `Back up your data — last export was ${fmt(last)}.`
      : "Back up your data — you haven't exported yet.";
    banner.hidden = false;
  }

  async function importData(file) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch { alert("Invalid JSON file."); return; }
    if (!Array.isArray(data.jobs)) { alert("Not a valid backup."); return; }
    if (!confirm(`Import ${data.jobs.length} jobs and ${(data.assets || []).length} assets? This merges into your current data.`)) return;
    for (const job of data.jobs) await dbApi.putJob(job);
    for (const a of (data.assets || [])) {
      const rec = { ...a };
      if (rec.data) { rec.blob = b64ToBlob(rec.data, rec.fileType); delete rec.data; }
      await dbApi.putAsset(rec);
    }
    jobs = await dbApi.allJobs();
    assets = await dbApi.allAssets();
    render();
    if (view === "assets") renderAssets();
  }

  function blobToB64(blob) {
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(blob); });
  }
  function b64ToBlob(b64, type) {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: type || "application/octet-stream" });
  }

  /* ---------------- Greeting ---------------- */
  function getName() {
    return (localStorage.getItem("jobcrm_name") || "").trim();
  }
  function refreshTitle() {
    const el = $("appTitle");
    if (!el) return;
    const name = getName();
    if (!name) { el.textContent = "Hey, good to see you!"; return; }
    // Mix this time-of-day's lines with the generics, then pick one.
    const pool = GREETINGS[timeBucket(new Date().getHours())].concat(GREETINGS.generic);
    el.textContent = pool[Math.floor(Math.random() * pool.length)].replace("{name}", name);
  }
  function askName() {
    const input = prompt("What's your first name?", getName());
    if (input === null) return; // cancelled — leave as-is
    const name = input.trim();
    if (name) localStorage.setItem("jobcrm_name", name);
    else localStorage.removeItem("jobcrm_name");
    refreshTitle();
  }

  /* ---------------- Events ---------------- */
  function wire() {
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
    $("appTitle").addEventListener("click", askName);

    $("addBtn").addEventListener("click", () => openModal(null));
    $("sortSelect").addEventListener("change", (e) => { sortMode = e.target.value; render(); });
    $("sourceFilter").addEventListener("change", (e) => { filterSource = e.target.value; render(); });
    $("tagFilter").addEventListener("change", (e) => { filterTag = e.target.value; render(); });
    $("archivedToggle").addEventListener("change", (e) => { showArchived = e.target.checked; render(); });

    $("closeModal").addEventListener("click", closeModal);
    $("cancelBtn").addEventListener("click", closeModal);
    $("deleteBtn").addEventListener("click", deleteJob);
    $("archiveBtn").addEventListener("click", toggleArchive);
    $("jobForm").addEventListener("submit", saveJob);
    $("jobForm").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); $("jobForm").requestSubmit(); } // Cmd/Ctrl+Enter saves
      else if (e.target.tagName !== "TEXTAREA") e.preventDefault(); // plain Enter never submits (textareas keep newlines)
    });
    fields.link.addEventListener("input", updateLinkBtn);
    fields.resumeId.addEventListener("change", () => updateDlBtn("resume"));
    fields.coverId.addEventListener("change", () => updateDlBtn("cover"));
    $("gotoAssets").addEventListener("click", (e) => { e.preventDefault(); closeModal(); setView("assets"); });

    // Contacts editor (delegated — rows are re-rendered)
    $("addContact").addEventListener("click", addContact);
    fields.company.addEventListener("input", updateFindContacts);
    fields.role.addEventListener("input", updateFindContacts);
    const contactsList = $("contactsList");
    const syncContact = (e) => {
      const t = e.target, i = +t.dataset.i, f = t.dataset.f;
      if (f == null || !modalContacts[i]) return;
      modalContacts[i][f] = t.value;
      if (f === "linkedin" || f === "email" || f === "phone") {
        const a = t.closest(".link-row").querySelector(".c-open");
        a.href = contactHref(f, t.value); a.hidden = !t.value;
      }
    };
    contactsList.addEventListener("input", syncContact);
    contactsList.addEventListener("change", syncContact);
    contactsList.addEventListener("click", (e) => {
      const del = e.target.closest(".c-del");
      if (del) { modalContacts.splice(+del.dataset.i, 1); renderContacts(); }
    });

    // Cover-letter toggle
    fields.hasCover.addEventListener("change", toggleCoverFields);

    // Follow-ups editor (delegated — rows are re-rendered)
    $("addFollowUp").addEventListener("click", addFollowUp);
    const followUpsList = $("followUpsList");
    const syncFollowUp = (e) => {
      const t = e.target, i = +t.dataset.i, f = t.dataset.f;
      if (f == null || !modalFollowUps[i]) return;
      modalFollowUps[i][f] = t.value;
    };
    followUpsList.addEventListener("input", syncFollowUp);
    followUpsList.addEventListener("change", syncFollowUp);
    followUpsList.addEventListener("click", (e) => {
      const del = e.target.closest(".f-del");
      if (del) { modalFollowUps.splice(+del.dataset.i, 1); renderFollowUps(); }
    });

    const searchInput = $("searchInput");
    const updateSearchTip = () => {
      $("searchTip").hidden = !(document.activeElement === searchInput && !searchInput.value);
    };
    searchInput.addEventListener("input", (e) => {
      const qa = parseQuickAdd(e.target.value);
      search = qa ? "" : e.target.value.trim().toLowerCase(); // don't filter while composing a quick-add
      updateSearchHint(e.target.value);
      updateSearchTip();
      render();
    });
    searchInput.addEventListener("focus", updateSearchTip);
    searchInput.addEventListener("blur", () => { $("searchTip").hidden = true; });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !$("searchHint").hidden) { e.preventDefault(); quickAddFromSearch(); }
      else if (e.key === "Escape") { $("searchHint").hidden = true; searchInput.blur(); }
    });
    $("searchHint").addEventListener("click", quickAddFromSearch);

    $("exportBtn").addEventListener("click", exportData);
    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });
    $("exportReminderBtn").addEventListener("click", exportData);
    $("exportReminderDismiss").addEventListener("click", () => {
      localStorage.setItem("jobcrm_export_snooze", todayISO());
      updateExportReminder();
    });

    starsEl.addEventListener("click", (e) => {
      if (e.target.dataset.v) {
        const v = +e.target.dataset.v;
        setStars(v === +starsEl.dataset.value ? 0 : v);
      }
    });

    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    // Quick-add URL prompt
    const urlModal = $("urlModal");
    $("urlSave").addEventListener("click", saveUrl);
    $("urlSkip").addEventListener("click", closeUrlModal);
    $("closeUrlModal").addEventListener("click", closeUrlModal);
    urlModal.addEventListener("click", (e) => { if (e.target === urlModal) closeUrlModal(); });
    $("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveUrl(); } });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setView("board");
        const si = $("searchInput");
        si.focus();
        si.select();
        return;
      }
      if (e.key === "Escape") {
        if (!urlModal.hidden) closeUrlModal();
        else if (!modal.hidden) closeModal();
        else if (!$("searchHint").hidden) $("searchHint").hidden = true;
        return;
      }
      // Single-key tab nav — only when not typing and no modal/modifier is active.
      const tag = (e.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !modal.hidden || !urlModal.hidden) return;
      if (e.key === "Enter") { e.preventDefault(); openModal(null); return; }
      const v = { h: "home", b: "board", r: "reminders", a: "assets" }[e.key.toLowerCase()];
      if (v) { e.preventDefault(); setView(v); }
    });
  }

  /* ---------------- Init ---------------- */
  (async () => {
    db = await openDB();
    jobs = await dbApi.allJobs();
    assets = await dbApi.allAssets();
    await migrateLegacyFiles();
    await migrateLegacyPeople();
    await migrateContactLinks();
    await migrateFollowUps();
    await seedDefaultLinks();
    if (!getName()) askName(); // ask on open until they give one
    refreshTitle();
    wire();
    render();
    setView("home");
    updateExportReminder();
  })();
})();
