const { api, loadSession, renderChrome, logout, state, $ } = window.VibeHandoff;

function showError(error) {
  const node = $('#error');
  node.hidden = false;
  node.textContent = error.message || 'Request failed';
}

function clearError() {
  const node = $('#error');
  node.hidden = true;
  node.textContent = '';
}

function renderUsers(users) {
  $('#users').innerHTML = users
    .map(
      (user) => `
      <tr>
        <td>${user.display_name}</td>
        <td>${user.email}</td>
        <td>
          <select data-user="${user.id}" aria-label="Role for ${user.display_name}">
            ${['admin', 'publisher', 'member']
              .map((role) => `<option value="${role}" ${role === user.role ? 'selected' : ''}>${role}</option>`)
              .join('')}
          </select>
        </td>
        <td><button class="ghost" type="button" data-save-role="${user.id}">Save role</button></td>
      </tr>`
    )
    .join('');
}

function renderApps(apps) {
  const rows = apps.filter((app) => app.published_release_id);
  $('#apps').innerHTML = rows.length
    ? rows
        .map(
          (app) => `
        <tr>
          <td><a href="/apps/${app.slug}">${app.name}</a></td>
          <td>${app.creator_name}</td>
          <td><span class="status published">${app.published_version}</span></td>
          <td><button class="danger" type="button" data-takedown="${app.slug}">Pull</button></td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="empty">Nothing is published.</td></tr>';
}

function renderAudit(logs) {
  $('#audit').innerHTML = logs.length
    ? logs
        .map((entry) => {
          const when = new Date(entry.created_at).toLocaleString();
          const who = entry.actor_name || 'system';
          return `
          <tr>
            <td>${when}</td>
            <td>${who}</td>
            <td><span class="status">${entry.action}</span></td>
            <td>${entry.resource_type}${entry.metadata?.slug ? ` · ${entry.metadata.slug}` : ''}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="empty">No audit events yet.</td></tr>';
}

async function refresh() {
  const [users, apps, audit] = await Promise.all([
    api('/api/admin/users'),
    api('/api/admin/apps'),
    api('/api/admin/audit'),
  ]);
  renderUsers(users.users);
  renderApps(apps.apps);
  renderAudit(audit.logs);
}

async function boot() {
  const session = await loadSession();
  if (!session) return;
  if (state.user.role !== 'admin') {
    location.href = '/';
    return;
  }
  renderChrome('admin');
  $('#logout').addEventListener('click', () => logout());
  document.body.addEventListener('click', async (event) => {
    const save = event.target.closest('[data-save-role]');
    const pull = event.target.closest('[data-takedown]');
    if (!save && !pull) return;
    clearError();
    try {
      if (save) {
        const select = document.querySelector(`select[data-user="${save.dataset.saveRole}"]`);
        await api(`/api/admin/users/${save.dataset.saveRole}/role`, {
          method: 'POST',
          body: { role: select.value },
        });
      }
      if (pull) {
        const slug = pull.dataset.takedown;
        if (!window.confirm(`Pull ${slug} from the marketplace?`)) return;
        await api(`/api/admin/apps/${slug}/takedown`, { method: 'POST', body: {} });
      }
      await refresh();
    } catch (error) {
      showError(error);
    }
  });
  try {
    await refresh();
  } catch (error) {
    showError(error);
  }
}

boot();
