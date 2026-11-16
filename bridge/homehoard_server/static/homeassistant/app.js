// Home Assistant en HomeHoard: la conexión, los dispositivos y las reglas. Todo pasa por el servidor local
// (/api/settings y /api/ui/call), que es quien guarda el token y habla con la instancia.
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
try { if (localStorage.getItem('homehoard.theme') === 'light') root.dataset.theme = 'light'; } catch { /* sin almacenamiento */ }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 100;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const tool = (name, args = {}) => api('/api/ui/call', { tool: name, arguments: args });

function say(el, text, kind = '') {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ------------------------------------------------------------------ pestañas
const VIEWS = { entities: 'view-entities', rules: 'view-rules', connection: 'view-connection' };
function show(view) {
  for (const [key, id] of Object.entries(VIEWS)) {
    $(id).hidden = key !== view;
    $('tab-' + key).classList.toggle('on', key === view);
  }
  if (view === 'entities') loadEntities(true);
  if (view === 'rules') loadRules();
  if (view === 'connection') loadConnection();
}
for (const key of Object.keys(VIEWS)) $('tab-' + key).addEventListener('click', () => show(key));

// ------------------------------------------------------------------ estado
function paintStatus(status) {
  const pill = $('status');
  if (!status.configured) { pill.textContent = 'Sin configurar'; pill.className = 'pill warn'; return; }
  if (status.connected) { pill.textContent = 'Escuchando'; pill.className = 'pill ok'; return; }
  if (status.last_error) { pill.textContent = 'Sin bus'; pill.className = 'pill bad'; pill.title = status.last_error; return; }
  pill.textContent = 'Configurado'; pill.className = 'pill';
  pill.title = status.url || '';
}

async function loadStatus(probe = false) {
  try {
    const status = await api('/api/homeassistant/status' + (probe ? '?probe=1' : ''));
    paintStatus(status);
    return status;
  } catch (err) {
    $('status').textContent = 'Error';
    $('status').className = 'pill bad';
    return null;
  }
}

// ------------------------------------------------------------------ conexión
async function loadConnection() {
  const settings = await api('/api/settings');
  $('ha-url').value = settings.ha_url || '';
  $('ha-token').value = '';
  $('ha-token').placeholder = settings.ha_token_set ? 'Guardado (escribe otro para cambiarlo)' : 'Se guarda en este ordenador';
  $('ha-notify').checked = settings.ha_notify !== false;
  const status = await loadStatus(true);
  const facts = $('conn-info');
  facts.innerHTML = '';
  if (!status) return;
  const rows = [['Configurado', status.configured ? 'sí' : 'no'], ['Dirección', status.url || '—'],
                ['Token', status.token_set ? 'guardado' : 'falta'], ['Bus de eventos', status.connected ? 'escuchando' : 'parado'],
                ['Reglas', String(status.rules ?? 0)]];
  if (status.reachable !== undefined) rows.push(['Alcanzable', status.reachable ? 'sí' : 'no']);
  if (status.version) rows.push(['Versión', status.version]);
  if (status.location_name) rows.push(['Casa', status.location_name]);
  if (status.entities !== undefined) rows.push(['Entidades', String(status.entities)]);
  if (status.error) rows.push(['Error', status.error]);
  if (status.last_error) rows.push(['Último error del bus', status.last_error]);
  for (const [k, v] of rows) {
    facts.insertAdjacentHTML('beforeend', `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
  }
}

$('conn-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = { ha_url: $('ha-url').value.trim(), ha_notify: $('ha-notify').checked };
  const token = $('ha-token').value.trim();
  if (token) body.ha_token = token;
  try {
    await api('/api/settings', body);
    say($('conn-msg'), 'Guardado.', 'ok');
    await loadConnection();
  } catch (err) {
    say($('conn-msg'), err.message, 'bad');
  }
});

$('conn-test').addEventListener('click', async () => {
  say($('conn-msg'), 'Probando…');
  try {
    const status = await api('/api/homeassistant/status?probe=1');
    paintStatus(status);
    if (status.reachable) say($('conn-msg'), `Conectado a Home Assistant ${status.version || ''} · ${status.entities} entidades.`, 'ok');
    else say($('conn-msg'), status.error || 'No se llega a Home Assistant.', 'bad');
    await loadConnection();
  } catch (err) {
    say($('conn-msg'), err.message, 'bad');
  }
});

// ------------------------------------------------------------------ dispositivos
const entState = { offset: 0, total: 0, rows: [] };

function stateClass(state) {
  const value = String(state ?? '').toLowerCase();
  if (value === 'unavailable' || value === 'unknown') return 'bad';
  if (value === 'off' || value === 'closed' || value === '0') return 'off';
  return '';
}

function entityRow(entity) {
  const unit = entity.unit ? ' ' + entity.unit : '';
  return `<li><div><div class="name">${esc(entity.name)}</div><div class="id">${esc(entity.entity_id)}</div></div>
    <div class="state ${stateClass(entity.state)}">${esc(entity.state)}${esc(unit)}</div></li>`;
}

async function loadEntities(reset = false) {
  if (reset) { entState.offset = 0; entState.rows = []; }
  const list = $('ent-list');
  if (reset) list.innerHTML = '<li class="empty">Leyendo…</li>';
  try {
    const answer = await tool('ha_list_entities', { q: $('ent-q').value.trim(), domain: $('ent-domain').value,
                                                    limit: PAGE, offset: entState.offset, refresh: reset });
    entState.total = answer.total;
    entState.rows = entState.rows.concat(answer.entities);
    entState.offset = entState.rows.length;
    list.innerHTML = entState.rows.length ? entState.rows.map(entityRow).join('') : '<li class="empty">Ninguna entidad coincide.</li>';
    $('ent-count').textContent = `${entState.rows.length} de ${answer.total} entidades`;
    $('ent-more').hidden = !answer.has_more;
    fillDomains(entState.rows);
  } catch (err) {
    list.innerHTML = `<li class="empty">${esc(err.message)}</li>`;
    $('ent-count').textContent = '';
    $('ent-more').hidden = true;
  }
}

function fillDomains(rows) {
  const select = $('ent-domain');
  const known = new Set([...select.options].map((o) => o.value));
  const chosen = select.value;
  for (const domain of new Set(rows.map((r) => r.domain))) {
    if (!known.has(domain)) select.insertAdjacentHTML('beforeend', `<option value="${esc(domain)}">${esc(domain)}</option>`);
  }
  select.value = chosen;
}

$('ent-q').addEventListener('input', () => { clearTimeout(loadEntities.timer); loadEntities.timer = setTimeout(() => loadEntities(true), 250); });
$('ent-domain').addEventListener('change', () => loadEntities(true));
$('ent-refresh').addEventListener('click', () => loadEntities(true));
$('ent-more').addEventListener('click', () => loadEntities(false));

$('svc-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  let data = {};
  try { data = JSON.parse($('svc-data').value || '{}'); } catch { say($('svc-msg'), 'Los datos no son JSON válido.', 'bad'); return; }
  try {
    const answer = await tool('ha_call_service', { domain: $('svc-domain').value.trim(), service: $('svc-name').value.trim(), data });
    say($('svc-msg'), `Llamado ${answer.service}: ${answer.count} entidades cambiadas.`, 'ok');
    await loadEntities(true);
  } catch (err) {
    say($('svc-msg'), err.message, 'bad');
  }
});

// ------------------------------------------------------------------ reglas
function ruleRow(rule) {
  const when = [rule.from_state ? `desde ${rule.from_state}` : '', rule.to_state ? `a ${rule.to_state}` : ''].filter(Boolean).join(' ');
  const actions = [rule.notify_title ? 'aviso' : '', rule.service_domain ? `${rule.service_domain}.${rule.service_name}` : ''].filter(Boolean).join(' + ');
  return `<li data-rule="${esc(rule.id)}">
    <div><div class="name">${esc(rule.name)}</div>
      <div class="id">${esc(rule.entity_id)}${when ? ' · ' + esc(when) : ''}${actions ? ' · ' + esc(actions) : ''}</div></div>
    <div class="actions">
      <span class="tag ${rule.enabled ? '' : 'off'}">${rule.enabled ? 'activa' : 'parada'}</span>
      <button type="button" data-act="edit">Editar</button>
      <button type="button" data-act="run">Probar</button>
      <button type="button" class="danger" data-act="delete">Borrar</button>
    </div></li>`;
}

async function loadRules() {
  const list = $('rule-list');
  try {
    const answer = await tool('ha_watch', { action: 'list' });
    paintStatus(answer.status || {});
    list.innerHTML = answer.rules.length ? answer.rules.map(ruleRow).join('') : '<li class="empty">Todavía no hay reglas.</li>';
    list.dataset.rules = JSON.stringify(answer.rules);
    const events = await tool('ha_watch', { action: 'events', limit: 20 });
    $('events-msg').textContent = events.connected ? 'El bus está conectado.' : (events.last_error || 'El bus no está conectado.');
    $('event-list').innerHTML = events.events.length
      ? events.events.map((e) => `<li><div class="id">${esc(e.entity_id)}</div><div class="state">${esc(e.from)} → ${esc(e.to)}</div></li>`).join('')
      : '<li class="empty">Ningún cambio escuchado todavía.</li>';
  } catch (err) {
    list.innerHTML = `<li class="empty">${esc(err.message)}</li>`;
  }
}

function fillRuleForm(rule) {
  $('rule-id').value = rule?.id || '';
  $('rule-entity').value = rule?.entity_id || '';
  $('rule-from').value = rule?.from_state || '';
  $('rule-to').value = rule?.to_state || '';
  $('rule-name').value = rule?.name || '';
  $('rule-title').value = rule?.notify_title || '';
  $('rule-body').value = rule?.notify_body || '';
  $('rule-priority').value = rule?.priority || 'normal';
  $('rule-cooldown').value = rule?.cooldown_s ?? 60;
  $('rule-svc-domain').value = rule?.service_domain || '';
  $('rule-svc-name').value = rule?.service_name || '';
  $('rule-svc-data').value = JSON.stringify(rule?.service_data || {});
  $('rule-enabled').checked = rule ? rule.enabled !== false : true;
  $('rule-form-title').textContent = rule ? 'Editar regla' : 'Nueva regla';
}

$('rule-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('li').dataset.rule;
  const rules = JSON.parse($('rule-list').dataset.rules || '[]');
  const rule = rules.find((r) => r.id === id);
  if (button.dataset.act === 'edit' && rule) { fillRuleForm(rule); $('rule-entity').focus(); return; }
  if (button.dataset.act === 'run') {
    try { await tool('ha_watch', { action: 'run', rule: id }); say($('rule-msg'), 'Regla ejecutada.', 'ok'); await loadRules(); }
    catch (err) { say($('rule-msg'), err.message, 'bad'); }
    return;
  }
  if (button.dataset.act === 'delete') {
    if (!confirm('¿Borrar esta regla?')) return;
    try { await tool('ha_watch', { action: 'delete', rule: id, confirm: true }); say($('rule-msg'), 'Regla borrada.', 'ok'); await loadRules(); }
    catch (err) { say($('rule-msg'), err.message, 'bad'); }
  }
});

$('rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  let serviceData = {};
  try { serviceData = JSON.parse($('rule-svc-data').value || '{}'); } catch { say($('rule-msg'), 'Los datos del servicio no son JSON válido.', 'bad'); return; }
  const args = {
    action: 'save', rule: $('rule-id').value || undefined, entity_id: $('rule-entity').value.trim(),
    from_state: $('rule-from').value.trim(), to_state: $('rule-to').value.trim(), name: $('rule-name').value.trim(),
    notify_title: $('rule-title').value.trim(), notify_body: $('rule-body').value.trim(), priority: $('rule-priority').value,
    cooldown_s: Number($('rule-cooldown').value || 0), service_domain: $('rule-svc-domain').value.trim(),
    service_name: $('rule-svc-name').value.trim(), service_data: serviceData, enabled: $('rule-enabled').checked,
  };
  for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
  try {
    await tool('ha_watch', args);
    say($('rule-msg'), 'Regla guardada.', 'ok');
    fillRuleForm(null);
    await loadRules();
  } catch (err) {
    say($('rule-msg'), err.message, 'bad');
  }
});

$('rule-cancel').addEventListener('click', () => { fillRuleForm(null); say($('rule-msg'), ''); });

// ------------------------------------------------------------------ arranque
loadStatus().then((status) => show(status && status.configured ? 'entities' : 'connection'));
setInterval(() => loadStatus(), 15000);