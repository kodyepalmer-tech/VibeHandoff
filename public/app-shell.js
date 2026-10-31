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

  function renderChrome(active) {
    const who = $('#who');
    if (who && state.user) {
      who.textContent = `${state.user.displayName} · ${state.user.role}`;
    }
    document.querySelectorAll('nav a[data-nav]').forEach((link) => {
      link.classList.toggle('active', link.dataset.nav === active);
    });
    const studio = $('[data-nav="studio"]');
    if (studio) {
      studio.hidden = state.user?.role !== 'publisher';
    }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST', body: {} });
    location.href = '/login';
  }

  window.VibeHandoff = { api, loadSession, renderChrome, logout, state, $ };
})();
