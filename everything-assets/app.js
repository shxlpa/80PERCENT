const byId = id => document.getElementById(id);
const endpoint = action => '/api/everything?action=' + action;

async function request(action, options = {}) {
  const response = await fetch(endpoint(action), {cache: 'no-store', credentials: 'same-origin', ...options});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'The workspace could not be reached.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function jsonRequest(action, method, body) {
  return request(action, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

function bindLogin(form, input, submit, errorBox, success) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    errorBox.hidden = true;
    try {
      await jsonRequest('login', 'POST', {password: input.value});
      input.value = '';
      success();
    } catch (error) {
      errorBox.textContent = error.status === 401 ? 'That password didn’t work. Try again.' : error.message;
      errorBox.hidden = false;
      input.select();
    } finally {
      submit.disabled = false;
    }
  });
}

if (document.body.dataset.page === 'login') {
  bindLogin(byId('login-form'), byId('password'), byId('unlock'), byId('login-error'), () => location.replace('/everything/'));
} else {
  startEditor().catch(error => {
    byId('save-status').textContent = 'Couldn’t open';
    const notice = byId('notice');
    const retry = document.createElement('a');
    retry.href = '/everything/';
    retry.textContent = 'Try again';
    notice.replaceChildren(error.message + ' ', retry);
    notice.hidden = false;
  });
}

async function startEditor() {
  const [{createCanvas}, {bindShell, renderShell}, {sameScene, reconcile}] = await Promise.all([
    import('./canvas.js'), import('./shell.js'), import('./sync.js')
  ]);
  let signingIn;
  let leaving = false;
  let pendingUpload = false;
  let saveTimer;
  let noticeTimer;
  let running;
  let uncertainWrite;
  let lastState;
  const status = byId('save-status');
  const notice = byId('notice');
  function showStatus(label, state) {
    status.textContent = label;
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
      if (error.status !== 401) throw error;
      await unlock();
      return operation();
    }
  }

  let base = await authenticated(() => request('board'));
  let current = base.items;
  const canvas = createCanvas({
    viewport: byId('viewport'), world: byId('world'), items: current,
    imageUrl: id => endpoint('image') + '&id=' + encodeURIComponent(id),
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
      showStatus('Saving…', 'saving');
      schedule(250);
    }
  });
  bindShell(canvas);
  if (lastState) renderShell(lastState);
  if (current.length) canvas.zoomToFit();
  showStatus('Saved', 'saved');

  const dirty = () => Boolean(uncertainWrite) || !sameScene(current, base.items);
  function schedule(delay, checkRemote = false) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { sync(checkRemote).catch(() => {}); }, delay);
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
      if (remote.revision !== base.revision && !dirty() && canvas.canReplaceItems()) {
        base = remote;
        current = remote.items;
        canvas.setItems(current);
      }
    }
    while (dirty()) {
      const sent = current;
      showStatus('Saving…', 'saving');
      try {
        const saved = await authenticated(() => jsonRequest('board', 'PUT', {revision: base.revision, items: sent}));
        base = {revision: saved.revision, items: sent};
      } catch (error) {
        if (error.status !== 409) {
          if (!error.status || error.status >= 500) uncertainWrite = {revision: base.revision, items: sent};
          throw error;
        }
        const remote = await authenticated(() => request('board'));
        if (!canvas.canReplaceItems()) { schedule(500); return; }
        const merged = reconcile(base.items, current, remote.items);
        base = remote;
        current = merged.items;
        canvas.setItems(current);
        if (merged.copies) notify('This layer changed on two devices. Both versions are on your canvas.');
      }
    }
    showStatus('Saved', 'saved');
  }

  function sync(checkRemote = false) {
    if (running) return running;
    running = synchronize(checkRemote).catch(error => {
      const unsaved = dirty();
      showStatus(unsaved ? 'Unsaved' : 'Sync paused', 'error');
      // Apply backoff for connectivity and service failures. Invalid input needs an edit.
      if (!error.status || error.status >= 500 || error.status === 429) schedule(5000, true);
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
    if (event.data !== 'locked') return;
    canvas.finishEditing();
    if (dirty() || pendingUpload) unlock().then(() => sync()).catch(() => {});
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
  addEventListener('beforeunload', event => {
    canvas.finishEditing();
    if (dirty() || pendingUpload) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { canvas.finishEditing(); sync().catch(() => {}); }
    else if (canvas.canReplaceItems()) sync(true).catch(() => {});
  });
  addEventListener('online', () => sync(true).catch(() => {}));
  addEventListener('focus', () => { if (canvas.canReplaceItems()) sync(true).catch(() => {}); });
  addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
}
