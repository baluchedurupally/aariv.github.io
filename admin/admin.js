/* admin/admin.js */

const sb = window.sb;
let currentSession = null;

const $ = (id) => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
const esc = (s) => (s ?? "").toString().replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : "";

async function requireAdmin() {
  const status = $("status");
  const root = $("adminRoot");

  const { data: s } = await sb.auth.getSession();
  const session = s?.session;
  if (!session) {
    const next = encodeURIComponent("/admin/index.html");
    location.href = `/login.html?next=${next}`;
    return null;
  }

  // Needs admins_self_read policy on admins table
  const { data: admin, error } = await sb
    .from("admins")
    .select("user_id,email")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    status.textContent = "Error checking admin access: " + (error.message || "unknown");
    console.error(error);
    return null;
  }
  if (!admin) {
    status.textContent = "❌ Not authorized (you are logged in, but not an admin).";
    return null;
  }

  status.classList.add("hidden");
  root.classList.remove("hidden");

  $("logoutBtn").addEventListener("click", async () => {
    await sb.auth.signOut();
    location.href = "/index.html";
  });

  return session;
}

/* ---------- Tabs ---------- */
function initTabs() {
  const btns = document.querySelectorAll(".tabBtn");
  const panes = document.querySelectorAll(".tabPane");

  btns.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;

      // styles
      btns.forEach(b => b.className = "tabBtn px-4 py-2 rounded-full bg-white shadow text-purple-600");
      btn.className = "tabBtn px-4 py-2 rounded-full bg-purple-600 text-white";

      panes.forEach(p => p.classList.add("hidden"));
      $(`tab-${tab}`).classList.remove("hidden");
    });
  });
}

/* ---------- Milestones (CRUD-lite: create + list + delete) ---------- */
async function saveMilestone() {
  const payload = {
    title: $("ms_title").value.trim(),
    happened_on: $("ms_date").value, // required in your schema
    description: $("ms_desc").value.trim() || null,
    tags: ($("ms_tags").value || "")
        .split(",").map(x => x.trim()).filter(Boolean),
    media_urls: ($("ms_media")?.value || "")
        .split(",").map(x => x.trim()).filter(Boolean),
    visibility: $("ms_visibility").value
 };
  // attach user id so row-level security policies that require ownership pass
  if (currentSession?.user?.id) payload.user_id = currentSession.user.id;

  const { error } = await sb.from("milestones").insert(payload);
  if (error) {
    setText("ms_msg", "❌ " + error.message);
    console.error(error);
    return;
  }
  setText("ms_msg", "✅ Milestone saved.");
  $("milestoneForm").reset();
  await loadMilestones();
}

async function loadMilestones() {
  const wrap = $("milestoneList");
  wrap.innerHTML = "Loading…";

  const { data, error } = await sb
    .from("milestones")
    .select("id,title,happened_on,visibility,tags,media_urls")
    .order("happened_on", { ascending: false })
    .limit(10);

  if (error) {
    wrap.innerHTML = `<div class="text-red-600">Error: ${esc(error.message)}</div>`;
    return;
  }

  wrap.innerHTML = (data || []).map(m => `
    <div class="p-4 rounded-lg border flex items-center justify-between">
      <div>
        <div class="font-semibold">${esc(m.title)}</div>
        <div class="text-sm text-gray-500">${esc(m.visibility)} • ${esc(fmtDate(m.happened_on))} • ${(m.tags||[]).map(esc).join(", ")} • ${m.media_urls?.length ? ` • 📷 ${m.media_urls.length}` : ""}</div>
      </div>
      <button data-id="${m.id}" class="msDel px-3 py-1 rounded bg-slate-900 text-white">Delete</button>
    </div>
  `).join("") || `<div class="text-gray-600">No milestones yet.</div>`;

  wrap.querySelectorAll(".msDel").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this milestone?")) return;
      const id = btn.dataset.id;
      const { error: delErr } = await sb.from("milestones").delete().eq("id", id);
      if (delErr) alert(delErr.message);
      await loadMilestones();
    });
  });
}

/* ---------- Gallery (upload -> storage + insert row, list latest, delete) ---------- */
function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

async function uploadPhotoToStorage(file) {
  // bucket name must exist; project uses `aariv-media`
  const bucket = "aariv-media";
  const ext = file.name.split(".").pop() || "jpg";
  const path = `gallery/${Date.now()}_${safeFileName(file.name)}`;

  const { error } = await sb.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type || `image/${ext}`
  });

  if (error) throw error;

  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  return { path, publicUrl: data.publicUrl };
}

async function loadAlbumDropdown() {
  const sel = $("ph_album_id");
  if (!sel) return;

  sel.innerHTML = `<option value="">(No album)</option>`;

  const { data, error } = await sb
    .from("albums")
    .select("id,name,visibility,event_date")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("loadAlbumDropdown", error);
    return;
  }

  (data || []).forEach(a => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.name}${a.visibility === "public" ? " (Public)" : ""}`;
    sel.appendChild(opt);
  });
}

async function ensureAlbumId() {
  const selected = $("ph_album_id")?.value || "";
  const newName = ($("ph_new_album")?.value || "").trim();

  if (newName) {
    const visibility = $("ph_visibility")?.value || "private";

    const { data, error } = await sb
      .from("albums")
      .insert({ name: newName, visibility })
      .select("id")
      .single();

    if (error) throw error;

    await loadAlbumDropdown();
    $("ph_album_id").value = data.id;
    $("ph_new_album").value = "";

    return data.id;
  }

  return selected ? Number(selected) : null;
}

async function savePhoto() {
  try {
    setText("ph_msg", "Uploading…");

    const file = $("ph_file").files?.[0];
    if (!file) {
      setText("ph_msg", "❌ Please choose a file.");
      return;
    }

    const { path, publicUrl } = await uploadPhotoToStorage(file);
    const album_id = await ensureAlbumId();

    const payload = {
        url: publicUrl,
        caption: $("ph_caption").value.trim() || null,
        taken_at: $("ph_taken_at").value ? new Date($("ph_taken_at").value).toISOString() : null,
        location: $("ph_location").value.trim() || null,
        tags: ($("ph_tags").value || "")
            .split(",").map(x => x.trim()).filter(Boolean),
        is_favorite: false,
        visibility: $("ph_visibility").value,
        album_id
    };

    // attach user_id if available so RLS policies that require auth.uid() match
    // prefer fresh session from the client (in case session changed)
    try {
      const { data: sessData } = await sb.auth.getSession();
      const liveUserId = sessData?.session?.user?.id;
      if (liveUserId) payload.user_id = liveUserId;
    } catch (e) {
      // fallback to previously stored session
      if (currentSession?.user?.id) payload.user_id = currentSession.user.id;
    }

    const { error } = await sb.from("photos").insert(payload);
    if (error) {
      // surface more info to help debug RLS issues
      const details = error?.details ? `\nDetails: ${error.details}` : "";
      const hint = error?.hint ? `\nHint: ${error.hint}` : "";
      setText("ph_msg", "❌ " + error.message + details + hint);
      console.error("Photo insert error:", error);
      return;
    }

    setText("ph_msg", "✅ Uploaded and saved.");
    $("photoForm").reset();
    await loadPhotos();
  } catch (e) {
    setText("ph_msg", "❌ " + (e.message || "Upload failed"));
    console.error(e);
  }
}

async function loadPhotos() {
  const wrap = $("photoList");
  wrap.innerHTML = "Loading…";

  const { data, error } = await sb
    .from("photos")
    .select("id,caption,url,visibility,taken_at")
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) {
    wrap.innerHTML = `<div class="text-red-600">Error: ${esc(error.message)}</div>`;
    return;
  }

  wrap.innerHTML = (data || []).map(p => `
    <div class="p-3 rounded-lg border bg-white">
      <div class="w-full h-48 bg-slate-100 rounded-lg overflow-hidden mb-2">
        ${p.url ? `<img src="${esc(p.url)}" class="w-full h-full object-cover" />` : ""}
      </div>
      <div class="font-semibold">${esc(p.caption)}</div>
      
      <div class="text-sm text-gray-500">
        ${esc(p.visibility)} • ${esc(fmtDate(p.taken_at))} ${p.is_favorite ? " • ⭐" : ""}
      </div>
      <button data-id="${p.id}" class="phDel mt-2 px-3 py-1 rounded bg-slate-900 text-white">Delete</button>
    </div>
  `).join("") || `<div class="text-gray-600">No photos yet.</div>`;

  wrap.querySelectorAll(".phDel").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this photo record? (File in storage stays unless you also delete it)")) return;
      const id = btn.dataset.id;
      const { error: delErr } = await sb.from("photos").delete().eq("id", id);
      if (delErr) alert(delErr.message);
      await loadPhotos();
    });
  });
}

/* ---------- Journal (create + list + delete) ---------- */
async function saveJournal() {
  const statusVal = $("jr_status").value;
  const publishAtRaw = $("jr_publish_at").value;

  const payload = {
    title: $("jr_title").value.trim(),
    entry_date: $("jr_entry_date").value, // NOT NULL in your schema
    content_html: $("jr_content_html").value.trim(), // NOT NULL
    mood: $("jr_mood").value.trim() || null,
    tags: ($("jr_tags").value || "").split(",").map(x => x.trim()).filter(Boolean),
    attachments: ($("jr_attachments").value || "").split(",").map(x => x.trim()).filter(Boolean),
    status: statusVal,
    publish_at: (statusVal === "scheduled" && publishAtRaw) ? new Date(publishAtRaw).toISOString() : null,
    visibility: $("jr_visibility").value
  };
  if (currentSession?.user?.id) payload.user_id = currentSession.user.id;

  const { error } = await sb.from("journal_entries").insert(payload);
  if (error) {
    setText("jr_msg", "❌ " + error.message);
    console.error(error);
    return;
  }

  setText("jr_msg", "✅ Journal entry saved.");
  $("journalForm").reset();
  await loadJournal();
}

async function loadJournal() {
  const wrap = $("journalList");
  wrap.innerHTML = "Loading…";

  const { data, error } = await sb
    .from("journal_entries")
    .select("id,title,entry_date,visibility,status,publish_at")
    .order("entry_date", { ascending: false })
    .limit(10);

  if (error) {
    wrap.innerHTML = `<div class="text-red-600">Error: ${esc(error.message)}</div>`;
    return;
  }

  wrap.innerHTML = (data || []).map(j => `
    <div class="p-4 rounded-lg border flex items-center justify-between">
      <div>
        <div class="font-semibold">${esc(j.title)}</div>
        <div class="text-sm text-gray-500">
          ${esc(j.visibility)} • ${esc(j.status)} • ${esc(fmtDate(j.entry_date))}
          ${j.status === "scheduled" && j.publish_at ? ` • ⏰ ${esc(new Date(j.publish_at).toLocaleString())}` : ""}
        </div>
      </div>
      <button data-id="${j.id}" class="jrDel px-3 py-1 rounded bg-slate-900 text-white">Delete</button>
    </div>
  `).join("") || `<div class="text-gray-600">No entries yet.</div>`;

  wrap.querySelectorAll(".jrDel").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this journal entry?")) return;
      const id = btn.dataset.id;
      const { error: delErr } = await sb.from("journal_entries").delete().eq("id", id);
      if (delErr) alert(delErr.message);
      await loadJournal();
    });
  });
}

/* ---------- Guestbook moderation (approve/reject) ---------- */
async function loadGuestbook() {
  const wrap = $("guestbookList");
  wrap.innerHTML = "Loading…";

  const { data, error } = await sb
    .from("guestbook_entries")
    .select("id,name,relation,message,photo_url,status,created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    wrap.innerHTML = `<div class="text-red-600">Error: ${esc(error.message)}</div>`;
    return;
  }

  wrap.innerHTML = (data || []).map(g => `
    <div class="p-4 rounded-lg border">
      <div class="flex items-start justify-between gap-4">
        <div class="flex gap-3">
          <div class="w-12 h-12 rounded-full bg-slate-100 overflow-hidden flex items-center justify-center">
            ${g.photo_url ? `<img src="${esc(g.photo_url)}" class="w-full h-full object-cover" />` : `<span class="text-gray-500">👤</span>`}
          </div>
          <div>
            <div class="font-semibold">${esc(g.name)} <span class="text-sm text-gray-500">(${esc(g.relation || "")})</span></div>
            <div class="text-sm text-gray-500">${esc(fmtDate(g.created_at))} • <span class="font-semibold">${esc(g.status)}</span></div>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="gbApprove px-3 py-1 rounded bg-green-600 text-white" data-id="${g.id}">Approve</button>
          <button class="gbReject px-3 py-1 rounded bg-red-600 text-white" data-id="${g.id}">Reject</button>
        </div>
      </div>

      <div class="mt-3 text-gray-700">${esc(g.message)}</div>
    </div>
  `).join("") || `<div class="text-gray-600">No guestbook entries yet.</div>`;

  wrap.querySelectorAll(".gbApprove").forEach(btn =>
    btn.addEventListener("click", () => setGuestStatus(btn.dataset.id, "approved"))
  );
  wrap.querySelectorAll(".gbReject").forEach(btn =>
    btn.addEventListener("click", () => setGuestStatus(btn.dataset.id, "rejected"))
  );
}

async function setGuestStatus(id, status) {
  const { error } = await sb.from("guestbook_entries").update({ status }).eq("id", id);
  if (error) {
    alert(error.message);
    console.error(error);
    return;
  }
  await loadGuestbook();
}

/* ---------- Members list (read + remove) ---------- */
async function loadMembers() {
  const wrap = $("membersList");
  wrap.innerHTML = "Loading…";

  // NOTE: this requires an admin read policy on members table.
  const { data, error } = await sb
    .from("members")
    .select("user_id,email,created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    wrap.innerHTML = `<div class="text-red-600">Error: ${esc(error.message)}<br/>If you see RLS error, add an admin SELECT policy for members.</div>`;
    return;
  }

  wrap.innerHTML = (data || []).map(m => `
    <div class="p-3 rounded-lg border flex items-center justify-between">
      <div class="text-sm">
        <div class="font-semibold">${esc(m.email || "(no email)")} </div>
        <div class="text-gray-500">${esc(m.user_id)} • ${esc(fmtDate(m.created_at))}</div>
      </div>
      <button data-id="${m.user_id}" class="memDel px-3 py-1 rounded bg-slate-900 text-white">Remove</button>
    </div>
  `).join("") || `<div class="text-gray-600">No members yet.</div>`;

  wrap.querySelectorAll(".memDel").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Remove this member? They will lose access to private content.")) return;
      const uid = btn.dataset.id;
      const { error: delErr } = await sb.from("members").delete().eq("user_id", uid);
      if (delErr) alert(delErr.message);
      await loadMembers();
    });
  });
}

/* ---------- Wire events ---------- */
async function main() {
  const session = await requireAdmin();
  if (!session) return;
  currentSession = session;

  initTabs();
  await loadAlbumDropdown();

  // forms
  $("milestoneForm").addEventListener("submit", (e) => { e.preventDefault(); saveMilestone(); });
  $("photoForm").addEventListener("submit", (e) => { e.preventDefault(); savePhoto(); });
  $("journalForm").addEventListener("submit", (e) => { e.preventDefault(); saveJournal(); });

  // refresh buttons
  $("refreshMilestones").addEventListener("click", loadMilestones);
  $("refreshPhotos").addEventListener("click", loadPhotos);
  $("refreshJournal").addEventListener("click", loadJournal);
  $("refreshGuestbook").addEventListener("click", loadGuestbook);
  $("refreshMembers").addEventListener("click", loadMembers);

  // initial loads
  await loadMilestones();
  await loadPhotos();
  await loadJournal();
  await loadGuestbook();
  await loadMembers();
}

main();
