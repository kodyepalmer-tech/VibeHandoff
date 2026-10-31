const { api, applyBrand } = window.VibeHandoff;

async function boot() {
  applyBrand();
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
