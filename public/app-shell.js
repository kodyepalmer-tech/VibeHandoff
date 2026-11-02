(() => {
  const state = {
    user: null,
    organization: null,
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers,
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function loadSession() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
      state.organization = data.organization;
      return data;
    } catch (err) {
      if (err.status === 401) {
        if (!location.pathname.startsWith('/login')) {
          location.href = '/login';
        }
        return null;
      }
      throw err;
    }
  }

  let platformPromise;

  async function applyBrand() {
    if (!platformPromise) {
      platformPromise = api('/api/platform')
        .then((platform) => {
          state.platform = platform;
          document.body.classList.toggle('shop', platform.mode === 'public');
          const baked = 'Vibe Handoff Enterprise';
          if (document.title.includes(baked)) {
            document.title = document.title.replaceAll(baked, platform.productName);
          }
          document.querySelectorAll('[data-product]').forEach((node) => {
            node.textContent = platform.productName;
          });
          document.querySelectorAll('[data-tagline]').forEach((node) => {
            node.textContent = platform.tagline;
          });
          const heading = document.querySelector('h1');
          const eyebrow = document.querySelector('main .eyebrow');
          if (eyebrow && heading && /^Sign in/.test(heading.textContent.trim())) {
            eyebrow.textContent = platform.productName;
          }
          return platform;
        })
        .catch(() => null);
    }
    return platformPromise;
  }

  async function renderChrome(active) {
    const platform = await applyBrand();
    const shop = platform?.mode === 'public';
    const who = $('#who');
    if (who && state.user) {
      who.textContent = shop ? state.user.displayName : `${state.user.displayName} · ${state.user.role}`;
    }
    const market = $('[data-nav="market"]');
    if (market && shop) market.textContent = 'Store';
    const studio = $('[data-nav="studio"]');
    if (studio) {
      if (shop) studio.textContent = 'Upload';
      studio.hidden = shop ? !state.user : state.user?.role !== 'publisher';
    }
    const admin = $('[data-nav="admin"]');
    if (admin) {
      admin.hidden = shop || state.user?.role !== 'admin';
    }
    document.querySelectorAll('nav a[data-nav]').forEach((link) => {
      link.classList.toggle('active', link.dataset.nav === active);
    });
    return platform;
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST', body: {} });
    location.href = '/login';
  }

  window.VibeHandoff = { api, loadSession, renderChrome, applyBrand, logout, state, $ };
})();
