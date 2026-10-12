/* HomeHoard — the web app's side of the Faustus copilot (window.hoardCopilot).
 *
 * The floating "Faustus" button and its side panel come from /api/copilot/launcher.js (the server adds it to every
 * page it serves). Before each turn the launcher calls hoardCopilot.context(base): the answer here is what the person
 * is looking at, read from the computer's copy of the home (GET /api/home, so what an agent changed a moment ago is
 * already in it): the object, room or furniture open, a summary on the list pages, and any form half filled in.
 * The project is the home (one conversation per home). When a turn ends, onTurnEnd asks the app to sync with the computer
 * at once (the app listens for the window's focus event) instead of waiting for its next poll.
 *
 * Plain classic script, no build, so it works with whatever the Expo export contains. The builders are pure (node can load
 * them); the wiring reads the page (location, the visible inputs) and the server.
 */
(function (root) {
  'use strict';
  var MAX_ITEMS = 25, MAX_ROWS = 20, MAX_TASKS = 8;

  var PAGES = { '/': 'home', '/plan': 'plan', '/search': 'search', '/maintenance': 'maintenance', '/settings': 'settings',
                '/add': 'add', '/scan': 'scan', '/importar': 'import' };

  function clip(text, n) {
    text = String(text == null ? '' : text);
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
  }

  function alive(rows) {
    return (rows || []).filter(function (r) { return r && r.deleted_at == null; });
  }

  function byId(rows) {
    var out = {};
    alive(rows).forEach(function (r) { out[r.id] = r; });
    return out;
  }

  /** The home's tables, alive rows only, indexed. */
  function indexTables(tables) {
    var t = tables || {};
    var ix = { homes: byId(t.homes), floors: byId(t.floors), rooms: byId(t.rooms), containers: byId(t.containers), items: byId(t.items),
               tags: byId(t.tags), details: {}, itemTags: alive(t.itemTags), tasks: alive(t.maintenance_tasks) };
    alive(t.item_details).forEach(function (d) { ix.details[d.item_id] = d; });
    return ix;
  }

  function parseRoute(pathname) {
    var p = String(pathname || '/').replace(/\/+$/, '') || '/';
    var m = /^\/(item|room|container)\/([^/]+)$/.exec(p);
    if (m) {
      var id = m[2];
      try { id = decodeURIComponent(id); } catch (e) { /* keep it as typed */ }
      return { page: m[1], id: id };
    }
    return { page: PAGES[p] || 'unknown' };
  }

  function containerChain(ix, id) {
    var out = [], seen = {};
    while (id && ix.containers[id] && !seen[id]) {
      seen[id] = true;
      out.unshift(ix.containers[id]);
      id = ix.containers[id].parent_container_id;
    }
    return out;
  }

  function locationText(ix, roomId, containerId) {
    var parts = [];
    if (ix.rooms[roomId]) parts.push(ix.rooms[roomId].name);
    containerChain(ix, containerId).forEach(function (c) { parts.push(c.name); });
    return parts.join(' › ');
  }

  function homeOfRoom(ix, room) {
    var floor = room && ix.floors[room.floor_id];
    return floor ? ix.homes[floor.home_id] || null : null;
  }

  function firstHome(ix) {
    var ids = Object.keys(ix.homes);
    return ids.length ? ix.homes[ids[0]] : null;
  }

  function descendants(ix, containerId) {
    var ids = {}, queue = [containerId];
    ids[containerId] = true;
    while (queue.length) {
      var next = queue.shift();
      Object.keys(ix.containers).forEach(function (id) {
        if (ix.containers[id].parent_container_id === next && !ids[id]) { ids[id] = true; queue.push(id); }
      });
    }
    return ids;
  }

  function tasksOf(ix, kind, id) {
    return ix.tasks.filter(function (t) { return t.target_kind === kind && t.target_id === id; })
      .sort(function (a, b) { return String(a.next_due || '9999').localeCompare(String(b.next_due || '9999')); })
      .slice(0, 5).map(function (t) {
        var row = { id: t.id, title: t.title };
        if (t.next_due) row.next_due = t.next_due;
        if (t.paused) row.paused = true;
        return row;
      });
  }

  function itemRow(item) {
    var row = { id: item.id, name: item.name };
    if (item.quantity != null && item.quantity !== 1) row.quantity = item.quantity;
    return row;
  }

  /** One object: where it is, how many, its tag names and the data sheet (brand, model, warranty, ...). */
  function itemObject(ix, item) {
    var out = { kind: 'item', object_id: item.id, title: item.name, quantity: item.quantity };
    if (item.favorite) out.favorite = true;
    if (item.description) out.note = clip(item.description, 300);
    out.location = locationText(ix, item.room_id, item.container_id);
    out.room_id = item.room_id;
    if (item.container_id) out.container_id = item.container_id;
    var tags = ix.itemTags.filter(function (l) { return l.item_id === item.id && ix.tags[l.tag_id]; })
      .map(function (l) { return ix.tags[l.tag_id].name; });
    if (tags.length) out.tags = tags;
    var d = ix.details[item.id];
    if (d) {
      var sheet = {};
      ['brand', 'model', 'serial', 'purchase_date', 'store', 'price', 'warranty_until', 'manual_url'].forEach(function (key) {
        if (d[key] != null && d[key] !== '') sheet[key] = d[key];
      });
      if (Object.keys(sheet).length) out.details = sheet;
      if (Array.isArray(d.kafka_doc_ids) && d.kafka_doc_ids.length) out.papers = d.kafka_doc_ids.length;
      if (Array.isArray(d.consumables) && d.consumables.length) out.consumables = d.consumables.slice(0, 5).map(function (c) { return c.name; });
    }
    var tasks = tasksOf(ix, 'item', item.id);
    if (tasks.length) out.maintenance = tasks;
    return out;
  }

  /** A room: its furniture with how many objects each holds, and the loose objects. */
  function roomObject(ix, room) {
    var floor = ix.floors[room.floor_id];
    var items = Object.keys(ix.items).map(function (id) { return ix.items[id]; }).filter(function (i) { return i.room_id === room.id; });
    var out = { kind: 'room', object_id: room.id, title: room.name, item_count: items.length };
    if (room.kind) out.room_kind = room.kind;
    if (floor) out.floor = floor.name;
    var furniture = Object.keys(ix.containers).map(function (id) { return ix.containers[id]; })
      .filter(function (c) { return c.room_id === room.id && !c.parent_container_id; });
    out.containers = furniture.slice(0, MAX_ROWS).map(function (c) {
      var inside = descendants(ix, c.id);
      var row = { id: c.id, name: c.name, item_count: items.filter(function (i) { return i.container_id && inside[i.container_id]; }).length };
      if (c.kind) row.kind = c.kind;
      return row;
    });
    if (furniture.length > MAX_ROWS) out.containers_truncated = furniture.length - MAX_ROWS;
    var loose = items.filter(function (i) { return !i.container_id; });
    out.loose_items = loose.slice(0, MAX_ITEMS).map(itemRow);
    if (loose.length > MAX_ITEMS) out.loose_items_truncated = loose.length - MAX_ITEMS;
    var tasks = tasksOf(ix, 'room', room.id);
    if (tasks.length) out.maintenance = tasks;
    return out;
  }

  /** A piece of furniture or box: where it is, its direct contents and the containers inside it. */
  function containerObject(ix, container) {
    var inside = descendants(ix, container.id);
    var items = Object.keys(ix.items).map(function (id) { return ix.items[id]; }).filter(function (i) { return i.container_id && inside[i.container_id]; });
    var direct = items.filter(function (i) { return i.container_id === container.id; });
    var out = { kind: 'container', object_id: container.id, title: container.name, room_id: container.room_id,
                location: locationText(ix, container.room_id, container.parent_container_id), item_count: items.length };
    if (container.kind) out.container_kind = container.kind;
    out.items = direct.slice(0, MAX_ITEMS).map(itemRow);
    if (direct.length > MAX_ITEMS) out.items_truncated = direct.length - MAX_ITEMS;
    var subs = Object.keys(ix.containers).map(function (id) { return ix.containers[id]; }).filter(function (c) { return c.parent_container_id === container.id; });
    if (subs.length) out.sub_containers = subs.slice(0, MAX_ROWS).map(function (c) { return { id: c.id, name: c.name }; });
    var tasks = tasksOf(ix, 'container', container.id);
    if (tasks.length) out.maintenance = tasks;
    return out;
  }

  function targetName(ix, task) {
    var table = { item: ix.items, container: ix.containers, room: ix.rooms, home: ix.homes }[task.target_kind];
    var row = table && table[task.target_id];
    return row ? row.name : undefined;
  }

  /** The maintenance list as the tab groups it (overdue / this month / later) plus the next tasks due. */
  function maintenanceSummary(ix, today) {
    var tasks = ix.tasks.filter(function (t) { return !t.paused; });
    var summary = { tasks: tasks.length, overdue: 0, this_month: 0, upcoming: 0 };
    var dated = tasks.filter(function (t) { return t.next_due; }).sort(function (a, b) { return a.next_due.localeCompare(b.next_due); });
    dated.forEach(function (t) {
      if (today && t.next_due < today) summary.overdue += 1;
      else if (today && t.next_due.slice(0, 7) === today.slice(0, 7)) summary.this_month += 1;
      else summary.upcoming += 1;
    });
    summary.next = dated.slice(0, MAX_TASKS).map(function (t) {
      var row = { id: t.id, title: t.title, next_due: t.next_due, target: t.target_kind };
      var name = targetName(ix, t);
      if (name) row.target_name = name;
      if (t.basis) row.basis = t.basis;
      return row;
    });
    return summary;
  }

  /** The visible inputs, sorted into the fields the app has: object name / details, search, manual search, others. */
  function readForms(inputs) {
    var out = { other: {} };
    (inputs || []).forEach(function (input) {
      if (!input || input.type === 'checkbox' || input.type === 'radio') return;
      var value = String(input.value == null ? '' : input.value).trim();
      var ph = String(input.ph || '');
      if (ph === '¿Qué objeto es?') out.name = value;
      else if (ph === 'Detalles…') out.description = value;
      else if (/^¿Dónde está/.test(ph)) out.query = value;
      else if (input.aria === 'Buscar en el manual') out.manual_query = value;
      else if (value) out.other[ph || input.aria || 'field'] = value;
    });
    return out;
  }

  /** Forms half filled in: the new-object form, edits of the open object, a search, any other field with text. */
  function editorState(page, forms, saved) {
    if (!forms) return null;
    var fields = {}, kind = null;
    if (page === 'add') {
      if (forms.name) fields.name = forms.name;
      if (forms.description) fields.description = forms.description;
      kind = 'new_item';
    } else if (page === 'item' && saved) {
      if (forms.name != null && forms.name !== saved.name) fields.name = forms.name;
      if (forms.description != null && forms.description !== String(saved.description || '')) fields.description = forms.description;
      kind = 'edit_item';
    } else if (page === 'search') {
      if (forms.query) fields.query = forms.query;
      kind = 'search';
    }
    if (page === 'item' && forms.manual_query) {
      if (kind === 'edit_item' && Object.keys(fields).length) fields.manual_query = forms.manual_query;
      else { fields = { query: forms.manual_query }; kind = 'manual_search'; }
    }
    var other = forms.other && Object.keys(forms.other).length ? forms.other : null;
    if (!Object.keys(fields).length) {
      if (!other) return null;
      return { kind: 'form', dirty: true, fields: other };
    }
    if (other) fields.other = other;
    return { kind: kind, dirty: true, fields: fields };
  }

  /**
   * The context additions for one turn. ``state`` = {path, tables, inputs, today, heading}. The project is the home the
   * open object belongs to (or the first home). On the list pages ``active_objects`` is [] and ``view.summary`` says
   * what they show; the open object, room or furniture is the only active object.
   */
  function buildContext(state) {
    state = state || {};
    var route = parseRoute(state.path);
    var ix = indexTables(state.tables);
    var view = { page: route.page };
    var objects = [];
    var home = firstHome(ix);
    var saved = null;
    if (route.page === 'item' || route.page === 'room' || route.page === 'container') {
      var table = { item: ix.items, room: ix.rooms, container: ix.containers }[route.page];
      var row = table[route.id];
      if (row) {
        var room = route.page === 'room' ? row : ix.rooms[row.room_id];
        home = homeOfRoom(ix, room) || home;
        if (route.page === 'item') { objects.push(itemObject(ix, row)); saved = row; }
        else if (route.page === 'room') objects.push(roomObject(ix, row));
        else objects.push(containerObject(ix, row));
      } else {
        // A URL is not a record. Offline references need the browser's actual store.
        var local = indexTables(state.localTables);
        var localTable = { item: local.items, room: local.rooms, container: local.containers }[route.page];
        var localRow = localTable[route.id];
        if (localRow) {
          var object = route.page === 'item' ? itemObject(local, localRow)
            : route.page === 'room' ? roomObject(local, localRow) : containerObject(local, localRow);
          object.unsynced = true;
          objects.push(object);
          if (route.page === 'item') saved = localRow;
          home = homeOfRoom(local, route.page === 'room' ? localRow : local.rooms[localRow.room_id]) || home;
        }
      }
    } else if (route.page === 'maintenance') {
      view.summary = maintenanceSummary(ix, state.today);
    } else if (route.page === 'home' || route.page === 'plan' || route.page === 'search' || route.page === 'settings') {
      var items = Object.keys(ix.items).map(function (id) { return ix.items[id]; });
      var rooms = Object.keys(ix.rooms).map(function (id) { return ix.rooms[id]; });
      view.summary = { items: items.length, containers: Object.keys(ix.containers).length,
                       rooms: rooms.slice(0, MAX_ROWS).map(function (r) {
                         return { id: r.id, name: r.name, items: items.filter(function (i) { return i.room_id === r.id; }).length };
                       }) };
    }
    var editor = editorState(route.page, state.forms, saved);
    if (editor) view.editor = editor;
    var out = { active_objects: objects, view: view };
    if (home) out.project = { external_project_id: home.id, title: home.name };
    return out;
  }

  var api = { buildContext: buildContext, parseRoute: parseRoute, indexTables: indexTables, itemObject: itemObject, roomObject: roomObject,
              containerObject: containerObject, maintenanceSummary: maintenanceSummary, readForms: readForms, editorState: editorState,
              MAX_ITEMS: MAX_ITEMS, MAX_ROWS: MAX_ROWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HomeHoardCopilot = api;

  // ---- wiring (browser only) ----
  if (typeof root.document === 'undefined' || !root.document.getElementById) return;

  var cache = { version: null, instance: null, tables: null };

  function readJson(url) {
    return root.fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /** The computer's tables; downloaded again only when its version changed. */
  async function tables() {
    var info = await readJson('/api/home/version');
    if (cache.tables && info.version === cache.version && info.instance === cache.instance) return cache.tables;
    var state = await readJson('/api/home');
    cache = { version: state.version, instance: state.instance, tables: state.tables || {} };
    return cache.tables;
  }

  function visibleInputs() {
    return Array.prototype.slice.call(root.document.querySelectorAll('input,textarea')).filter(function (e) { return e.offsetParent !== null; })
      .map(function (e) { return { type: e.type, ph: e.placeholder, aria: e.getAttribute('aria-label'), value: e.value }; });
  }

  function heading() {
    var node = root.document.querySelector('h1,[role=heading]');
    return node ? String(node.innerText || '').trim() : '';
  }

  function today() {
    var d = new Date();
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  async function context() {
    try {
      var data = null;
      try { data = await tables(); } catch (e) { /* the computer may be closed: the page's own title and forms still go */ }
      var local = null;
      try { local = JSON.parse(root.localStorage.getItem('homehoard.v1')); } catch (e) { /* no offline store */ }
      return buildContext({ path: root.location.pathname, tables: data, localTables: local, inputs: null, forms: readForms(visibleInputs()), today: today(), heading: heading() });
    } catch (e) {
      return { active_objects: [], view: { page: 'unknown' } };
    }
  }

  var timer = 0;
  function afterTurn() {
    cache = { version: null, instance: null, tables: null };
    // the app syncs with the computer when the window gets focus: ask it to now, without moving anything the person typed
    root.dispatchEvent(new root.Event('focus'));
  }

  /** The tab bar sits at the bottom of the window: the floating button goes above it, not over a tab. */
  function placeLauncher() {
    var bar = root.document.querySelector('[role=tablist]');
    var style = root.document.documentElement.style;
    if (bar && bar.offsetParent !== null) {
      var top = bar.getBoundingClientRect().top;
      var lift = Math.max(0, root.innerHeight - top) + 12;
      style.setProperty('--hoard-copilot-bottom', lift + 'px');
    } else {
      style.removeProperty('--hoard-copilot-bottom');
    }
  }

  var lastPath = null;
  function watchPage() {
    var check = function () {
      placeLauncher();
      if (root.location.pathname === lastPath) return;
      lastPath = root.location.pathname;
      root.dispatchEvent(new root.Event('hoard:copilot-context-changed'));
    };
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = root.history[name];
      root.history[name] = function () {
        var result = original.apply(this, arguments);
        setTimeout(soon, 0);
        return result;
      };
    });
    var scheduled = false;
    var soon = function () {      // the page re-renders a lot: look once per frame
      if (scheduled) return;
      scheduled = true;
      root.requestAnimationFrame(function () { scheduled = false; check(); });
    };
    root.addEventListener('popstate', soon);
    root.addEventListener('resize', soon);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(soon).observe(root.document.body, { childList: true, subtree: true });
    check();
  }

  root.hoardCopilot = {
    context: context,
    onTurnEnd: function () { clearTimeout(timer); timer = setTimeout(afterTurn, 150); },
  };
  watchPage();
})(typeof window !== 'undefined' ? window : globalThis);
