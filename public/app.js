const $ = (id) => document.getElementById(id);

// localStorage can be unavailable (private windows), so never depend on it
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

let token = store.get('token');
let data = null;
let view = 'files';
let folder = '/';
let layout = store.get('layout') || 'list';
const selected = new Set();

const KINDS = {
  image: { icon: '🖼️', label: 'Images', color: '#f59e0b', ext: 'png jpg jpeg gif webp bmp svg heic' },
  document: { icon: '📄', label: 'Documents', color: '#2563eb', ext: 'pdf doc docx ppt pptx xls xlsx csv txt md json html css js ts py java c cpp sql' },
  video: { icon: '🎬', label: 'Videos', color: '#db2777', ext: 'mp4 webm mov avi mkv' },
  audio: { icon: '🎵', label: 'Audio', color: '#7c3aed', ext: 'mp3 wav ogg m4a flac' },
  archive: { icon: '🗜️', label: 'Archives', color: '#059669', ext: 'zip rar 7z tar gz' },
  other: { icon: '📦', label: 'Other', color: '#6b7280', ext: '' }
};

function kindOf(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return Object.keys(KINDS).find((k) => KINDS[k].ext.split(' ').includes(ext) && ext) || 'other';
}

function fmtSize(bytes) {
  const b = Number(bytes);
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Builds an element. Text is always added as text, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) {
      // "form" is read-only as a property, so it has to be set as an attribute
      if (key in node && key !== 'form') node[key] = value; else node.setAttribute(key, value);
    }
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function toast(text, isError) {
  const t = el('div', { className: 'toast' + (isError ? ' error' : '') }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- server ----------

async function api(url, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error('Server not reachable. Is the app still running?');
  }

  const result = await response.json().catch(() => ({}));

  if (response.status === 401 && token && url !== '/api/login') {
    logout();
    throw new Error('Your session ended. Please log in again.');
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

// Runs an action, reports problems and reloads the list.
async function run(action, success) {
  try {
    await action();
    if (success) toast(success);
  } catch (err) {
    toast(err.message, true);
  }
  await refresh();
}

async function refresh() {
  if (!token) return;
  try {
    data = await api('/api/files');
  } catch (err) {
    if (token) toast(err.message, true);
    if (!data && token) {
      $('list').replaceChildren(emptyState('⚠️', 'Could not load your files.'),
        el('button', { className: 'primary gap-top', onclick: refresh }, 'Try again'));
    }
    return;
  }
  for (const id of selected) if (!data.mine.some((f) => f.id === id)) selected.delete(id);
  render();
}

// ---------- login ----------

function showLogin() {
  $('loginView').hidden = false;
  $('appView').hidden = true;
}

function showApp() {
  $('loginView').hidden = true;
  $('appView').hidden = false;
  refresh();
}

function logout() {
  token = null;
  data = null;
  view = 'files';
  folder = '/';
  selected.clear();
  store.remove('token');
  $('list').replaceChildren();
  $('account').textContent = '';
  $('password').value = '';
  $('search').value = '';
  $('dialog').close();
  showLogin();
}

$('authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const kind = event.submitter?.value || 'login';
  const message = $('authMessage');
  const buttons = $('authForm').querySelectorAll('button');
  const email = $('email').value.trim();
  const password = $('password').value;

  message.className = 'message';
  message.textContent = '';
  buttons.forEach((b) => { b.disabled = true; });

  try {
    if (!email || !password) throw new Error('Enter your email and password');
    const result = await api('/api/' + kind, { method: 'POST', body: { email, password } });

    if (kind === 'login') {
      token = result.token;
      store.set('token', token);
      $('password').value = '';
      showApp();
    } else {
      message.className = 'message good';
      message.textContent = 'Account created. Now click Log in.';
    }
  } catch (err) {
    message.textContent = err.message;
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
});

$('showPassword').addEventListener('change', (e) => { $('password').type = e.target.checked ? 'text' : 'password'; });

// ---------- folders ----------

// every folder, including parents of folders that only exist because of a file
function allFolders() {
  const set = new Set();
  for (const path of [...data.folders, ...data.mine.map((f) => f.folder)]) {
    const parts = path.split('/').filter(Boolean);
    parts.forEach((_, i) => set.add('/' + parts.slice(0, i + 1).join('/')));
  }
  return [...set].sort();
}

const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

function openFolder(path) {
  folder = path;
  selected.clear();
  render();
}

// ---------- rendering ----------

function visibleFiles() {
  const query = $('search').value.trim().toLowerCase();
  const type = $('typeFilter').value;
  let files = { starred: data.mine.filter((f) => f.starred), shared: data.shared, trash: data.trash }[view] || data.mine;

  // searching in "My files" looks through every folder
  if (view === 'files' && !query && !type) files = files.filter((f) => f.folder === folder);
  if (query) files = files.filter((f) => f.name.toLowerCase().includes(query));
  if (type) files = files.filter((f) => kindOf(f.name) === type);

  if (view === 'recent') return files.slice(0, 15);

  const order = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    name: (a, b) => a.name.localeCompare(b.name),
    size: (a, b) => Number(b.size) - Number(a.size)
  }[$('sort').value];

  return [...files].sort(order);
}

function emptyState(icon, text) {
  return el('div', { className: 'empty' }, el('span', {}, icon), text);
}

function iconButton(icon, label, onclick, className = 'icon') {
  return el('button', { className, title: label, 'aria-label': label, onclick }, icon);
}

function fileItem(file) {
  const mine = view !== 'shared' && view !== 'trash';
  const details = [fmtSize(file.size)];

  if (view === 'shared') details.push('from ' + file.owner, file.can_download ? 'can download' : 'view only');
  else details.push(view === 'trash' ? 'deleted ' + fmtDate(file.deleted_at) : fmtDate(file.created_at));
  if (mine && file.folder !== '/' && (view !== 'files' || file.folder !== folder)) details.push(file.folder);

  const item = el('div', { className: 'item' + (selected.has(file.id) ? ' selected' : '') });

  if (mine) {
    item.append(el('input', {
      type: 'checkbox', checked: selected.has(file.id), 'aria-label': 'Select ' + file.name,
      onchange: (e) => { e.target.checked ? selected.add(file.id) : selected.delete(file.id); render(); }
    }));
  }

  item.append(
    el('span', { className: 'symbol' }, KINDS[kindOf(file.name)].icon),
    el('div', { className: 'info' },
      view === 'trash'
        ? el('span', { className: 'name' }, file.name)
        : el('button', { className: 'name', onclick: () => preview(file) }, file.name),
      el('span', { className: 'muted' }, details.join(' · ')),
      mine && file.is_shared ? el('span', { className: 'badge' }, 'Shared') : null
    )
  );

  const actions = el('div', { className: 'actions' });

  if (view === 'trash') {
    actions.append(
      el('button', { className: 'small', onclick: () => run(() => api(`/api/files/${file.id}/restore`, { method: 'POST' }), 'File restored') }, 'Restore'),
      el('button', { className: 'small danger', onclick: () => deleteForever(file) }, 'Delete forever')
    );
  } else if (view === 'shared') {
    actions.append(iconButton('👁️', 'Preview', () => preview(file)));
    if (file.can_download) actions.append(iconButton('⬇️', 'Download', () => download(file)));
  } else {
    actions.append(
      iconButton(file.starred ? '⭐' : '☆', file.starred ? 'Remove star' : 'Add star',
        () => run(() => api(`/api/files/${file.id}`, { method: 'PATCH', body: { starred: !file.starred } }))),
      iconButton('⬇️', 'Download', () => download(file)),
      iconButton('🔗', 'Share', () => shareDialog(file)),
      iconButton('✏️', 'Rename', () => renameDialog(file)),
      iconButton('📂', 'Move', () => moveDialog([file])),
      iconButton('🗑️', 'Move to trash',
        () => run(() => api(`/api/files/${file.id}`, { method: 'DELETE' }), 'Moved to trash'))
    );
  }

  item.append(actions);
  return item;
}

function folderItem(path) {
  const count = data.mine.filter((f) => f.folder === path || f.folder.startsWith(path + '/')).length;
  const name = path.slice(path.lastIndexOf('/') + 1);

  return el('div', { className: 'item' },
    el('span', { className: 'symbol' }, '📁'),
    el('div', { className: 'info' },
      el('button', { className: 'name', onclick: () => openFolder(path) }, name),
      el('span', { className: 'muted' }, count === 1 ? '1 file' : `${count} files`)),
    el('div', { className: 'actions' }, iconButton('🗑️', 'Delete folder', () => deleteFolder(path, count)))
  );
}

function renderStorage() {
  const { used, quota } = data.usage;
  const totals = {};
  for (const f of [...data.mine, ...data.trash]) {
    const k = kindOf(f.name);
    totals[k] = (totals[k] || 0) + Number(f.size);
  }

  $('meter').replaceChildren(...Object.entries(totals).map(([k, size]) =>
    el('i', { style: `width:${(size / quota) * 100}%;background:${KINDS[k].color}`, title: KINDS[k].label })));
  $('usageText').textContent = `${fmtSize(used)} of ${fmtSize(quota)} used`;
  $('legend').replaceChildren(...Object.entries(totals).map(([k, size]) =>
    el('li', {}, el('i', { style: `background:${KINDS[k].color}` }), `${KINDS[k].label}: ${fmtSize(size)}`)));
}

function render() {
  if (!data) return;

  if (folder !== '/' && !allFolders().includes(folder)) folder = '/';

  const titles = { files: 'My files', recent: 'Recent', starred: 'Starred', shared: 'Shared with me', trash: 'Trash', activity: 'Activity' };
  $('title').textContent = titles[view];
  $('account').textContent = '👤 ' + data.email.split('@')[0];
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  renderStorage();

  // breadcrumbs
  const crumbs = [];
  if (view === 'files') {
    const parts = folder.split('/').filter(Boolean);
    crumbs.push(el('button', { onclick: () => openFolder('/') }, 'Home'));
    parts.forEach((p, i) => crumbs.push('›', el('button', { onclick: () => openFolder('/' + parts.slice(0, i + 1).join('/')) }, p)));
  } else if (view === 'trash') {
    crumbs.push(el('span', { className: 'muted' }, 'Files here still count towards your storage until deleted forever.'));
  }
  $('crumbs').replaceChildren(...crumbs);

  $('toolbar').hidden = view === 'activity';
  $('sort').hidden = view === 'recent';
  $('newFolderButton').hidden = view !== 'files';
  $('emptyTrashButton').hidden = view !== 'trash' || !data.trash.length;
  $('layoutButton').textContent = layout === 'list' ? '▦ Grid view' : '☰ List view';
  $('selectionBar').hidden = !selected.size;
  $('selectionCount').textContent = `${selected.size} selected`;

  if (view === 'activity') return renderActivity();

  const files = visibleFiles();
  const filtering = $('search').value.trim() || $('typeFilter').value;
  const folders = view === 'files' && !filtering ? allFolders().filter((p) => parentOf(p) === folder) : [];
  const items = [...folders.map(folderItem), ...files.map(fileItem)];

  if (!items.length) {
    const empty = filtering ? ['🔍', 'No files match your search.'] : {
      files: ['📂', 'This folder is empty. Upload files or drag them here.'],
      recent: ['🕘', 'Nothing uploaded yet.'],
      starred: ['⭐', 'Star a file to find it quickly.'],
      shared: ['👥', 'Nothing has been shared with you.'],
      trash: ['🗑️', 'The trash is empty.']
    }[view];
    $('list').replaceChildren(emptyState(...empty));
    return;
  }

  $('list').replaceChildren(el('div', { className: 'items' + (layout === 'grid' ? ' grid' : '') }, ...items));
}

async function renderActivity() {
  try {
    const logs = await api('/api/logs');
    if (view !== 'activity') return;
    $('list').replaceChildren(...(logs.length
      ? logs.map((x) => el('div', { className: 'log' },
        el('time', {}, new Date(x.created_at).toLocaleString()),
        el('span', {}, el('strong', {}, x.action.replaceAll('_', ' ')), ' ' + (x.detail || ''))))
      : [emptyState('📋', 'No activity yet.')]));
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- dialogs ----------

function openDialog(title, content, buttons = [], large = false) {
  const dialog = $('dialog');
  dialog.className = large ? 'large' : '';
  dialog.replaceChildren(
    el('h3', {}, title),
    ...content,
    el('div', { className: 'footer' }, el('button', { type: 'button', onclick: () => dialog.close() }, 'Close'), ...buttons)
  );
  if (!dialog.open) dialog.showModal();
}

// stops video and audio when the dialog closes
$('dialog').addEventListener('close', () => $('dialog').replaceChildren());

// A dialog with one field and a confirm button; Enter also confirms.
function formDialog(title, field, label, action) {
  const submit = el('button', { className: 'primary', type: 'submit', form: 'dialogForm' }, label);
  const form = el('form', {
    id: 'dialogForm',
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await action();
        $('dialog').close();
        await refresh();
      } catch (err) {
        toast(err.message, true);
        submit.disabled = false;
      }
    }
  }, el('div', { className: 'row' }, field));

  openDialog(title, [form], [submit]);
  field.focus();
}

function confirmDialog(title, text, label, action) {
  openDialog(title, [el('p', {}, text)], [
    el('button', {
      className: 'danger',
      onclick: () => { $('dialog').close(); run(action); }
    }, label)
  ]);
}

function renameDialog(file) {
  const input = el('input', { value: file.name, maxLength: 200, 'aria-label': 'New name' });
  formDialog('Rename file', input, 'Rename', () => api(`/api/files/${file.id}`, { method: 'PATCH', body: { name: input.value } }));
  const dot = file.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : file.name.length);
}

function moveDialog(files) {
  const select = el('select', { 'aria-label': 'Destination folder' },
    ...['/', ...allFolders()].map((p) => el('option', { value: p }, p === '/' ? 'Home' : p)));
  const title = files.length === 1 ? `Move "${files[0].name}"` : `Move ${files.length} files`;

  formDialog(title, select, 'Move', async () => {
    for (const f of files) await api(`/api/files/${f.id}`, { method: 'PATCH', body: { folder: select.value } });
    selected.clear();
    toast('Moved');
  });
}

function newFolder() {
  const input = el('input', { placeholder: 'Folder name', maxLength: 60, 'aria-label': 'Folder name' });
  formDialog('New folder', input, 'Create', async () => {
    const name = input.value.trim();
    if (!name || name.includes('/')) throw new Error('Enter a name without "/"');
    await api('/api/folders', { method: 'POST', body: { path: (folder === '/' ? '' : folder) + '/' + name } });
  });
}

function deleteFolder(path, count) {
  confirmDialog('Delete folder', `Delete "${path}"? ${count} file(s) inside will move to the trash.`, 'Delete folder',
    () => api('/api/folders', { method: 'DELETE', body: { path } }));
}

function deleteForever(file) {
  confirmDialog('Delete forever', `"${file.name}" will be permanently deleted. This cannot be undone.`, 'Delete forever',
    () => api(`/api/files/${file.id}/permanent`, { method: 'DELETE' }));
}

async function download(file) {
  try {
    const { url } = await api(`/api/files/${file.id}/download`);
    // a link click, so popup blockers do not interfere
    const link = el('a', { href: url });
    document.body.append(link);
    link.click();
    link.remove();
  } catch (err) {
    toast(err.message, true);
  }
}

async function preview(file) {
  const canDownload = file.can_download !== false;
  const buttons = canDownload ? [el('button', { className: 'primary', onclick: () => download(file) }, 'Download')] : [];

  openDialog(file.name, [el('p', { className: 'muted' }, 'Loading preview…')], buttons, true);

  try {
    const { kind, url } = await api(`/api/files/${file.id}/preview`);
    if (!$('dialog').open) return;

    const content = {
      image: () => el('img', { src: url, alt: file.name }),
      video: () => el('video', { src: url, controls: true }),
      audio: () => el('audio', { src: url, controls: true }),
      pdf: () => el('iframe', { src: url, title: file.name }),
      text: () => el('iframe', { src: url, title: file.name })
    }[kind];

    openDialog(file.name,
      [content ? el('div', { className: 'preview' }, content())
        : emptyState(KINDS[kindOf(file.name)].icon, 'No preview for this file type.')],
      buttons, true);
  } catch (err) {
    $('dialog').close();
    toast(err.message, true);
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    toast('Select the link and copy it', true);
  }
}

async function shareDialog(file, newLink) {
  let shares;
  try {
    shares = await api(`/api/files/${file.id}/shares`);
  } catch (err) {
    return toast(err.message, true);
  }

  const email = el('input', { type: 'email', placeholder: 'Email of a CloudVault user', 'aria-label': 'Email to share with' });
  const permission = el('select', { 'aria-label': 'Permission' },
    el('option', { value: 'download' }, 'Can view and download'),
    el('option', { value: 'view' }, 'View only'));
  const expiry = el('select', { 'aria-label': 'Expiry' },
    ...[[0, 'Never expires'], [1, 'Expires in 1 day'], [7, 'Expires in 7 days'], [30, 'Expires in 30 days']]
      .map(([v, t]) => el('option', { value: v }, t)));

  async function send(withEmail, button) {
    if (withEmail && !email.value.trim()) return toast('Enter an email address first', true);
    button.disabled = true;
    try {
      const result = await api(`/api/files/${file.id}/share`, {
        method: 'POST',
        body: {
          email: withEmail ? email.value.trim() : undefined,
          canDownload: permission.value === 'download',
          expiresInDays: Number(expiry.value)
        }
      });
      toast(withEmail ? 'File shared' : 'Link created');
      await refresh();
      shareDialog(file, result.link ? location.origin + result.link : null);
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  }

  const revoke = (url, method) => async () => {
    try {
      await api(url, { method });
      toast('Access removed');
      await refresh();
      shareDialog(file);
    } catch (err) {
      toast(err.message, true);
    }
  };

  const content = [
    el('div', { className: 'row field' }, permission, expiry),
    el('div', { className: 'row field' }, email,
      el('button', { className: 'primary', onclick: (e) => send(true, e.currentTarget) }, 'Share')),
    el('div', { className: 'row field' },
      el('button', { onclick: (e) => send(false, e.currentTarget) }, '🔗 Create link (anyone with it can open)'))
  ];

  if (newLink) {
    content.push(el('div', { className: 'row field' },
      el('input', { value: newLink, readOnly: true, onfocus: (e) => e.target.select(), 'aria-label': 'Share link' }),
      el('button', { className: 'primary', onclick: () => copy(newLink) }, 'Copy')));
  }

  content.push(el('strong', {}, 'Who has access'));
  if (!shares.length) content.push(el('p', { className: 'muted' }, 'Only you.'));

  for (const s of shares) {
    const info = [s.canDownload ? 'can download' : 'view only', s.expiresAt ? 'until ' + new Date(s.expiresAt).toLocaleString() : 'no expiry'];
    content.push(el('div', { className: 'access' },
      el('div', {}, s.email || 'Anyone with link …' + s.link.slice(-6), el('div', { className: 'muted' }, info.join(' · '))),
      el('div', { className: 'actions' },
        s.link ? el('button', { className: 'small', onclick: () => copy(location.origin + s.link) }, 'Copy') : null,
        el('button', { className: 'small danger', onclick: revoke(`/api/files/${file.id}/shares/${s.id}`, 'DELETE') }, 'Remove'))));
  }

  const buttons = shares.length
    ? [el('button', { className: 'danger', onclick: revoke(`/api/files/${file.id}/revoke`, 'POST') }, 'Revoke all access')]
    : [];

  openDialog(`Share "${file.name}"`, content, buttons);
}

function accountDialog() {
  const current = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password' });

  openDialog('Your account', [
    el('p', {}, data.email),
    el('strong', {}, 'Change password'),
    el('div', { className: 'row field' }, current, next)
  ], [
    el('button', {
      className: 'primary',
      onclick: async () => {
        try {
          await api('/api/password', { method: 'POST', body: { current: current.value, next: next.value } });
          $('dialog').close();
          toast('Password changed');
        } catch (err) {
          toast(err.message, true);
        }
      }
    }, 'Save password')
  ]);
}

// ---------- uploads ----------

function uploadOne(file, destination) {
  const bar = el('progress', { max: 100, value: 0 });
  const status = el('div', {}, file.name);
  const card = el('div', { className: 'upload' }, status, bar);
  $('uploads').append(card);

  return new Promise((resolve) => {
    const finish = (error) => {
      if (error) {
        card.classList.add('error');
        status.textContent = `${file.name}: ${error}`;
        bar.remove();
      } else {
        status.textContent = '✅ ' + file.name;
        bar.value = 100;
      }
      setTimeout(() => card.remove(), error ? 7000 : 2500);
      resolve();
    };

    if (data && file.size > data.maxFileBytes) return finish(`larger than ${fmtSize(data.maxFileBytes)}`);

    const form = new FormData();
    form.append('folder', destination);
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = (e.loaded / e.total) * 95; };
    xhr.onload = () => {
      if (xhr.status === 401) logout();
      let message;
      try { message = JSON.parse(xhr.responseText).error; } catch { /* not JSON, e.g. from a proxy */ }
      if (xhr.status === 200) finish();
      else finish(message || (xhr.status === 413 ? 'file is too large for the server' : 'upload failed'));
    };
    xhr.onerror = () => finish('server not reachable');
    xhr.send(form);
  });
}

async function uploadFiles(files) {
  if (!token || !files.length) return;
  const destination = view === 'files' ? folder : '/';
  for (const file of files) await uploadOne(file, destination);
  await refresh();
}

$('fileInput').addEventListener('change', (e) => {
  uploadFiles([...e.target.files]);
  e.target.value = '';
});

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!token || !hasFiles(e)) return;
  dragDepth++;
  $('dropZone').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('dropZone').hidden = true; }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropZone').hidden = true;
  uploadFiles([...e.dataTransfer.files]);
});

// ---------- buttons ----------

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
}

const chosen = () => data.mine.filter((f) => selected.has(f.id));

const actions = {
  pick: () => $('fileInput').click(),
  logout,
  theme: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
  account: () => data && accountDialog(),
  layout: () => { layout = layout === 'list' ? 'grid' : 'list'; store.set('layout', layout); render(); },
  newFolder: () => data && newFolder(),
  emptyTrash: () => confirmDialog('Empty trash', `Permanently delete ${data.trash.length} file(s)? This cannot be undone.`, 'Empty trash',
    () => api('/api/trash', { method: 'DELETE' })),
  bulkStar: () => run(async () => {
    for (const f of chosen()) await api(`/api/files/${f.id}`, { method: 'PATCH', body: { starred: true } });
    selected.clear();
  }, 'Starred'),
  bulkMove: () => moveDialog(chosen()),
  bulkTrash: () => run(async () => {
    for (const f of chosen()) await api(`/api/files/${f.id}`, { method: 'DELETE' });
    selected.clear();
  }, 'Moved to trash'),
  clearSelection: () => { selected.clear(); render(); }
};

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-action], [data-view]');
  if (!button) return;
  if (button.dataset.view) {
    view = button.dataset.view;
    selected.clear();
    $('search').value = '';
    $('typeFilter').value = '';
    $('list').replaceChildren();
    refresh();
    render();
  } else {
    actions[button.dataset.action]();
  }
});

$('search').addEventListener('input', () => { selected.clear(); render(); });
$('typeFilter').addEventListener('change', () => { selected.clear(); render(); });
$('sort').addEventListener('change', render);

setTheme(store.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
token ? showApp() : showLogin();
