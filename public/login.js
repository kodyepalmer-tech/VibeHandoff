const { api, applyBrand } = window.VibeHandoff;

async function boot() {
  const platform = await applyBrand();
  const title = document.getElementById('login-title');
  const lede = document.getElementById('login-lede');
  const panel = document.getElementById('panel');

  if (platform?.mode === 'public') {
    if (title) title.textContent = 'Sign in to play.';
    if (lede) {
      lede.textContent = 'Play a game, leave a comment, or upload one of your own.';
    }
    const link = panel.querySelector('a.button');
    if (platform.auth === 'oauth' && link) link.textContent = 'Continue with GitHub';
    try {
      await api('/api/me');
      location.href = '/';
      return;
    } catch {
      // stay on the shop sign-in
    }
    try {
      await api('/api/dev/identities');
      panel.innerHTML = '<button type="button" id="enter-shop">Enter the shop</button>';
      document.getElementById('enter-shop').addEventListener('click', async () => {
        await api('/api/dev/login', { method: 'POST', body: { email: 'maya@acme.example' } });
        location.href = '/';
      });
    } catch {
      // Production public sign-in keeps the GitHub button.
    }
    return;
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
