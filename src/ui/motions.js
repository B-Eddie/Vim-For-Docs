  function buildKeysEditor(arrRef, onChange) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap = '6px';

    function render() {
      wrap.innerHTML = '';
      (arrRef || []).forEach((tok, i) => {
        const chip = document.createElement('span');
        chip.style.display = 'inline-flex';
        chip.style.alignItems = 'center';
        chip.style.border = '1px solid #e0e0e0';
        chip.style.borderRadius = '12px';
        chip.style.padding = '2px 8px';
        chip.style.fontSize = '12px';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(tok || '');
        input.style.border = 'none';
        input.style.outline = 'none';
        input.style.width = Math.max(24, (String(tok||'').length + 1) * 8) + 'px';
        input.addEventListener('input', () => { arrRef[i] = input.value.trim(); onChange(); });
        chip.appendChild(input);
        const rem = document.createElement('button'); rem.textContent = '×'; rem.title = 'Remove token'; rem.style.marginLeft = '4px'; rem.style.border = 'none'; rem.style.background='transparent'; rem.style.cursor='pointer'; rem.style.fontSize='14px';
        rem.addEventListener('click', () => { arrRef.splice(i,1); onChange(); render(); });
        chip.appendChild(rem);
        const sep = document.createElement('span'); sep.textContent = '→'; sep.style.margin = '0 2px'; sep.style.color = '#888';
        wrap.appendChild(chip);
        if (i < arrRef.length - 1) wrap.appendChild(sep);
      });
      const add = document.createElement('button');
      add.textContent = '+ token';
      add.style.padding = '2px 8px'; add.style.fontSize = '12px';
      add.addEventListener('click', () => { if (!Array.isArray(arrRef)) arrRef = []; arrRef.push(''); onChange(); render(); });
      wrap.appendChild(add);
    }
    render();
    return wrap;
  }

document.addEventListener('DOMContentLoaded', async function () {
  const apiScript = document.createElement('script');
  apiScript.src = chrome.runtime.getURL('browser-api.js');
  document.head.appendChild(apiScript);
  await new Promise(resolve => { apiScript.onload = resolve; });

  const $ = (sel) => document.querySelector(sel);
  const editor = $('#editor');
  const tabs = $('#sectionTabs');
  
  // Show accessibility warning if not dismissed
  try {
    const data = await window.browserAPI.storage.get(['hideA11yWarning']);
    const a11yWarning = $('#a11yWarning');
    if (a11yWarning && !data.hideA11yWarning) {
      a11yWarning.style.display = 'block';
    }
  } catch (e) {}
  
  // Handle dismissing the accessibility warning
  const dismissBtn = $('#dismissA11yWarning');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', async () => {
      try {
        await window.browserAPI.storage.set({ hideA11yWarning: true });
        const a11yWarning = $('#a11yWarning');
        if (a11yWarning) a11yWarning.style.display = 'none';
      } catch (e) {}
    });
  }
  const jsonArea = $('#jsonArea');
  const status = $('#status');
  const btnReset = $('#btn-reset');
  const btnSave = $('#btn-save');
  const modalBackdrop = $('#modalBackdrop');
  const modal = $('#modal');

  let baseConfig = null;
  let storedConfig = null;
  let currentConfig = null;
  let activeSection = 'motions';

  const MODES = ['normal','visual','visualLine','insert'];

  const SECTIONS = {
    motions: [
      { key: 'id', type: 'readonly', label: 'ID' },
      { key: 'keys', type: 'keys_cell', label: 'Keys' }
    ],
    operators: [
      { key: 'id', type: 'readonly', label: 'ID' },
      { key: 'keys', type: 'keys_cell', label: 'Keys' }
    ],
    textObjects: [
      { key: 'id', type: 'readonly', label: 'ID' },
      { key: 'type', type: 'readonly', label: 'Type' },
      { key: 'delims', type: 'delims_display', label: 'Delimiters' },
      { key: 'keys', type: 'keys_cell_textobj', label: 'Keys' }
    ],
    operatorSelf: [
      { key: 'operator', type: 'readonly', label: 'Operator' },
      { key: 'keys', type: 'keys_cell', label: 'Keys' }
    ],
    commands: [
      { key: 'id', type: 'readonly', label: 'ID' },
      { key: 'keys', type: 'keys_cell_command', label: 'Keys' }
    ]
  };

  function pretty(obj) {
    try { return JSON.stringify(obj, null, 2); } catch (_) { return ''; }
  }

  function deepClone(o) { return JSON.parse(JSON.stringify(o || {})); }

  async function loadBaseConfig() {
    try {
      const url = chrome.runtime.getURL('motions.json');
      const res = await fetch(url, { cache: 'no-cache' });
      const data = await res.json();
      return data;
    } catch (e) {
      return { motions: [], operators: [], textObjects: [], operatorSelf: [], commands: [], settings: {} };
    }
  }

  async function loadStoredConfig() {
    try {
      const localData = await window.browserAPI.storageLocal.get(['motionsConfig']);
      if (localData && typeof localData.motionsConfig !== 'undefined') {
        if (typeof localData.motionsConfig === 'string') {
          try { return JSON.parse(localData.motionsConfig); } catch (e) { return null; }
        }
        return localData.motionsConfig;
      }
    } catch (e) {}
    try {
      const syncData = await window.browserAPI.storage.get(['motionsConfig']);
      if (!syncData || typeof syncData.motionsConfig === 'undefined') return null;
      if (typeof syncData.motionsConfig === 'string') {
        try { return JSON.parse(syncData.motionsConfig); } catch (e) { return null; }
      }
      return syncData.motionsConfig;
    } catch (e) {
      return null;
    }
  }

  // removed preview rendering

  let dirty = false;
  function setStatusOk(msg) { status.className = 'status ok'; status.textContent = msg; }
  function setStatusErr(msg) { status.className = 'status err'; status.textContent = msg; }

  function tokensToStr(a) { return Array.isArray(a) ? a.join(' ') : ''; }
  function strToTokens(s) { return (s || '').trim() ? (s.trim().split(/\s+/)) : []; }
  function listToStr(a) { return Array.isArray(a) ? a.join(', ') : ''; }
  function strToList(s) { return (s || '').trim() ? s.split(',').map(x => x.trim()).filter(Boolean) : []; }
  function tokensEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (String(a[i] || '').trim() !== String(b[i] || '').trim()) return false;
    }
    return true;
  }
  function specialTokenValid(tok) {
    return /^<[A-Za-z][A-Za-z0-9-]*>$/.test(tok);
  }
  function hasDuplicateTokens(section, candidateTokens, selfItem, typeValue, modesValue) {
    const list = Array.isArray(currentConfig[section]) ? currentConfig[section] : [];
    return list.some(it => {
      if (it === selfItem) return false;
      if (!Array.isArray(it.keys)) return false;
      if (typeof typeValue !== 'undefined') {
        if ((it && typeof it === 'object' && 'type' in it ? it.type : undefined) !== typeValue) return false;
      }
      // Commands live in per-mode tries: the same keys in disjoint modes
      // (e.g. 'p' in normal vs visual) are not duplicates.
      if (section === 'commands' && Array.isArray(modesValue)) {
        const itModes = Array.isArray(it.modes) ? it.modes : ['normal'];
        if (!itModes.some(m => modesValue.includes(m))) return false;
      }
      return tokensEqual(it.keys, candidateTokens);
    });
  }

  function onConfigChange() {
    jsonArea.value = pretty(currentConfig);
    dirty = true;
  }

  // --- Modal helpers ---
  function showModal(contentNode) {
    modal.innerHTML = '';
    if (contentNode) modal.appendChild(contentNode);
    modalBackdrop.style.display = 'flex';
  }
  function hideModal() {
    modalBackdrop.style.display = 'none';
    modal.innerHTML = '';
  }
  modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) hideModal(); });

  function buildModalHeader(title) {
    const h = document.createElement('div');
    h.style.display = 'flex'; h.style.alignItems = 'center'; h.style.justifyContent = 'space-between';
    const t = document.createElement('h3'); t.textContent = title || '';
    h.appendChild(t);
    return h;
  }

  function openKeysModal(arrRef, saveCb, title, section, item) {
    const box = document.createElement('div');
    box.appendChild(buildModalHeader(title || 'Edit Keys'));
    const v = document.createElement('div'); v.id = 'modal-status'; v.className = 'status'; box.appendChild(v);
    const validateTokens = (tokens) => {
      if (!Array.isArray(tokens)) return 'Tokens must be a list';
      if (tokens.length < 1) return 'Add at least one token';
      for (let i = 0; i < tokens.length; i++) {
        const t = (tokens[i] || '').toString().trim();
        if (!t) return 'Empty token at position ' + (i + 1);
        if (t.length > 1 && !specialTokenValid(t)) return 'Invalid special token at position ' + (i + 1) + ' (use <...> format)';
      }
      return null;
    };
    const updateValid = () => {
      const err = validateTokens(tmp);
      if (!err) {
        if (section && hasDuplicateTokens(section, tmp, item, item && item.type)) {
          v.className = 'status err'; v.textContent = 'Invalid: Duplicate tokens already used in this section';
        } else { v.className = 'status ok'; v.textContent = 'Valid'; }
      } else { v.className = 'status err'; v.textContent = 'Invalid: ' + err; }
    };
    const tmp = Array.isArray(arrRef) ? arrRef.slice() : [];
    const ed = buildKeysEditor(tmp, () => { updateValid(); });
    box.appendChild(ed);
    const f = document.createElement('div'); f.className = 'footer';
    const help = document.createElement('button'); help.textContent = 'Help'; help.style.background='transparent'; help.style.border='none'; help.style.marginRight='auto'; help.style.color='var(--primary-color)'; help.style.cursor='pointer'; help.addEventListener('click', openHelpModal);
    const ok = document.createElement('button'); ok.textContent = 'Save'; ok.className = 'primary';
    ok.addEventListener('click', () => { arrRef.splice(0, arrRef.length, ...tmp); saveCb && saveCb(); hideModal(); });
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', hideModal);
    f.appendChild(help); f.appendChild(cancel); f.appendChild(ok); box.appendChild(f);
    updateValid();
    showModal(box);
  }

  function buildDelimsEditor(objRef, onChange) {
    // delims can be an array like ["(", ")"]
    const wrap = document.createElement('div');
    const row = document.createElement('div'); row.className = 'row';
    const l = document.createElement('label'); l.textContent = 'Left';
    const left = document.createElement('input'); left.type = 'text'; left.value = (Array.isArray(objRef.delims) && objRef.delims[0]) ? objRef.delims[0] : '';
    left.addEventListener('input', () => { const r = Array.isArray(objRef.delims) ? objRef.delims.slice() : ['', '']; r[0] = left.value; objRef.delims = r; onChange(); });
    row.appendChild(l); row.appendChild(left); wrap.appendChild(row);
    const row2 = document.createElement('div'); row2.className = 'row';
    const rlab = document.createElement('label'); rlab.textContent = 'Right';
    const right = document.createElement('input'); right.type = 'text'; right.value = (Array.isArray(objRef.delims) && objRef.delims[1]) ? objRef.delims[1] : '';
    right.addEventListener('input', () => { const r = Array.isArray(objRef.delims) ? objRef.delims.slice() : ['', '']; r[1] = right.value; objRef.delims = r; onChange(); });
    row2.appendChild(rlab); row2.appendChild(right); wrap.appendChild(row2);
    return wrap;
  }

  function openTextObjectModal(item, saveCb) {
    const box = document.createElement('div');
    box.appendChild(buildModalHeader('Edit Text Object'));
    const v = document.createElement('div'); v.id = 'modal-status'; v.className = 'status'; box.appendChild(v);
    const validateTokens = (tokens) => {
      if (!Array.isArray(tokens)) return 'Tokens must be a list';
      if (tokens.length < 1) return 'Add at least one token';
      for (let i = 0; i < tokens.length; i++) {
        const t = (tokens[i] || '').toString().trim();
        if (!t) return 'Empty token at position ' + (i + 1);
        if (t.length > 1 && !specialTokenValid(t)) return 'Invalid special token at position ' + (i + 1) + ' (use <...> format)';
      }
      return null;
    };
    const validateDelims = (d) => {
      if (!Array.isArray(d) || d.length < 2) return null;
      const L = (d[0] || '').toString().trim();
      const R = (d[1] || '').toString().trim();
      const hasLeft = L.length > 0;
      const hasRight = R.length > 0;
      if (hasLeft && !hasRight) return 'Right delimiter required (or clear both)';
      if (!hasLeft && hasRight) return 'Left delimiter required (or clear both)';
      return null;
    };
    const updateValid = () => {
      const e1 = validateTokens(tmpKeys);
      const e2 = validateDelims(tmpObj.delims);
      const dup = hasDuplicateTokens('textObjects', tmpKeys, item, item && item.type);
      const err = e1 || e2 || (dup ? 'Duplicate tokens already used in this section' : null);
      if (!err) { v.className = 'status ok'; v.textContent = 'Valid'; }
      else { v.className = 'status err'; v.textContent = 'Invalid: ' + err; }
    };
    const keysHeader = document.createElement('div'); keysHeader.textContent = 'Keys'; keysHeader.style.fontWeight = '600'; keysHeader.style.margin = '6px 0';
    box.appendChild(keysHeader);
    const tmpKeys = Array.isArray(item.keys) ? item.keys.slice() : [];
    const ed = buildKeysEditor(tmpKeys, () => { updateValid(); }); box.appendChild(ed);
    const delimsHeader = document.createElement('div'); delimsHeader.textContent = 'Delimiters'; delimsHeader.style.fontWeight = '600'; delimsHeader.style.margin = '12px 0 6px';
    box.appendChild(delimsHeader);
    const tmpObj = { delims: Array.isArray(item.delims) ? item.delims.slice() : ['', ''] };
    const delimsEd = buildDelimsEditor(tmpObj, () => { updateValid(); }); box.appendChild(delimsEd);
    const f = document.createElement('div'); f.className = 'footer';
    const help = document.createElement('button'); help.textContent = 'Help'; help.style.background='transparent'; help.style.border='none'; help.style.marginRight='auto'; help.style.color='var(--primary-color)'; help.style.cursor='pointer'; help.addEventListener('click', openHelpModal);
    const ok = document.createElement('button'); ok.textContent = 'Save'; ok.className = 'primary'; ok.addEventListener('click', () => { item.keys = tmpKeys; item.delims = Array.isArray(tmpObj.delims) ? tmpObj.delims.slice() : ['', '']; saveCb && saveCb(); hideModal(); });
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', hideModal);
    f.appendChild(help); f.appendChild(cancel); f.appendChild(ok); box.appendChild(f);
    updateValid();
    showModal(box);
  }

  function openCommandModal(item, saveCb) {
    const box = document.createElement('div');
    box.appendChild(buildModalHeader('Edit Command'));
    const v = document.createElement('div'); v.id = 'modal-status'; v.className = 'status'; box.appendChild(v);
    const validateTokens = (tokens) => {
      if (!Array.isArray(tokens)) return 'Tokens must be a list';
      if (tokens.length < 1) return 'Add at least one token';
      for (let i = 0; i < tokens.length; i++) {
        const t = (tokens[i] || '').toString().trim();
        if (!t) return 'Empty token at position ' + (i + 1);
        if (t.length > 1 && !specialTokenValid(t)) return 'Invalid special token at position ' + (i + 1) + ' (use <...> format)';
      }
      return null;
    };
    const updateValid = () => {
      const e1 = validateTokens(tmpKeys);
      const e2 = set.size ? null : 'Select at least one mode';
      const dup = hasDuplicateTokens('commands', tmpKeys, item, undefined, Array.from(set));
      const err = e1 || e2 || (dup ? 'Duplicate tokens already used in this section' : null);
      if (!err) { v.className = 'status ok'; v.textContent = 'Valid'; }
      else { v.className = 'status err'; v.textContent = 'Invalid: ' + err; }
    };
    const keysHeader = document.createElement('div'); keysHeader.textContent = 'Keys'; keysHeader.style.fontWeight = '600'; keysHeader.style.margin = '6px 0'; box.appendChild(keysHeader);
    const tmpKeys = Array.isArray(item.keys) ? item.keys.slice() : [];
    const ed = buildKeysEditor(tmpKeys, () => { updateValid(); }); box.appendChild(ed);
    const modesHeader = document.createElement('div'); modesHeader.textContent = 'Modes'; modesHeader.style.fontWeight = '600'; modesHeader.style.margin = '12px 0 6px'; box.appendChild(modesHeader);
    const modesBox = document.createElement('div');
    const set = new Set(Array.isArray(item.modes) ? item.modes : ['normal']);
    MODES.forEach(m => {
      const label = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = set.has(m);
      cb.addEventListener('change', () => {
        if (cb.checked) set.add(m); else set.delete(m);
        updateValid();
      });
      label.appendChild(cb); label.appendChild(document.createTextNode(' ' + m + ' '));
      modesBox.appendChild(label);
    });
    box.appendChild(modesBox);
    const f = document.createElement('div'); f.className = 'footer';
    const help = document.createElement('button'); help.textContent = 'Help'; help.style.background='transparent'; help.style.border='none'; help.style.marginRight='auto'; help.style.color='var(--primary-color)'; help.style.cursor='pointer'; help.addEventListener('click', openHelpModal);
    const ok = document.createElement('button'); ok.textContent = 'Save'; ok.className = 'primary'; ok.addEventListener('click', () => { item.keys = tmpKeys; item.modes = Array.from(set); saveCb && saveCb(); hideModal(); });
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', hideModal);
    f.appendChild(help); f.appendChild(cancel); f.appendChild(ok); box.appendChild(f);
    updateValid();
    showModal(box);
  }

  function buildKeysCell(arrRef, onSave, section, item) {
    const cont = document.createElement('div'); cont.style.position = 'relative';
    // tokens display
    const text = document.createElement('div'); text.style.minHeight = '24px'; text.style.fontFamily = 'ui-monospace, monospace'; text.style.fontSize = '12px'; text.style.color = '#444';
    text.textContent = tokensToStr(arrRef);
    const btn = document.createElement('button'); btn.textContent = 'Edit'; btn.style.position = 'absolute'; btn.style.right = '0'; btn.style.top = '0'; btn.style.background='transparent'; btn.style.border='none'; btn.style.color='var(--primary-color)'; btn.style.padding='0'; btn.style.fontSize='12px'; btn.style.cursor='pointer';
    btn.addEventListener('click', () => { openKeysModal(arrRef, () => { onSave && onSave(); text.textContent = tokensToStr(arrRef); }, 'Edit Keys', section, item); });
    cont.appendChild(text); cont.appendChild(btn);
    return cont;
  }

  function buildRow(section, item, idx) {
    const cols = SECTIONS[section];
    const tr = document.createElement('tr');
    cols.forEach(col => {
      const td = document.createElement('td');
      let input;
      if (col.type === 'readonly') {
        const span = document.createElement('span');
        span.textContent = String(item[col.key] || '');
        input = span;
      } else if (col.type === 'text') {
        input = document.createElement('input'); input.type = 'text'; input.value = String(item[col.key] || '');
        input.addEventListener('change', () => { item[col.key] = input.value; onConfigChange(); });
      } else if (col.type === 'keys_cell') {
        if (!Array.isArray(item[col.key])) item[col.key] = [];
        input = buildKeysCell(item[col.key], onConfigChange, section, item);
      } else if (col.type === 'keys_cell_textobj') {
        if (!Array.isArray(item[col.key])) item[col.key] = [];
        // open combined editor for textobj (keys + delims)
        const cont = document.createElement('div'); cont.style.position = 'relative';
        const text = document.createElement('div'); text.style.minHeight = '24px'; text.style.fontFamily = 'ui-monospace, monospace'; text.style.fontSize = '12px'; text.style.color = '#444';
        text.textContent = tokensToStr(item[col.key]);
        const btn = document.createElement('button'); btn.textContent = 'Edit'; btn.style.position = 'absolute'; btn.style.right = '0'; btn.style.top = '0'; btn.style.background='transparent'; btn.style.border='none'; btn.style.color='var(--primary-color)'; btn.style.padding='0'; btn.style.fontSize='12px'; btn.style.cursor='pointer';
        btn.addEventListener('click', () => { openTextObjectModal(item, () => { onConfigChange(); buildEditor(); }); });
        cont.appendChild(text); cont.appendChild(btn);
        input = cont;
      } else if (col.type === 'list') {
        input = document.createElement('input'); input.type = 'text'; input.value = listToStr(item[col.key]);
        input.addEventListener('change', () => { item[col.key] = strToList(input.value); onConfigChange(); });
      } else if (col.type === 'readonly_target') {
        const span = document.createElement('span'); span.textContent = (item && item.target && item.target.type) ? String(item.target.type) : '';
        input = span;
      } else if (col.type === 'delims_display') {
        const text = document.createElement('div'); text.style.minHeight = '24px'; text.style.fontFamily = 'ui-monospace, monospace'; text.style.fontSize = '12px'; text.style.color = '#444';
        text.textContent = (Array.isArray(item.delims) ? item.delims.join(' , ') : '');
        input = text;
      } else if (col.type === 'keys_cell_command') {
        if (!Array.isArray(item[col.key])) item[col.key] = [];
        const cont = document.createElement('div'); cont.style.position = 'relative';
        const text = document.createElement('div'); text.style.minHeight = '24px'; text.style.fontFamily = 'ui-monospace, monospace'; text.style.fontSize = '12px'; text.style.color = '#444';
        text.textContent = tokensToStr(item[col.key]);
        const btn = document.createElement('button'); btn.textContent = 'Edit'; btn.style.position = 'absolute'; btn.style.right = '0'; btn.style.top = '0'; btn.style.background='transparent'; btn.style.border='none'; btn.style.color='var(--primary-color)'; btn.style.padding='0'; btn.style.fontSize='12px'; btn.style.cursor='pointer';
        btn.addEventListener('click', () => { openCommandModal(item, () => { onConfigChange(); text.textContent = tokensToStr(item[col.key]); }); });
        cont.appendChild(text); cont.appendChild(btn);
        input = cont;
      }
      td.appendChild(input);
      tr.appendChild(td);
    });
    // No row deletion allowed
    return tr;
  }

  function buildEditor() {
    const section = activeSection;
    const cols = SECTIONS[section];
    const wrapper = document.createElement('div');
    // Adding new rows is disabled to avoid breaking IDs and semantics

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    const thead = document.createElement('thead');
    const hdr = document.createElement('tr');
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col.label; th.style.textAlign = 'left'; th.style.padding = '4px 6px'; hdr.appendChild(th); });
    // No Actions column
    thead.appendChild(hdr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    (currentConfig[section] || []).forEach((item, idx) => {
      const tr = buildRow(section, item, idx);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    editor.innerHTML = '';
    editor.appendChild(wrapper);
  }

  // Help modal
  function openHelpModal() {
    const box = document.createElement('div');
    box.appendChild(buildModalHeader('Help'));
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="row"><small>
        Keys are tokenized sequences. Examples:<br>
        - Single keys: h j k l x %<br>
        - Special tokens: &lt;ESC&gt;, &lt;C-W&gt;, &lt;C-R&gt;, &lt;char&gt;<br>
        - Multi-part: g g, g ~, [ ] etc.<br>
        Click "Edit" in a row to modify its tokens. For Text Objects, the editor also allows setting delimiters.
      </small></div>
      <div class="row"><small>
        Non-editable fields (ID, Operator, Target Type) are fixed to preserve behavior.
      </small></div>
    `;
    box.appendChild(content);
    const f = document.createElement('div'); f.className = 'footer';
    const close = document.createElement('button'); close.textContent = 'Close'; close.addEventListener('click', hideModal);
    f.appendChild(close); box.appendChild(f);
    showModal(box);
  }
  // help now lives inside each modal

  function switchTab(next) {
    activeSection = next;
    Array.from(tabs.querySelectorAll('.tab')).forEach(b => {
      if (b.getAttribute('data-section') === next) b.classList.add('active'); else b.classList.remove('active');
    });
    buildEditor();
  }

  function validateJson(text) {
    try {
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object') throw new Error('Top-level must be an object');
      const lists = ['motions','operators','textObjects','operatorSelf','commands'];
      lists.forEach(k => { if (!Array.isArray(obj[k])) obj[k] = []; });
      if (!obj.settings || typeof obj.settings !== 'object') obj.settings = {};
      for (const m of obj.motions) { if (!m.id || !Array.isArray(m.keys)) throw new Error('Each motion needs id and keys'); }
      for (const c of obj.commands) { if (!c.id || !Array.isArray(c.keys)) throw new Error('Each command needs id and keys'); }
      return { ok: true, value: obj };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  async function init() {
    baseConfig = await loadBaseConfig();
    storedConfig = await loadStoredConfig();
    currentConfig = deepClone(storedConfig || baseConfig);
    ['motions','operators','textObjects','operatorSelf','commands'].forEach(k => { if (!Array.isArray(currentConfig[k])) currentConfig[k] = []; });
    jsonArea.value = pretty(currentConfig);
    buildEditor();
    Array.from(tabs.querySelectorAll('.tab')).forEach(b => {
      b.addEventListener('click', () => switchTab(b.getAttribute('data-section')));
    });
    switchTab('motions');
    dirty = false;
    window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  btnReset.addEventListener('click', async () => {
    const box = document.createElement('div');
    box.appendChild(buildModalHeader('Reset to Default'));
    const msg = document.createElement('div'); msg.style.margin = '8px 0'; msg.textContent = 'This will discard all your custom motions and restore defaults.'; box.appendChild(msg);
    const f = document.createElement('div'); f.className = 'footer';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', hideModal);
    const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.className = 'primary'; reset.addEventListener('click', async () => {
      try {
        await window.browserAPI.storageLocal.remove('motionsConfig');
        try { await window.browserAPI.storage.remove('motionsConfig'); } catch (_) {}
        storedConfig = null;
        currentConfig = deepClone(baseConfig);
        jsonArea.value = pretty(currentConfig);
        buildEditor();
        setStatusOk('Reset to default');
      } catch (e) {
        setStatusErr('Failed to reset: ' + (e.message || e));
      } finally { hideModal(); }
    });
    f.appendChild(cancel); f.appendChild(reset); box.appendChild(f);
    showModal(box);
  });

  btnSave.addEventListener('click', async () => {
    let toSave = currentConfig;
    if (jsonArea && jsonArea.value && jsonArea.value.trim() && jsonArea.value.trim() !== pretty(currentConfig).trim()) {
      const res = validateJson(jsonArea.value);
      if (res.ok) toSave = res.value; else setStatusErr('Raw JSON ignored: ' + res.error);
    }
    try {
      await window.browserAPI.storageLocal.set({ motionsConfig: toSave });
      setStatusOk('Saved');
      currentConfig = deepClone(toSave);
      jsonArea.value = pretty(currentConfig);
      dirty = false;
    } catch (e) {
      setStatusErr('Failed to save: ' + (e.message || e));
    }
  });

  // passive json validation while typing
  let t;
  jsonArea.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const res = validateJson(jsonArea.value);
      if (res.ok) setStatusOk('Valid JSON'); else setStatusErr('Invalid: ' + res.error);
      dirty = true;
    }, 300);
  });

  init();
});
