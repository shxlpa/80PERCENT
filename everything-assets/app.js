const byId = id => document.getElementById(id);
const endpoint = action => '/api/everything?action=' + action;

// Only this document holds the session. A new navigation starts at the password form.
let sessionToken;
let pageExited = false;
let flushBeforeExit;

async function fetchAction(action, options = {}, token = sessionToken) {
  const headers = new Headers(options.headers);
  if (token && action !== 'login') headers.set('Authorization', 'Bearer ' + token);
  const signal = action === 'board' ? AbortSignal.timeout?.(30_000) : undefined;
  const response = await fetch(endpoint(action), {cache: 'no-store', signal, ...options, headers});
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const error = new Error(result?.error || 'The workspace could not be reached.');
    error.status = response.status;
    throw error;
  }
  return response;
}

async function request(action, options = {}) {
  const response = await fetchAction(action, options);
  const result = await response.json().catch(() => null);
  if (!result || (action === 'board' && !options.method &&
      (!Number.isSafeInteger(result.revision) || !Array.isArray(result.items)))) {
    throw new Error('The server response could not be confirmed.');
  }
  return result;
}

function jsonRequest(action, method, value) {
  const body = JSON.stringify(value);
  // A small save already in flight can then finish even if the page closes.
  // The fetch keepalive budget applies to encoded bytes across pending requests.
  const keepalive = action === 'board' && body.length <= 65_536 && new Blob([body]).size <= 65_536;
  return request(action, {method, headers: {'Content-Type': 'application/json'}, body, keepalive});
}

function bindLogin(form, input, submit, errorBox, success) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    errorBox.hidden = true;
    try {
      const {token} = await jsonRequest('login', 'POST', {password: input.value});
      if (!token) throw new Error('The login could not be confirmed.');
      sessionToken = token;
      if (pageExited) { discardSession(); return; }
      input.value = '';
      await success();
    } catch (error) {
      errorBox.textContent = error.status === 401 ? 'That password didn’t work. Try again.' : error.message;
      errorBox.hidden = false;
      input.select();
    } finally {
      submit.disabled = false;
    }
  });
}

function discardSession(finalSave) {
  const token = sessionToken;
  sessionToken = undefined;
  if (!token) return;
  // Revocation is best effort on tab close. Dropping the in-memory token locks
  // the next visit even when the browser cannot deliver this last request.
  const revoke = () => fetchAction('logout', {method: 'POST', keepalive: true}, token).catch(() => {});
  if (finalSave) finalSave.then(revoke, revoke);
  else revoke();
}

addEventListener('pagehide', () => {
  pageExited = true;
  document.documentElement.style.visibility = 'hidden';
  discardSession(flushBeforeExit?.());
});
addEventListener('pageshow', event => {
  // A restored history entry can retain its DOM as well as its JavaScript heap.
  if (event.persisted) location.reload();
});

bindLogin(byId('login-form'), byId('password'), byId('unlock'), byId('login-error'), async () => {
  const response = await fetchAction('page');
  const editor = new DOMParser().parseFromString(await response.text(), 'text/html');
  if (pageExited) return;
  if (editor.body.dataset.page !== 'editor') throw new Error('Please unlock the workspace again.');
  document.title = editor.title;
  document.querySelector('meta[name="theme-color"]').content = editor.querySelector('meta[name="theme-color"]').content;
  document.body.replaceWith(editor.body);
  startEditor().catch(error => {
    byId('save-status').textContent = 'Couldn’t open';
    const notice = byId('notice');
    const retry = document.createElement('a');
    retry.href = '/everything/';
    retry.textContent = 'Try again';
    notice.replaceChildren(error.message + ' ', retry);
    notice.hidden = false;
  });
});

async function startEditor() {
  const [{createCanvas}, {bindShell, renderShell}, {sameScene, reconcile}] = await Promise.all([
    import('./canvas.js'), import('./shell.js'), import('./sync.js')
  ]);
  let signingIn;
  let leaving = false;
  let pendingUpload = false;
  let saveTimer;
  let firstEditAt;
  let retryTimer;
  let noticeTimer;
  let running;
  let writing = false;
  let uncertainWrite;
  let lastState;
  const status = byId('save-status');
  const notice = byId('notice');
  function showStatus(label, state) {
    if (status.textContent !== label) status.textContent = label;
    status.dataset.state = state;
  }

  function notify(message) {
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.hidden = false;
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
  }

  // Re-authenticate in place so unsaved text and uploaded-file gestures survive expiry.
  function unlock() {
    if (signingIn) return signingIn;
    signingIn = new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'session-dialog';
      dialog.innerHTML = '<form><h2>Unlock Everything</h2><p>Enter your password to keep editing.</p><label>Password<input type="password" autocomplete="current-password" required></label><p role="alert" hidden></p><button type="submit">Unlock</button></form>';
      document.body.append(dialog);
      dialog.addEventListener('cancel', event => event.preventDefault());
      bindLogin(dialog.querySelector('form'), dialog.querySelector('input'), dialog.querySelector('button'), dialog.querySelector('[role=alert]'), () => {
        dialog.close();
        dialog.remove();
        signingIn = null;
        resolve();
      });
      dialog.showModal();
    });
    return signingIn;
  }

  async function authenticated(operation) {
    try { return await operation(); }
    catch (error) {
      if (pageExited || error.status !== 401) throw error;
      await unlock();
      return operation();
    }
  }

  let base = await authenticated(() => request('board'));
  let current = base.items;
  const canvas = createCanvas({
    viewport: byId('viewport'), world: byId('world'), items: current,
    loadImage: id => authenticated(async () => {
      const response = await fetchAction('image&id=' + encodeURIComponent(id));
      return response.blob();
    }),
    uploadImage: async file => {
      const image = await authenticated(() => request('image', {
        method: 'POST', headers: {'Content-Type': file.type || 'application/octet-stream'}, body: file
      }));
      return image.id;
    },
    onError: error => notify(error.message || String(error)),
    onState(state) {
      lastState = state;
      pendingUpload = Boolean(state.busy);
      renderShell(state);
    },
    onChange(items) {
      current = items;
      if (!retryTimer) {
        showStatus('Saving…', 'saving');
        scheduleEdit();
      }
    }
  });
  bindShell(canvas);
  if (lastState) renderShell(lastState);
  if (current.length) canvas.zoomToFit();
  showStatus('Autosaved', 'saved');

  const dirty = () => Boolean(uncertainWrite) || !sameScene(current, base.items);
  const hasPendingChanges = () => writing || pendingUpload || dirty();
  function scheduleEdit() {
    const now = performance.now();
    firstEditAt ??= now;
    clearTimeout(saveTimer);
    // Debounce a burst of typing, with a deadline for uninterrupted typing.
    const delay = Math.min(250, Math.max(0, firstEditAt + 1500 - now));
    saveTimer = setTimeout(() => sync().catch(() => {}), delay);
  }

  function retry(delay, checkRemote = false) {
    clearTimeout(saveTimer);
    firstEditAt = undefined;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => sync(checkRemote).catch(() => {}), delay);
  }

  async function synchronize(checkRemote) {
    if (uncertainWrite) {
      const remote = await authenticated(() => request('board'));
      if (remote.revision === uncertainWrite.revision + 1 && sameScene(remote.items, uncertainWrite.items)) {
        base = remote;
      }
      uncertainWrite = null;
    }
    if (checkRemote && !dirty()) {
      const remote = await authenticated(() => request('board'));
      // An edit may have started while this read was in flight.
      if (remote.revision > base.revision && !dirty() && canvas.canReplaceItems()) {
        const wasEmpty = current.length === 0;
        base = remote;
        current = remote.items;
        canvas.setItems(current);
        if (wasEmpty && current.length) canvas.zoomToFit();
      }
    }
    while (dirty()) {
      const sent = current;
      showStatus('Saving…', 'saving');
      writing = true;
      try {
        const saved = await authenticated(() => jsonRequest('board', 'PUT', {revision: base.revision, items: sent}));
        if (saved.revision !== base.revision + 1) throw new Error('The save could not be confirmed.');
        base = {revision: saved.revision, items: sent};
      } catch (error) {
        if (error.status !== 409) {
          if (!error.status || error.status >= 500) uncertainWrite = {revision: base.revision, items: sent};
          throw error;
        }
        const remote = await authenticated(() => request('board'));
        if (!canvas.canReplaceItems()) { retry(750); return; }
        const merged = reconcile(base.items, current, remote.items);
        base = remote;
        current = merged.items;
        canvas.setItems(current);
        if (merged.copies) notify('This layer changed on two devices. Both versions are on your canvas.');
      } finally {
        writing = false;
      }
    }
    showStatus('Autosaved', 'saved');
  }

  function sync(checkRemote = false) {
    clearTimeout(saveTimer);
    firstEditAt = undefined;
    if (running) return running;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    running = synchronize(checkRemote).catch(error => {
      const unsaved = dirty();
      showStatus(unsaved ? 'Unsaved' : 'Sync paused', 'error');
      // Apply backoff for connectivity and service failures. Invalid input needs an edit.
      if (!error.status || error.status >= 500 || error.status === 429) retry(5000, true);
      notify(unsaved ? 'Changes are still in this tab. ' + error.message : error.message);
      throw error;
    }).finally(() => { running = null; });
    return running;
  }

  async function leave(logout) {
    if (leaving) return;
    if (pendingUpload) { notify('Please wait for your image to finish uploading.'); return; }
    leaving = true;
    // A session dialog must remain usable if the final save needs authentication.
    const controls = [...document.body.children].filter(node => node.tagName !== 'DIALOG' && !node.inert);
    try {
      canvas.finishEditing();
      controls.forEach(node => { node.inert = true; });
      await sync();
      if (dirty()) return;
      if (logout) {
        try { await jsonRequest('logout', 'POST', {}); }
        catch (error) { if (error.status !== 401) throw error; }
        sessionToken = undefined;
        authChannel?.postMessage('locked');
        location.replace('/everything/');
      } else location.assign('/');
    } catch (error) {
      notify('Unable to leave safely. ' + error.message);
    } finally {
      controls.forEach(node => { node.inert = false; });
      leaving = false;
    }
  }

  const authChannel = 'BroadcastChannel' in window ? new BroadcastChannel('everything-session') : null;
  authChannel?.addEventListener('message', event => {
    if (event.data !== 'locked' || pageExited) return;
    discardSession();
    canvas.finishEditing();
    if (hasPendingChanges()) unlock().then(() => sync()).catch(() => {});
    else location.replace('/everything/');
  });
  byId('logout').addEventListener('click', () => leave(true));
  for (const link of document.querySelectorAll('a[href="/"]')) {
    link.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      leave(false);
    });
  }
  function flush() {
    canvas.finishEditing();
    if (dirty() || running) return sync().catch(() => {});
  }
  flushBeforeExit = flush;
  addEventListener('beforeunload', event => {
    flush();
    if (hasPendingChanges()) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
    else if (canvas.canReplaceItems()) sync(true).catch(() => {});
  });
  addEventListener('online', () => sync(true).catch(() => {}));
  addEventListener('focus', () => { if (canvas.canReplaceItems()) sync(true).catch(() => {}); });
}
