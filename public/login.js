const { api, applyBrand } = window.VibeHandoff;

async function boot() {
  applyBrand();
  try {
    const platform = await api('/api/platform');
    if (platform.mode === 'public' && platform.auth === 'oauth') {
      const link = document.querySelector('#panel a.button');
      if (link) link.textContent = 'Continue with GitHub';
      const lede = document.querySelector('.lede');
      if (lede) lede.textContent = 'Sign in with GitHub.';
    }
  } catch {
    // Keep the baked enterprise copy when the platform route is down.
  }
  try {
    await api('/api/me');
    location.href = '/';
    return;
  } catch {
    // stay on login
  }
  try {
    const data = await api('/api/dev/identities');
    const panel = document.getElementById('panel');
    panel.innerHTML = `
      <h2>Development identities</h2>
      <div class="identities">
        ${data.identities
          .map(
            (identity) => `
          <div class="identity">
            <div>
              <strong>${identity.display_name}</strong>
              <div class="meta">${identity.email} · ${identity.role}</div>
            </div>
            <button data-email="${identity.email}">Enter</button>
          </div>`
          )
          .join('')}
      </div>
    `;
    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-email]');
      if (!button) return;
      await api('/api/dev/login', { method: 'POST', body: { email: button.dataset.email } });
      location.href = '/';
    });
  } catch {
    // OIDC-only environments keep the generic button
  }
}

boot();
