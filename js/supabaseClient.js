(function () {
  const cfg = window.__AARIV_CONFIG__;
  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // Helpful for debugging
  window.sb.auth.getSession().then(({ data }) => {
    console.log("Supabase session:", data.session);
  });
})();
