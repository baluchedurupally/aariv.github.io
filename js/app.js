(async function main() {
  const sb = window.sb;
  if (!sb) {
    console.error("Supabase client (window.sb) not found. Check config.js + supabaseClient.js order.");
    return;
  }

  // --- Helpers ---
  const byId = (id) => document.getElementById(id);
  const setText = (id, v) => { const el = byId(id); if (el) el.textContent = v ?? ""; };
  const setHtml = (id, v) => { const el = byId(id); if (el) el.innerHTML = v ?? ""; };
  const show = (id, yes) => { const el = byId(id); if (el) el.classList.toggle("hidden", !yes); };
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

  const stripHtml = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html ?? "";
    return (tmp.textContent || tmp.innerText || "").trim();
  };

  // --- Invite-only helper ---
  async function isMemberOrAdmin(userId) {
    // admin?
    const { data: admin, error: adminErr } = await sb
      .from("admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (adminErr) {
      console.error("Admin check failed:", adminErr);
      return false;
    }
    if (admin) return true;

    // member?
    const { data: member, error: memberErr } = await sb
      .from("members")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (memberErr) {
      console.error("Member check failed:", memberErr);
      return false;
    }
    return !!member;
  }

  // --- Handle magic-link redirect hash cleanly ---
  try {
    await sb.auth.getSession();
    if (location.hash && location.hash.includes("access_token")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch {}

  // --- Auth state ---
  const { data: sessionData } = await sb.auth.getSession();
  const session = sessionData?.session ?? null;

  // --- Gallery pagination state ---
  let galleryPage = 0;
  const galleryPageSize = 12;
  let galleryHasMore = false;
  let galleryIncludePrivate = false;

  // =========================
  // Boot
  // =========================
  await loadSiteSettings();
  await loadPublicMilestones();
  await loadApprovedGuestbook();

  // Gallery/journal visibility for public vs invited users
  if (!session) {
    // Public visitor: show public photos only; journal locked
    galleryIncludePrivate = false;
    show("galleryLocked", false);
    show("journalLocked", true);
    setText("journalLocked", "🔒 Journal is invite-only. Please login.");
    galleryPage = 0;
    await loadPrivateGallery({ append: false, includePrivate: false });
  } else {
    const allowed = await isMemberOrAdmin(session.user.id);
    if (!allowed) {
      // Logged-in but not invited: show public photos; journal locked
      galleryIncludePrivate = false;
      show("galleryLocked", false);
      setText("galleryLocked", "🔒 This gallery is invite-only. You’ve not been added yet.");
      show("journalLocked", true);
      setText("journalLocked", "🔒 This journal is invite-only. Please contact the parents.");
      galleryPage = 0;
      await loadPrivateGallery({ append: false, includePrivate: false });
    } else {
      // Invited member/admin: show private + public
      galleryIncludePrivate = true;
      show("galleryLocked", false);
      show("journalLocked", false);
      galleryPage = 0;
      await loadPrivateGallery({ append: false, includePrivate: true });
      await loadPrivateJournal();
    }
  }

  // Load more photos
  byId("galleryLoadMoreBtn")?.addEventListener("click", async () => {
    if (!galleryHasMore) return;
    galleryPage += 1;
    await loadPrivateGallery({ append: true, includePrivate: galleryIncludePrivate });
  });

  // Guestbook submit -> pending moderation
  wireGuestbookForm();

  // =========================
  // UI lock/unlock
  // =========================
  function lockInviteOnly(galleryMsg, journalMsg) {
    show("galleryLocked", true);
    show("journalLocked", true);

    const g = byId("galleryLocked");
    const j = byId("journalLocked");
    if (g) g.textContent = galleryMsg;
    if (j) j.textContent = journalMsg;

    setHtml("galleryGrid", "");
    setHtml("journalList", "");
    show("galleryLoadMoreWrap", false);
  }

  function unlockInviteOnly() {
    show("galleryLocked", false);
    show("journalLocked", false);
  }

  // =========================
  // Data loaders
  // =========================

  async function loadSiteSettings() {
    const { data, error } = await sb
      .from("site_settings")
      .select("key,value")
      .in("key", ["hero_title","hero_subtitle","profile_image_url","profile_ring_color","birth_date"]);

    if (error) {
      console.warn("site_settings load warning:", error.message);
      return;
    }
    if (!data?.length) return;

    const map = Object.fromEntries(data.map(x => [x.key, x.value]));

    // If JSONB stored as JSON string, Supabase returns it as JS string already.
    // If stored as object, keep it.
    if (map.hero_title) setText("heroTitle", map.hero_title);
    if (map.hero_subtitle) setText("heroSubtitle", map.hero_subtitle);

    if (map.profile_image_url) {
      const img = byId("heroProfileImage");
      if (img) img.src = map.profile_image_url;
    }

    // Border ring color (baby blue default handled in HTML)
    if (map.profile_ring_color) {
      const wrapper = byId("heroProfileRing");
      if (wrapper) wrapper.style.borderColor = map.profile_ring_color;
    }

    if (map.birth_date) {
      setText("heroAgeChip", formatAge(map.birth_date));
    }
  }

  function formatAge(birthDateIso) {
    const b = new Date(birthDateIso);
    const now = new Date();

    let years = now.getFullYear() - b.getFullYear();
    let months = now.getMonth() - b.getMonth();
    let days = now.getDate() - b.getDate();

    if (days < 0) {
      months -= 1;
      const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
      days += prevMonthDays;
    }
    if (months < 0) { years -= 1; months += 12; }

    if (years > 0) return `${years}y ${months}m ${days}d`;
    if (months > 0) return `${months} months ${days} days`;
    return `${days} days old`;
  }

  // PUBLIC milestones (home page always shows curated public)
  async function loadPublicMilestones() {
    const grid = byId("milestoneGrid");
    if (!grid) {
      console.warn("milestoneGrid not found in DOM.");
      return;
    }

    grid.innerHTML = `<div class="text-gray-600">Loading milestones…</div>`;

    const { data, error } = await sb
      .from("milestones")
      .select("id,title,happened_on,description,tags,visibility")
      .eq("visibility", "public")
      .order("happened_on", { ascending: true }) // oldest -> newest so recent appears last
      .limit(12);

    if (error) {
      console.error("Milestones load error:", error);
      grid.innerHTML = `<div class="text-red-600">Error loading milestones: ${escapeHtml(error.message)}</div>`;
      return;
    }

    if (!data || data.length === 0) {
      grid.innerHTML = `<div class="text-gray-600">No public milestones yet. (Set a milestone to Public in Admin)</div>`;
      return;
    }

    grid.innerHTML = data.map(m => `
      <div class="milestone-card bg-white rounded-2xl shadow-md overflow-hidden transition-all duration-300">
        <div class="h-16 flex items-center justify-center milestone-header">
          <span class="title-font text-xl milestone-header-icon">🌟</span>
        </div>
        <div class="p-6">
          <h3 class="title-font text-xl text-green-600 mb-2">${escapeHtml(m.title)}</h3>
          <div class="text-sm text-gray-500 mb-3">${m.happened_on ? new Date(m.happened_on).toLocaleDateString() : ""}</div>
          <p class="text-gray-700 mb-3">${escapeHtml(m.description || "")}</p>
          <div class="flex flex-wrap gap-2">
            ${(m.tags || []).map(t => `<span class="bg-green-100 px-3 py-1 rounded-full text-green-700 text-xs">${escapeHtml(t)}</span>`).join("")}
          </div>
        </div>
      </div>
    `).join("");

    applyRandomMilestoneHeaderColors();
  }

  // PRIVATE gallery (invite-only)
  async function loadPrivateGallery({ append }) {
    const grid = byId("galleryGrid");
    if (!grid) return;

    const from = galleryPage * galleryPageSize;
    const to = from + galleryPageSize - 1;

    const { data, error, count } = await sb
      .from("photos")
      .select("id,url,caption,taken_at,location,tags,is_favorite,visibility", { count: "exact" })
      .order("taken_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Gallery error:", error);
      return;
    }

    const html = (data || []).map(p => `
      <div class="photo-frame relative bg-white p-3 rounded-lg transform transition-transform hover:scale-105">
        <div class="w-full aspect-square overflow-hidden rounded-md bg-gray-50">
          <img src="${escapeHtml(p.url)}" alt="${escapeHtml(p.caption || "Photo")}" class="w-full h-full object-cover" />
        </div>
        <div class="mt-2 text-center">
          <p class="text-gray-700 font-medium">${escapeHtml(p.caption || "")}</p>
          <p class="text-xs text-gray-500">${p.taken_at ? new Date(p.taken_at).toLocaleDateString() : ""}</p>
        </div>
      </div>
    `).join("");

    if (append) grid.insertAdjacentHTML("beforeend", html);
    else grid.innerHTML = html;

    const total = count ?? 0;
    const shownSoFar = Math.min((galleryPage + 1) * galleryPageSize, total);
    galleryHasMore = shownSoFar < total;

    // ✅ Only show “Load more” if there are MORE photos than currently loaded
    show("galleryLoadMoreWrap", galleryHasMore && total > 0);
  }

  function initGalleryLightbox() {
    const lb = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightboxImg');
    const lbCaption = document.getElementById('lightboxCaption');
    const btnPrev = document.getElementById('lightboxPrev');
    const btnNext = document.getElementById('lightboxNext');
    const btnClose = document.getElementById('lightboxClose');
    const backdrop = document.getElementById('lightboxBackdrop');

    if (!lb || !lbImg || !btnPrev || !btnNext || !btnClose || !backdrop) return;

    let items = [];     // [{src, caption}]
    let current = 0;

    function collectGalleryItems() {
      // Works for both static and dynamic cards as long as images are inside a ".photo-frame"
      const frames = Array.from(document.querySelectorAll('#gallery .photo-frame'));
      const collected = [];

      frames.forEach(frame => {
        const img = frame.querySelector('img');
        if (!img) return;

        const src = img.getAttribute('data-full') || img.src; // data-full optional
        const captionEl = frame.querySelector('.mt-2 p') || frame.querySelector('[data-caption]');
        const dateEl = frame.querySelector('.mt-2 .text-xs') || frame.querySelector('[data-date]');

        const captionText = [
          captionEl ? captionEl.textContent.trim() : '',
          dateEl ? dateEl.textContent.trim() : ''
        ].filter(Boolean).join(' • ');

        collected.push({ src, caption: captionText });
      });

      items = collected;
    }

    function openAt(index) {
      if (!items.length) return;
      current = Math.max(0, Math.min(index, items.length - 1));
      const it = items[current];

      lbImg.src = it.src;
      lbImg.alt = it.caption || 'Photo';
      lbCaption.textContent = it.caption || '';

      lb.classList.remove('hidden');
      document.body.style.overflow = 'hidden';

      // hide prev/next if only one image
      const showNav = items.length > 1;
      btnPrev.style.display = showNav ? '' : 'none';
      btnNext.style.display = showNav ? '' : 'none';
    }

    function close() {
      lb.classList.add('hidden');
      lbImg.src = '';
      lbCaption.textContent = '';
      document.body.style.overflow = '';
    }

    function prev() {
      if (!items.length) return;
      openAt((current - 1 + items.length) % items.length);
    }

    function next() {
      if (!items.length) return;
      openAt((current + 1) % items.length);
    }

    // 🔁 Delegated click handler so it works even after dynamic load
    document.addEventListener('click', (e) => {
      const frame = e.target.closest('#gallery .photo-frame');
      if (!frame) return;

      const img = frame.querySelector('img');
      if (!img) return;

      collectGalleryItems();

      // Find index by src
      const src = img.getAttribute('data-full') || img.src;
      const idx = items.findIndex(x => x.src === src);
      if (idx >= 0) openAt(idx);
    });

    btnPrev.addEventListener('click', (e) => { e.stopPropagation(); prev(); });
    btnNext.addEventListener('click', (e) => { e.stopPropagation(); next(); });
    btnClose.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    backdrop.addEventListener('click', close);

    // Keyboard support
    document.addEventListener('keydown', (e) => {
      if (lb.classList.contains('hidden')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    });
  }
    initGalleryLightbox();
    
  // PRIVATE journal (invite-only)
  async function loadPrivateJournal() {
    const list = byId("journalList");
    if (!list) return;

    const { data, error } = await sb
      .from("journal_entries")
      .select("id,title,entry_date,content_html,mood,tags,visibility,status,publish_at")
      .order("entry_date", { ascending: false })
      .limit(10);

    if (error) {
      console.error("Journal error:", error);
      return;
    }

    list.innerHTML = (data || []).map(journalCard).join("") || `<div class="text-gray-600">No journal entries yet.</div>`;
  }

  function journalCard(j) {
    const d = new Date(j.entry_date);
    const day = d.getDate();
    const monthYear = d.toLocaleString(undefined, { month: "long", year: "numeric" });
    const fullText = stripHtml(j.content_html);
    const maxPreview = 600;
    let preview = fullText;
    if (fullText.length > maxPreview) {
      preview = fullText.slice(0, maxPreview);
      // avoid cutting mid-word: trim back to last space if it's reasonably inside
      const lastSpace = preview.lastIndexOf(' ');
      if (lastSpace > Math.floor(maxPreview * 0.6)) preview = preview.slice(0, lastSpace);
      preview += "…";
    }

    // Keep your original “color blocks” vibe by rotating a few accents
    const accents = ["bg-red-100", "bg-blue-100", "bg-green-100", "bg-purple-100"];
    const accent = accents[(j.id ?? 0) % accents.length];

    return `
      <div class="bg-white rounded-xl shadow-md overflow-hidden mb-8">
        <div class="md:flex">
          <div class="md:flex-shrink-0 ${accent} md:w-48 flex items-center justify-center p-6">
            <div class="text-center">
              <div class="text-gray-800 font-bold text-3xl">${day}</div>
              <div class="text-gray-600">${escapeHtml(monthYear)}</div>
            </div>
          </div>
          <div class="p-8">
            <h3 class="title-font text-2xl text-gray-800 mb-3">${escapeHtml(j.title)}</h3>
            <p class="text-gray-600 mb-4">${escapeHtml(preview)}</p>
            ${(j.tags || []).length
              ? `<div class="flex flex-wrap gap-2">${(j.tags || []).map(t => `<span class="bg-gray-100 px-3 py-1 rounded-full text-gray-700 text-xs">${escapeHtml(t)}</span>`).join("")}</div>`
              : ""}
          </div>
        </div>
      </div>
    `;
  }

  async function loadApprovedGuestbook() {
    const { data, error } = await sb
      .from("guestbook_entries")
      .select("id,name,relation,message,created_at")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("Guestbook error:", error);
      return;
    }

    if (!data || data.length === 0) {
      show("guestbookEmpty", true);
      setHtml("guestbookMessages", "");
      return;
    }

    show("guestbookEmpty", false);
    setHtml("guestbookMessages", data.map(x => `
      <div class="bg-white rounded-xl shadow-md p-6">
        <div class="flex items-start">
          <div class="bg-purple-100 rounded-full p-3 mr-4">
            <svg class="w-6 h-6 text-purple-500" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path>
            </svg>
          </div>
          <div>
            <div class="flex items-center mb-2">
              <h4 class="font-bold text-gray-800 mr-2">${escapeHtml(x.name)}</h4>
              <span class="text-sm text-gray-500">${escapeHtml(x.relation || "")}</span>
            </div>
            <p class="text-gray-700 mb-3">${escapeHtml(x.message)}</p>
            <div class="text-sm text-gray-500">${new Date(x.created_at).toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    `).join(""));
  }

  function wireGuestbookForm() {
    const form = byId("guestbook-form");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const name = (byId("name")?.value || "").trim();
      const relation = (byId("relation")?.value || "").trim();
      const message = (byId("message")?.value || "").trim();

      if (!name || !relation || !message) {
        alert("Please fill in all fields.");
        return;
      }

      const { error } = await sb.from("guestbook_entries").insert({
        name, relation, message, status: "pending"
      });

      if (error) {
        console.error(error);
        alert("Could not submit right now. Try again.");
        return;
      }

      alert("Thank you! Your message is submitted for approval.");
      byId("name").value = "";
      byId("relation").value = "";
      byId("message").value = "";
    });
  }

  function applyRandomMilestoneHeaderColors() {
    const colors = [
      "#FEF3C7", // soft yellow
      "#DBEAFE", // baby blue
      "#E9D5FF", // lavender
      "#FCE7F3", // pink
      "#D1FAE5", // mint
      "#FFE4E6", // peach
      "#E0E7FF"  // soft indigo
    ];

    function yiqBrightness(hex) {
      const c = (hex || "").replace('#', '');
      const r = parseInt(c.substring(0,2), 16);
      const g = parseInt(c.substring(2,4), 16);
      const b = parseInt(c.substring(4,6), 16);
      return (r*299 + g*587 + b*114) / 1000;
    }

    let lastColor = null;

    const headers = document.querySelectorAll(".milestone-header");
    headers.forEach(header => {
      let color;
      let attempts = 0;
      do {
        color = colors[Math.floor(Math.random() * colors.length)];
        attempts++;
        if (attempts > 20) break;
      } while (color === lastColor && colors.length > 1);

      header.style.backgroundColor = color;

      // ensure icon/text inside header is readable
      const icon = header.querySelector('.milestone-header-icon');
      if (icon) {
        const bright = yiqBrightness(color);
        icon.style.color = bright >= 150 ? '#0f172a' : '#ffffff';
      }

      lastColor = color;
    });
    }

})();
