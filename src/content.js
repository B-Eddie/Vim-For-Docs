(() => {
  const IS_BROWSER = typeof browser !== 'undefined';
  const API = IS_BROWSER ? browser : chrome;

  let parser = null;
  let useDisplayLines = false;
  let executor = null;
  let mode = 'insert'; // normal | insert | visual | visualLine
  let tempNormal = false; // from <C-O>
  let replaceMode = false;

  // --- insert repeat bookkeeping (for '.') ---
  let insertOps = [];
  function resetInsertOps() { insertOps = []; }
  function appendOpText(s) {
    if (!s) return;
    const last = insertOps[insertOps.length - 1];
    if (last && last.type === 'text') last.value += s;
    else insertOps.push({ type: 'text', value: s });
  }
  function appendOpBs() {
    const last = insertOps[insertOps.length - 1];
    if (last && last.type === 'text' && last.value.length > 0) {
      last.value = last.value.slice(0, -1);
      if (!last.value) insertOps.pop();
      return;
    }
    if (last && last.type === 'bs') last.count++;
    else insertOps.push({ type: 'bs', count: 1 });
  }

  let uiTheme = 'vim';
  let ui = null;
  let vimEnabled = true;

  // ---------------------------------------------------------------------------
  // Command-line state (":", "/", "?") — authentic Vim command-line
  // ---------------------------------------------------------------------------
  // cmdline corresponds to Vim's cmdline-mode: the whole bottom line becomes
  // an editable buffer with its own cursor. History (like Vim's cmdline_hist)
  // is kept per type.
  let cmdline = null; // { type: ':'|'/'|'?', text: string, pos: number, histIndex: number|null }
  const searchHist = []; // most recent first
  const exHist = [];
  const MAX_HIST = 50;
  let pendingOperatorCmdline = null; // { operator, count, register } for d/pattern

  function pushHist(list, entry) {
    if (!entry) return;
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    list.unshift(entry);
    if (list.length > MAX_HIST) list.pop();
  }

  function openCmdline(type, initialText) {
    const pref = type === ':' ? '' : '';
    const seed = initialText != null ? String(initialText) : '';
    // If there's a pending operator (e.g. "d"), remember it so "/" becomes d/pat
    // like Vim's operator-pending search (d/pat<CR> deletes to the match).
    let opBuf = null;
    try {
      if (parser && parser.buffer && parser.buffer.length && type !== ':') {
        // Borrow parser's pending buffer before we reset it
        opBuf = { keys: parser.buffer.slice(), operator: parser.operatorMeta ? parser.operatorMeta.id : null };
      }
    } catch (_) {}
    try { if (parser) parser.reset(); } catch (_) {}
    if (ui) try { ui.setBufferText(''); ui.clearMessage && ui.clearMessage(); } catch (_) {}
    cmdline = { type: type, text: seed + pref, pos: (seed + pref).length, histIndex: null, savedText: seed + pref, opBuf: opBuf };
    // Initial render
    try { if (ui) ui.setCmdline(type, cmdline.text, cmdline.pos); } catch (_) {}
    refreshShowCmd();
  }

  function closeCmdline() {
    cmdline = null;
    try { if (ui) ui.clearCmdline && ui.clearCmdline(); } catch (_) {}
    // Return focus so typing continues in Docs
    try { focusEditorQuick(); } catch (_) {}
  }

  function cmdIns(ch) {
    if (!cmdline) return;
    const t = cmdline.text;
    const p = cmdline.pos;
    cmdline.text = t.slice(0, p) + ch + t.slice(p);
    cmdline.pos = p + ch.length;
    cmdline.histIndex = null;
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdBackspace() {
    if (!cmdline || cmdline.pos === 0) return;
    const t = cmdline.text;
    const p = cmdline.pos;
    cmdline.text = t.slice(0, p - 1) + t.slice(p);
    cmdline.pos--;
    cmdline.histIndex = null;
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdDel() {
    if (!cmdline) return;
    const t = cmdline.text;
    const p = cmdline.pos;
    if (p >= t.length) return;
    cmdline.text = t.slice(0, p) + t.slice(p + 1);
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdKillWord() {
    if (!cmdline || cmdline.pos === 0) return;
    let p = cmdline.pos;
    const t = cmdline.text;
    // Vim: CTRL-W deletes the word before cursor (iskeyword). Simplify: non-space run.
    while (p > 0 && t[p - 1] === ' ') p--;
    while (p > 0 && t[p - 1] !== ' ') p--;
    cmdline.text = t.slice(0, p) + t.slice(cmdline.pos);
    cmdline.pos = p;
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdKillLine() {
    if (!cmdline) return;
    // Vim: CTRL-U kills to beginning of line in cmdline
    cmdline.text = cmdline.text.slice(cmdline.pos);
    cmdline.pos = 0;
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdMoveLeft() {
    if (!cmdline || cmdline.pos === 0) return;
    cmdline.pos--;
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdMoveRight() {
    if (!cmdline || cmdline.pos >= cmdline.text.length) return;
    cmdline.pos++;
    try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
  }
  function cmdMoveHome() { if (!cmdline) return; cmdline.pos = 0; try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {} }
  function cmdMoveEnd() { if (!cmdline) return; cmdline.pos = cmdline.text.length; try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {} }
  function cmdHist(dir) {
    if (!cmdline) return;
    const list = cmdline.type === ':' ? exHist : searchHist;
    if (!list.length) return;
    if (dir === 'up') {
      if (cmdline.histIndex == null) {
        cmdline.savedText = cmdline.text;
        cmdline.histIndex = 0;
      } else if (cmdline.histIndex < list.length - 1) {
        cmdline.histIndex++;
      } else return;
      cmdline.text = list[cmdline.histIndex];
      cmdline.pos = cmdline.text.length;
      try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
    } else if (dir === 'down') {
      if (cmdline.histIndex == null) return;
      if (cmdline.histIndex > 0) {
        cmdline.histIndex--;
        cmdline.text = list[cmdline.histIndex];
        cmdline.pos = cmdline.text.length;
      } else {
        cmdline.histIndex = null;
        cmdline.text = cmdline.savedText || '';
        cmdline.pos = cmdline.text.length;
      }
      try { if (ui) ui.updateCmdline(cmdline.text, cmdline.pos); } catch (_) {}
    }
  }

  // Vim magic → JS RegExp. In Vim default 'magic' mode, . *anchors [ ] ^ $ are
  // magic, while + ? | ( ) { } are literal unless escaped. We map that to
  // JS where . * + ? | ( ) [ ] { } ^ $ are magic.
  function vimPatternToJS(pat) {
    let out = '';
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === '\\' && i + 1 < pat.length) {
        const nxt = pat[i + 1];
        // Escaped magic in Vim means "make it magic"; translate to JS magic.
        // Vim \< \> (word boundaries), \c \C (ignorecase), \v \V \m \M (magic modes)
        if (nxt === 'c' || nxt === 'C' || nxt === 'v' || nxt === 'V' || nxt === 'm' || nxt === 'M') { i++; continue; } // flags handled separately
        if (nxt === '<') { out += '\\b(?=\\w)'; i++; continue; }
        if (nxt === '>') { out += '\\b'; i++; continue; }
        if (nxt === 'b') { // Vim \b not standard; treat literal
          out += nxt; i++; continue;
        }
        // Vim escaped magic chars become JS magic
        if ('+?|(){}'.indexOf(nxt) !== -1) { out += nxt; i++; continue; }
        // Escaped literal in Vim stays escaped in JS where needed
        if ('.*[]^$\\'.indexOf(nxt) !== -1) { out += '\\' + nxt; i++; continue; }
        // Other \x -> literal x
        out += nxt; i++; continue;
      }
      if ('+?|(){}'.indexOf(ch) !== -1) {
        // In Vim default magic these are literal; escape for JS
        out += '\\' + ch;
        continue;
      }
      // . * [ ] ^ $ pass through; JS handles them as magic already
      if (ch === '*') { out += ch; continue; }
      // Need to escape JS regex special chars that are not escaped in Vim magic
      out += ch;
    }
    return out;
  }

  function execCmdline() {
    if (!cmdline) return;
    const type = cmdline.type;
    const raw = cmdline.text;
    const searchPattern = raw; // for / and ?
    closeCmdline();

    if (type === '/' || type === '?') {
      const pat = String(searchPattern || '').trim();
      if (!pat) {
        const last = executor && executor._lastSearch && executor._lastSearch.pattern;
        if (last) {
          const dir = (type === '/' ? 'forward' : 'backward');
          try { executor._searchFindAndMove(last, dir, 1, false); } catch (_) {}
        } else {
          try { if (ui) ui.setMessage('E35: No previous regular expression', true); } catch (_) {}
        }
        return;
      }
      let patForSearch = pat;
      let forceIgnore = null;
      if (pat.indexOf('\\c') !== -1) { forceIgnore = true; patForSearch = patForSearch.replace(/\\c/g, ''); }
      if (pat.indexOf('\\C') !== -1) { forceIgnore = false; patForSearch = patForSearch.replace(/\\C/g, ''); }
      pushHist(searchHist, pat);
      const dir = (type === '/' ? 'forward' : 'backward');
      try {
        if (executor && typeof executor.searchOperatorPending === 'function' && pendingOperatorCmdline && pendingOperatorCmdline.operator) {
          const saved = pendingOperatorCmdline;
          pendingOperatorCmdline = null;
          executor.searchOperatorPending(saved.operator, patForSearch, dir, saved.count, saved.register, forceIgnore);
        } else {
          pendingOperatorCmdline = null;
          if (executor && executor._searchFindAndMove) {
            if (forceIgnore != null) {
              try { executor._searchIgnoreCaseOverride = forceIgnore; } catch (_) {}
            }
            executor._searchFindAndMove(patForSearch, dir, 1, false);
            try { executor._searchIgnoreCaseOverride = null; } catch (_) {}
          }
        }
      } catch (_) {}
      return;
    }

    if (type === ':') {
      const line = String(raw || '').trim();
      if (!line) return;
      pushHist(exHist, line);
      execExLine(line);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Ex command dispatcher — authentic Vim :commands
  // ---------------------------------------------------------------------------
  // Supports:
  //  :w[rite]            (no-op, shows written msg)
  //  :q[uit] / :q!        (no-op)
  //  :wq / :x / :exit     (no-op)
  //  :e[dit]
  //  :noh[lsearch]
  //  :set {opt} [!|&]     (hlsearch, number, relativenumber, ignorecase, wrap)
  //  :<number>            goto line
  //  :s/pat/rep/[g][i][c] and :%s/...
  //  :g/pat/d[lete]       (subset)
  //  :reg[isters]         (show registers)
  //  :marks               (show marks)
  //  :ju[mps]             (show jumps)
  //  :h[elp]
  function execExLine(line) {
    const t = String(line || '').trim();
    if (!t) return;

    // Line number: ":42"
    if (/^[0-9]+$/.test(t)) {
      const n = parseInt(t, 10);
      try { if (executor && executor.exGotoLine) executor.exGotoLine(n); else if (executor) executor._searchFindAndMove && ui && ui.setMessage(String(n), false); } catch (_) {}
      return;
    }

    // Range + substitute: ":%s/pat/rep/g" , ":10,20s/pat/rep/g"
    const subRangeRe = /^([%0-9,.$'<>*+\-;\\/?]+)?\s*s([^\w\s])(.*)$/;
    // More precise substitute parsing: [range]s<delim>pat<delim>rep<delim>[flags]
    const parseSub = (s) => {
      const delim = s[0];
      if (!delim) return null;
      let i = 1, esc = false, parts = ['', '']; let idx = 0;
      for (; i < s.length; i++) {
        const ch = s[i];
        if (esc) { parts[idx] += ch; esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === delim) {
          if (idx === 0) { idx = 1; continue; }
          const flags = s.slice(i + 1).trim();
          return { pat: parts[0], rep: parts[1], flags: flags, delim: delim };
        }
        parts[idx] += ch;
      }
      if (idx === 1) return { pat: parts[0], rep: parts[1], flags: '', delim: delim };
      if (idx === 0 && parts[0] !== '') return { pat: parts[0], rep: '', flags: '', delim: delim };
      return null;
    };

    // Handle ":[range]s..." with optional "%"
    let rangePart = '';
    let restAfterRange = t;
    const pr = /^(%|[0-9]+(?:,[0-9]+)?)\s*(.*)$/.exec(t);
    // Try to separate range prefix if present
    if (pr && /^(%|[0-9])/.test(pr[1]) && /^s[^a-zA-Z0-9]/.test(pr[2])) {
      rangePart = pr[1];
      restAfterRange = pr[2];
    }
    if (/^s[^a-zA-Z0-9]/.test(restAfterRange)) {
      const body = restAfterRange.slice(1); // after 's'
      const parsed = parseSub(restAfterRange.slice(1 - 1 < 0 ? 0 : 0) ? restAfterRange.slice(1) : restAfterRange); // Keep delim
      // Simpler: pass the tail including delim
      const tail = restAfterRange.slice(1);
      const p2 = parseSub(tail);
      // Actually tail is like "/pat/rep/g"; parseSub expects delim at 0, so pass tail
      const p3 = p2 || parseSub(tail);
      if (p3 || tail[0]) {
        // Re-parse correctly
        const real = parseSub(tail);
        if (real) {
          const pat = real.pat;
          const rep = real.rep;
          const flags = (real.flags || '').toLowerCase();
          const doGlobal = flags.indexOf('g') !== -1;
          const doIgnore = flags.indexOf('i') !== -1;
          const doConfirm = flags.indexOf('c') !== -1;
          try {
            if (executor && executor.exSubstitute) {
              executor.exSubstitute({
                pat: pat,
                rep: rep,
                range: rangePart || '',
                global: doGlobal,
                ignorecase: doIgnore,
                confirm: doConfirm,
                flags: flags
              });
            } else {
              // Fallback message when executor not ready
              try { if (ui) ui.setMessage('E492: Not an editor command: ' + line, true); } catch (_) {}
            }
          } catch (_) {}
          return;
        }
      }
    }

    // :g/pat/d
    const gRe = /^\s*g([^\w\s])(.+)\1\s*(d(?:elete)?)?\s*$/;
    const gm = gRe.exec(t);
    if (gm) {
      const pat = gm[2];
      try {
        if (executor && executor.exGlobalDelete) executor.exGlobalDelete(pat);
      } catch (_) {}
      return;
    }

    // Split first word (command)
    const first = t.split(/\s+/)[0] || '';
    const args = t.slice(first.length).trim();
    const cmd = first.replace(/^:/, '');

    const is = (abbr, full) => cmd === abbr || cmd === full || (full.indexOf(cmd) === 0 && cmd.length >= abbr.length);

    // Strip trailing ! like Vim (:q! vs :q)
    const bang = first.endsWith('!');
    const baseFirst = bang ? first.slice(0, -1) : first;
    const baseCmd = baseFirst.replace(/^:/, '');
    const isBase = (abbr, full) => baseCmd === abbr || baseCmd === full || (full.indexOf(baseCmd) === 0 && baseCmd.length >= abbr.length);
    if (isBase('w', 'write') || isBase('wq', 'wq') || baseCmd === 'x' || isBase('exi', 'exit') || isBase('wa', 'wall')) {
      try { if (ui) ui.setMessage('"' + (document.title || 'document') + '" written', false); } catch (_) {}
      return;
    }
    if (isBase('q', 'quit') || baseCmd === 'qa' || baseCmd === 'wqa' || baseCmd === 'xa') {
      // :q! or :qa! etc — bang means force; Docs never blocks
      try { if (ui) ui.setMessage('', false); } catch (_) {}
      return;
    }
    if (isBase('e', 'edit') || isBase('enew', 'enew')) {
      try { if (ui) ui.setMessage('', false); } catch (_) {}
      return;
    }
    if (isBase('noh', 'nohlsearch') || isBase('nohl', 'nohlsearch')) {
      try { if (executor) executor.clearSearchHighlight && executor.clearSearchHighlight(); if (ui) ui.setMessage('', false); } catch (_) {}
      return;
    }
    if (isBase('h', 'help') || baseCmd === 'help!' || baseCmd === 'helpgrep') {
      try {
        const url = 'https://vimhelp.org/';
        if (args) window.open(url + encodeURIComponent(args) + '.txt.html', '_blank');
        else window.open('https://vim.rtorr.com/', '_blank');
      } catch (_) {}
      return;
    }
    if (isBase('reg', 'registers') || baseCmd === 'reg' || baseCmd === 'di' || isBase('dis', 'display')) {
      try { if (executor && executor.exShowRegisters) executor.exShowRegisters(); } catch (_) {}
      return;
    }
    if (isBase('marks', 'marks')) {
      try { if (executor && executor.exShowMarks) executor.exShowMarks(); } catch (_) {}
      return;
    }
    if (isBase('ju', 'jumps') || baseCmd === 'jumps') {
      try { if (executor && executor.exShowJumps) executor.exShowJumps(); } catch (_) {}
      return;
    }
    if (isBase('se', 'set')) {
      const a = String(args || '').trim();
      if (!a) {
        try { if (ui) ui.setMessage('Options: hlsearch number relativenumber ignorecase wrap', false); } catch (_) {}
        return;
      }
      // Support "set hlsearch", "set nohlsearch", "set nu!", "set rnu&", etc.
      const norm = a.replace(/\s+/g, ' ').trim();
      const tokens = norm.split(' ');
      for (let i = 0; i < tokens.length; i++) {
        let tok = tokens[i].trim();
        if (!tok) continue;
        const bang = tok.endsWith('!');
        const amp = tok.endsWith('&');
        if (bang || amp) tok = tok.slice(0, -1);
        let neg = false;
        if (tok.startsWith('no')) { neg = true; tok = tok.slice(2); }
        // Canonical option names
        const canon = { 'nu': 'number', 'rnu': 'relativenumber', 'hls': 'hlsearch', 'ic': 'ignorecase', 'wrap': 'wrap', 'et': 'expandtab', 'number': 'number', 'relativenumber': 'relativenumber', 'hlsearch': 'hlsearch', 'ignorecase': 'ignorecase', 'expandtab': 'expandtab' };
        const key = canon[tok] || tok;
        try {
          if (executor && executor.exSetOption) executor.exSetOption(key, neg ? false : true, bang, amp);
        } catch (_) {}
      }
      return;
    }
    if (isBase('sort', 'sort')) {
      try { if (executor && executor.exSort) executor.exSort(args); } catch (_) {}
      return;
    }
    if (/^[0-9]+,[0-9]+/.test(t) || /^%/.test(t) || /^\$/.test(t) || /^\.s/.test(t)) {
      try { if (ui) ui.setMessage('E492: Not an editor command: ' + line, true); } catch (_) {}
      return;
    }

    try { if (ui) ui.setMessage('E492: Not an editor command: ' + line, true); } catch (_) {}
  }

  let boundCtrlTokens = new Set([
    '<C-E>', '<C-Y>', '<C-B>', '<C-F>', '<C-D>', '<C-U>',
    '<C-R>', '<C-I>', '<C-O>', '<C-A>', '<C-X>', '<C-C>',
    '<C-H>', '<C-W>', '<C-J>', '<C-T>', '<C-N>', '<C-P>',
    '<C-[>'
  ]);
  function rebuildBoundCtrlTokens(cfg) {
    if (!cfg) return;
    const next = new Set(boundCtrlTokens);
    next.add('<C-[>');
    try {
      for (const section of ['motions', 'commands']) {
        for (const entry of (cfg[section] || [])) {
          for (const k of (entry.keys || [])) {
            if (typeof k === 'string' && k.startsWith('<C-')) next.add(k);
          }
        }
      }
    } catch (_) {}
    boundCtrlTokens = next;
  }

  function passthrough() {
    try { if (parser) parser.reset(); } catch (_) {}
    try { if (ui) ui.setShowCmd(''); } catch (_) {}
  }

  function runExec(result) {
    let p;
    try { p = executor.exec(result); } catch (_) { return; }
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  // Showcmd helper: reflect parser buffer + pending register/count
  function refreshShowCmd() {
    try {
      if (cmdline) { if (ui) ui.setShowCmd(''); return; }
      if (!parser || !ui) return;
      const buf = parser.buffer || [];
      if (!buf.length) { ui.setShowCmd(''); return; }
      // Render as typed: join tokens, but expand <C-X> etc. For showcmd Vim shows
      // up to ~10 chars right-aligned. We show the raw sequence.
      let s = buf.join('');
      // Truncate Vim-like: keep last 10
      if (s.length > 10) s = s.slice(-10);
      ui.setShowCmd(s);
    } catch (_) {}
  }

  function mapCtrlKeyName(key) {
    const specials = {
      ' ': 'SPACE',
      'ArrowUp': 'Up',
      'ArrowDown': 'Down',
      'ArrowLeft': 'Left',
      'ArrowRight': 'Right',
      'Escape': 'ESC',
      'Enter': 'CR',
      'Backspace': 'BS',
      'Tab': 'TAB'
    };
    if (specials[key]) return specials[key];
    if (key.length === 1) return key.toUpperCase();
    return key;
  }

  function eventToToken(e) {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return '<C-' + mapCtrlKeyName(e.key) + '>';
    }
    if (e.key.length === 1) return e.key;
    const named = {
      'Escape': '<ESC>',
      'Enter': '<CR>',
      'Backspace': '<BS>',
      'Tab': '<TAB>',
      'ArrowLeft': '<Left>',
      'ArrowRight': '<Right>',
      'ArrowUp': '<Up>',
      'ArrowDown': '<Down>',
      'Home': '<Home>',
      'End': '<End>',
      'Delete': '<Del>'
    };
    return named[e.key] || null;
  }

  function findEditorDoc() {
    const editorIframe = document.querySelector('.docs-texteventtarget-iframe');
    if (editorIframe && editorIframe.contentDocument) return editorIframe.contentDocument;
    const anyIframe = document.getElementsByTagName('iframe')[0];
    if (anyIframe && anyIframe.contentDocument) return anyIframe.contentDocument;
    return document;
  }

  function focusEditorQuick() {
    try {
      const iframe = document.querySelector('.docs-texteventtarget-iframe');
      const win = iframe && iframe.contentWindow;
      const doc = win && win.document;
      if (win && typeof win.focus === 'function') try { win.focus(); } catch (_) {}
      if (doc) {
        const root = doc.querySelector('[contenteditable="true"]') || doc.body || doc.documentElement;
        try { root && root.focus && root.focus(); } catch (_) {}
      }
      try { window.focus(); } catch (_) {}
    } catch (_) {}
  }

  function handleCmdlineKeydown(e, token) {
    // In command-line mode, most keys edit the line. Special keys:
    //  Enter/CR  -> execute
    //  Esc/C-C/C-[ -> cancel (Vim: : + Esc aborts)
    //  BS / C-H -> backspace (if at column 0 and line empty, cancel like Vim)
    //  C-W      -> delete word
    //  C-U      -> delete to start
    //  C-H is BS alias
    //  Left/Right/Home/End, C-B/C-E, Up/Down for history
    // Anything else printable inserts.
    if (token === '<ESC>' || token === '<C-C>' || token === '<C-[>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      pendingOperatorCmdline = null;
      closeCmdline();
      try { if (parser) parser.reset(); } catch (_) {}
      try { if (ui) ui.setShowCmd(''); } catch (_) {}
      return;
    }
    if (token === '<CR>' || e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      execCmdline();
      return;
    }
    if (token === '<BS>' || token === '<C-H>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      // Vim: backspacing past the prompt char aborts
      if (cmdline && cmdline.pos === 0 && cmdline.text.length === 0) {
        pendingOperatorCmdline = null;
        closeCmdline();
        try { if (parser) parser.reset(); } catch (_) {}
      } else {
        cmdBackspace();
      }
      return;
    }
    if (token === '<Del>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdDel();
      return;
    }
    if (token === '<C-W>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdKillWord();
      return;
    }
    if (token === '<C-U>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdKillLine();
      return;
    }
    // Cursor movement in cmdline
    if (token === '<Left>' || (token === '<C-B>')) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdMoveLeft(); return;
    }
    if (token === '<Right>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdMoveRight(); return;
    }
    if (token === '<Home>' || token === '<C-A>') { // C-A in cmdline not Vim but allow
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdMoveHome(); return;
    }
    if (token === '<End>' || token === '<C-E>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      // C-E conflicts with bound token scroll_down; but inside cmdline C-E = end-of-line (like Vim c_CTRL-E)
      cmdMoveEnd(); return;
    }
    if (token === '<Up>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdHist('up'); return;
    }
    if (token === '<Down>') {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdHist('down'); return;
    }
    // C-P / C-N also history in Vim cmdline
    if (token === '<C-P>') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); cmdHist('up'); return; }
    if (token === '<C-N>') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); cmdHist('down'); return; }

    // Insert printable (including '/' '?' ':' inside the line)
    // Vim inserts the typed character literally; also supports C-V quoted insert.
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      cmdIns(e.key);
      return;
    }
    // Allow typing Shift+: etc. even though token is ":" (length 1) already handled,
    // but other punctuation also token length 1.
    // For any other key (Tab etc.), swallow silently like Vim does in cmdline.
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }

  function attachKeyListener() {
    const handleKeydown = (e) => {
      if (!vimEnabled) return;
      if (!e.isTrusted) return;
      if (e.metaKey) { passthrough(); return; }

      // Command-line mode owns every keystroke (except Cmd passthrough above)
      if (cmdline) {
        // But still allow Cmd combos to passthrough? No — like Vim, Cmd doesn't exist.
        // Block everything and handle as cmdline editing.
        const tok2 = eventToToken(e);
        handleCmdlineKeydown(e, tok2);
        return;
      }

      if (e.ctrlKey && !e.altKey) {
        const ctrlToken = eventToToken(e);
        if (!ctrlToken || !boundCtrlTokens.has(ctrlToken)) { passthrough(); return; }
      }
      const token = eventToToken(e);
      // ":" is printable ':' but only one char; it becomes token ":". Handle
      // it as command-line open before we suppress tokens.
      if (token === ':' && (mode === 'normal' || mode === 'visual' || mode === 'visualLine')) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        openCmdline(':');
        return;
      }
      // "/" and "?" in normal/visual open the search cmdline. In insert mode
      // they are just typed characters, so only intercept outside insert.
      if ((token === '/' || token === '?') && mode !== 'insert') {
        // If there's a pending operator, remember it for operator-pending search
        try {
          if (parser && parser.buffer && parser.buffer.length) {
            const buf = parser.buffer.slice();
            const hasOp = !!(parser.haveOperator);
            if (hasOp) {
              // Snapshot count/register
              let cnt = 1;
              try { cnt = parser._countVal ? parser._countVal() : 1; } catch (_) {}
              pendingOperatorCmdline = {
                operator: parser.operatorMeta ? parser.operatorMeta.id : null,
                count: cnt,
                register: parser.register || null
              };
            } else {
              pendingOperatorCmdline = null;
            }
            // Keep the buffer text for showcmd before we open
            void buf;
          } else {
            pendingOperatorCmdline = null;
          }
        } catch (_) { pendingOperatorCmdline = null; }
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        openCmdline(token);
        return;
      }
      if (!token) return;

      try {
        // Insert mode
        if (mode === 'insert') {
          if (token === '<ESC>' || token === '<C-C>' || token === '<C-[>') {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            try { executor.finishInsert(insertOps); } catch (_) {}
            resetInsertOps();
            try { if (parser) parser.reset(); } catch (_) {}
            try { if (ui) ui.setShowCmd(''); } catch (_) {}
            tempNormal = false;
            setMode('normal'); replaceMode = false;
            try { if (ui && ui.setReplaceMode) ui.setReplaceMode(false); } catch (_) {}
            try { focusEditorQuick(); } catch (_) {}
            try { if (ui) { setTimeout(function () { ui.updateCursorStyle(); }, 0); setTimeout(function () { ui.updateCursorStyle(); }, 60); setTimeout(function () { ui.updateCursorStyle(); }, 250); } } catch (_) {}
            return;
          }
          if (token === '<C-O>') {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            tempNormal = true; setMode('normal');
            return;
          }
          const INSERT_CTRL_TOKENS = ['<C-H>','<C-W>','<C-J>','<C-T>','<C-D>','<C-N>','<C-P>','<C-R>'];
          if ((parser && parser.awaitingCharFor) || INSERT_CTRL_TOKENS.indexOf(token) !== -1) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            const res = parser.feed(token);
            if (!res) return;
            if (res.kind === 'invalid') { try { if (ui) ui.setShowCmd(''); } catch (_) {} return; }
            if (res.kind === 'prefix' || res.kind === 'await_char') {
              try { if (ui) ui.setShowCmd((res.keys || []).join('')); } catch (_) {}
              return;
            }
            try { if (ui) ui.setShowCmd(''); } catch (_) {}
            if (res.kind === 'command' && res.command) {
              const cid = res.command.id;
              if (cid === 'insert_delete_char_back') appendOpBs();
              else if (cid === 'insert_line_break') appendOpText('\n');
              else if (cid === 'insert_indent') appendOpText('\t');
              else if (cid === 'insert_delete_word') insertOps.push({ type: 'delete_word' });
              else if (cid === 'insert_dedent') insertOps.push({ type: 'dedent' });
              else if (cid === 'insert_register') {
                try {
                  const nm = (res.command.args && res.command.args.char) || '"';
                  const tv = executor.getRegisterText ? executor.getRegisterText(nm) : '';
                  if (tv) appendOpText(tv);
                } catch (_) {}
              }
            }
            runExec(res);
            return;
          }
          if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            appendOpText(e.key);
          } else if (token === '<CR>' && !replaceMode) {
            appendOpText('\n');
          } else if (token === '<BS>') {
            appendOpBs();
          }
          if (replaceMode && e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            runExec({ kind: 'command', command: { id: 'insert_replace_char', args: { char: e.key }, modes: ['insert'] }, count: 1 });
            return;
          }
          return;
        }

        // Normal / Visual: suppress all tokenized keys
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

        if (token === '<ESC>' || token === '<C-[>') {
          try { if (parser) parser.reset(); } catch (_) {}
          try { if (ui) ui.setShowCmd(''); } catch (_) {}
          if (tempNormal) {
            tempNormal = false;
            try { executor.finishInsert(insertOps); } catch (_) {}
            resetInsertOps();
            setMode('normal'); replaceMode = false;
            try { if (ui && ui.setReplaceMode) ui.setReplaceMode(false); } catch (_) {}
            try { focusEditorQuick(); } catch (_) {}
            try { if (ui) { setTimeout(function () { ui.updateCursorStyle(); }, 0); setTimeout(function () { ui.updateCursorStyle(); }, 60); } } catch (_) {}
            return;
          }
          tempNormal = false;
          try { if (ui && ui.setReplaceMode) ui.setReplaceMode(false); } catch (_) {}
          runExec({ kind: 'command', command: { id: 'exit_mode' }, count: 1 });
          try { focusEditorQuick(); } catch (_) {}
          try { if (ui) { setTimeout(function () { ui.updateCursorStyle(); }, 0); setTimeout(function () { ui.updateCursorStyle(); }, 60); } } catch (_) {}
          return;
        }

        const res = parser.feed(token);
        if (!res) return;

        if (res.kind === 'invalid') {
          // Vim beeps and clears showcmd on invalid sequence
          try { if (ui) { ui.setShowCmd(''); ui.setMessage('E492: Not an editor command: ' + (res.keys || []).join(''), true); } } catch (_) {}
          try { if (parser) parser.reset(); } catch (_) {}
          refreshShowCmd();
          return;
        }

        if (res.kind === 'prefix' || res.kind === 'await_char') {
          try { if (ui) ui.setShowCmd((res.keys || []).join('')); } catch (_) {}
          refreshShowCmd();
          return;
        }

        runExec(res);
        try { if (ui) ui.setShowCmd(''); } catch (_) {}

        if (tempNormal) {
          tempNormal = false;
          const savedOps = insertOps;
          setMode('insert');
          insertOps = savedOps;
        }
      } catch (_) {}
    };

    const attachToDoc = (doc) => {
      if (!doc || doc.__vimKeyAttached) return;
      doc.__vimKeyAttached = true;
      doc.addEventListener('keydown', handleKeydown, true);
    };
    try { attachToDoc(document); } catch (_) {}
    try { attachToDoc(findEditorDoc()); } catch (_) {}
    try { window.addEventListener('keydown', handleKeydown, true); } catch (_) {}
    try {
      const iframe = document.querySelector('.docs-texteventtarget-iframe');
      if (iframe && iframe.contentDocument) attachToDoc(iframe.contentDocument);
      if (iframe && iframe.contentWindow) try { iframe.contentWindow.addEventListener('keydown', handleKeydown, true); } catch (_) {}
    } catch (_) {}
    try {
      const obs = new MutationObserver(() => {
        try { attachToDoc(findEditorDoc()); } catch (_) {}
        try {
          const ifr = document.querySelector('.docs-texteventtarget-iframe');
          if (ifr && ifr.contentDocument) attachToDoc(ifr.contentDocument);
          if (ifr && ifr.contentWindow && !ifr.contentWindow.__vimKeyAttachedWin) {
            ifr.contentWindow.__vimKeyAttachedWin = true;
            ifr.contentWindow.addEventListener('keydown', handleKeydown, true);
          }
        } catch (_) {}
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  function injectPageScript() {
    const script = document.createElement('script');
    script.src = API.runtime.getURL('page_script.js');
    document.documentElement.appendChild(script);
  }

  function migrateConfig(stored, base) {
    const storedVersion = stored.schemaVersion || 1;
    const baseVersion = base.schemaVersion || 1;
    if (storedVersion >= baseVersion) return stored;
    const migrated = JSON.parse(JSON.stringify(stored));
    migrated.schemaVersion = baseVersion;
    if (storedVersion < 2) {
      const hasMotion = (migrated.motions || []).some(m => m.id === 'first_non_blank_down');
      if (!hasMotion) {
        const baseMotion = (base.motions || []).find(m => m.id === 'first_non_blank_down');
        if (baseMotion) {
          migrated.motions = migrated.motions || [];
          const insertIdx = migrated.motions.findIndex(m => m.id === 'line_end');
          if (insertIdx >= 0) migrated.motions.splice(insertIdx, 0, baseMotion);
          else migrated.motions.push(baseMotion);
        }
      }
    }
    if (storedVersion < 3) {
      const hasCommand = (migrated.commands || []).some(c => c.id === 'toggle_case_char');
      if (!hasCommand) {
        const baseCommand = (base.commands || []).find(c => c.id === 'toggle_case_char');
        if (baseCommand) {
          migrated.commands = migrated.commands || [];
          const insertIdx = migrated.commands.findIndex(c => c.id === 'delete_char_back');
          if (insertIdx >= 0) migrated.commands.splice(insertIdx + 1, 0, baseCommand);
          else migrated.commands.push(baseCommand);
        }
      }
    }
    if (storedVersion < 4) {
      const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) &&
        a.length === b.length && a.every((k, i) => String(k) === String(b[i]));
      if (Array.isArray(migrated.commands)) {
        migrated.commands = migrated.commands.filter(c => c.id !== 'append_end_word');
      }
      migrated.operatorSelf = migrated.operatorSelf || [];
      for (const entry of (base.operatorSelf || [])) {
        const exists = migrated.operatorSelf.some(o =>
          o.operator === entry.operator && sameKeys(o.keys, entry.keys));
        if (!exists) migrated.operatorSelf.push(JSON.parse(JSON.stringify(entry)));
      }
      migrated.commands = migrated.commands || [];
      for (const id of ['visual_paste', 'visual_paste_before', 'visual_delete_char', 'visual_substitute']) {
        if (!migrated.commands.some(c => c.id === id)) {
          const src = (base.commands || []).find(c => c.id === id);
          if (src) migrated.commands.push(JSON.parse(JSON.stringify(src)));
        }
      }
    }
    try { API.storage.local.set({ motionsConfig: migrated }); } catch (_) {}
    return migrated;
  }

  async function loadConfig() {
    try {
      const base = await window.loadVimMotionsConfig();
      try {
        API.storage.sync.get(['useDisplayLines'], (data) => {
          try { useDisplayLines = !!(data && data.useDisplayLines); } catch (_) {}
        });
      } catch (_) {}
      return new Promise((resolve) => {
        try {
          API.storage.local.get(['motionsConfig'], (localData) => {
            const finishWith = (src) => {
              if (!src) { resolve(base); return; }
              try {
                const parsed = (typeof src === 'string') ? JSON.parse(src) : src;
                const migrated = migrateConfig(parsed, base);
                resolve(migrated);
              } catch (_) { resolve(base); }
            };
            if (localData && typeof localData.motionsConfig !== 'undefined') {
              finishWith(localData.motionsConfig);
            } else {
              try {
                API.storage.sync.get(['motionsConfig'], (syncData) => {
                  if (syncData && typeof syncData.motionsConfig !== 'undefined') finishWith(syncData.motionsConfig);
                  else resolve(base);
                });
              } catch (_) { resolve(base); }
            }
          });
        } catch (_) { resolve(base); }
      });
    } catch (_) {
      return { motions: [], operators: [], textObjects: [], operatorSelf: [], settings: {} };
    }
  }

  const REQUIRED_PERMISSIONS = ['storage'];

  function checkDocsBrailleSupport() {
    try {
      if (window.browserAPI && typeof window.browserAPI.checkDocsBrailleSupport === 'function') {
        return window.browserAPI.checkDocsBrailleSupport(document);
      }
    } catch (_) {}
    const details = {
      hasTextEventIframe: false, iframeAccessible: false, hasIframeTextbox: false,
      hasIframePages: false, iframeTextLength: 0, selectionProbeOk: false,
      hasMainEditor: false, hasAnnotatedCanvas: false, hasAriaLabelRects: false,
      hasParagraphRenderer: false
    };
    try {
      try { details.hasMainEditor = !!document.querySelector('.kix-appview-editor, .kix-appview'); } catch (_) {}
      const iframe = document.querySelector('.docs-texteventtarget-iframe');
      details.hasTextEventIframe = !!iframe;
      try {
        details.hasAnnotatedCanvas = !!document.querySelector('.kix-canvas-tile-content svg g, .kix-canvas-tile-selection svg');
        details.hasAriaLabelRects = !!document.querySelector('.kix-canvas-tile-content svg rect[aria-label], .kix-canvas-tile-content svg g[aria-label], svg g[role=\"paragraph\"]');
        details.hasParagraphRenderer = !!document.querySelector('.kix-paragraphrenderer');
      } catch (_) {}
      try {
        const idoc = iframe && iframe.contentDocument;
        const win = iframe && iframe.contentWindow;
        if (idoc) {
          details.iframeAccessible = true;
          let root = null;
          try { root = idoc.querySelector('.kix-page-paginated, .kix-paginateddocumentplugin, .kix-page') || idoc.querySelector('[role=\"textbox\"]') || idoc.querySelector('[contenteditable=\"true\"]'); } catch (_) { root = null; }
          details.hasIframeTextbox = !!root;
          try { details.hasIframePages = !!idoc.querySelector('.kix-page-paginated, .kix-paginateddocumentplugin, .kix-page'); } catch (_) {}
          try { const t = (root && root.textContent && root.textContent.length) || (idoc.body && idoc.body.textContent && idoc.body.textContent.length) || 0; details.iframeTextLength = t; } catch (_) {}
          try {
            const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
            if (sel && sel.rangeCount > 0 && typeof sel.modify === 'function') {
              const range = sel.getRangeAt(0).cloneRange();
              const before = sel.toString();
              try { sel.modify('extend', 'forward', 'character'); } catch (_) {}
              const afterF = sel.toString();
              try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
              try { sel.modify('extend', 'backward', 'character'); } catch (_) {}
              const afterB = sel.toString();
              try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
              details.selectionProbeOk = (afterF !== before) || (afterB !== before);
            }
          } catch (_) {}
        }
      } catch (_) {}
      if (details.selectionProbeOk) return { supported: true, reason: 'selection-probe-ok', details: details };
      if (details.hasIframePages) return { supported: true, reason: 'mirror-pages-found', details: details };
      if (details.hasAnnotatedCanvas || details.hasAriaLabelRects || details.hasParagraphRenderer) return { supported: true, reason: 'annotated-dom-found', details: details };
      if (details.hasIframeTextbox && details.iframeTextLength >= 20) return { supported: true, reason: 'mirror-text-found', details: details };
      if (details.hasTextEventIframe && details.iframeAccessible && !details.hasIframeTextbox) return { supported: false, reason: 'mirror-not-ready', details: details };
      return { supported: false, reason: 'no-mirror-content', details: details };
    } catch (_) { return { supported: false, reason: 'check-failed', details: details }; }
  }

  async function checkExtensionPermissions() {
    try {
      if (window.browserAPI && typeof window.browserAPI.hasAllRequiredPermissions === 'function') {
        return await window.browserAPI.hasAllRequiredPermissions();
      }
    } catch (_) {}
    if (API.permissions && typeof API.permissions.getAll === 'function') {
      let all;
      if (IS_BROWSER) all = await API.permissions.getAll();
      else {
        all = await new Promise((resolve, reject) => {
          API.permissions.getAll((result) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(result);
          });
        });
      }
      const granted = (all && all.permissions) || [];
      return REQUIRED_PERMISSIONS.every((p) => granted.indexOf(p) !== -1);
    }
    return !!(API.storage && (API.storage.sync || API.storage.local));
  }

  async function init() {
    // Keep extension quiet — no console spam (Vim never logs to console).
    // Keep braille check running silently for the popup badge only.
    try { await checkExtensionPermissions(); } catch (_) {}
    // Lazy mirror re-check (silent)
    try {
      [3000, 10000].forEach(function (delay) {
        setTimeout(function () { try { checkDocsBrailleSupport(); } catch (_) {} }, delay);
      });
    } catch (_) {}

    const cfg = await loadConfig();
    parser = new window.VimMotionParser(cfg);
    rebuildBoundCtrlTokens(cfg);
    try { parser.setMode(mode); } catch (_) {}
    injectPageScript();
    attachKeyListener();
    try {
      API.storage.sync.get(['theme', 'enabled'], (data) => {
        try { uiTheme = (data && data.theme) ? data.theme : 'vim'; } catch (_) { uiTheme = 'vim'; }
        try { vimEnabled = (data && typeof data.enabled !== 'undefined') ? !!data.enabled : true; } catch (_) { vimEnabled = true; }
        if (ui) try { ui.setTheme(uiTheme); } catch (_) {}
        try { if (ui && ui.ind) ui.ind.style.display = vimEnabled ? '' : 'none'; } catch (_) {}
      });
    } catch (_) {}
    try {
      ui = new VimUIV2();
      ui.setTheme(uiTheme);
      ui.setMode(mode);
      ui.setShowCmd('');
      try { if (ui && ui.ind) ui.ind.style.display = vimEnabled ? '' : 'none'; } catch (_) {}
      // Expose helpers for executor (messages/search)
      try { window.__VIM_UI__ = ui; } catch (_) {}
    } catch (_) {}
    try { window.__VIM_OPEN_CMDLINE__ = openCmdline; } catch (_) {}
    try { window.__VIM_EX_LINE__ = execExLine; } catch (_) {}
    try {
      window.__VIM_SHOWMSG__ = function (t, isErr) { try { if (ui) ui.setMessage(t, !!isErr); } catch (_) {} };
    } catch (_) {}

    try {
      API.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') {
          if (changes && changes.useDisplayLines) {
            try { useDisplayLines = !!changes.useDisplayLines.newValue; } catch (_) {}
          }
          if (changes && changes.theme) { try { uiTheme = changes.theme.newValue || 'vim'; if (ui) ui.setTheme(uiTheme); } catch (_) {} }
          if (changes && changes.enabled) {
            try {
              vimEnabled = !!changes.enabled.newValue;
              if (ui && ui.ind) ui.ind.style.display = vimEnabled ? '' : 'none';
              // Abort cmdline if disabling
              if (!vimEnabled && cmdline) closeCmdline();
            } catch (_) {}
          }
        }
        if (changes && changes.motionsConfig) {
          try {
            const nv = changes.motionsConfig.newValue;
            if (typeof nv !== 'undefined') {
              const newCfg = (typeof nv === 'string') ? JSON.parse(nv) : nv;
              parser.setConfig(newCfg);
              parser.reset();
              rebuildBoundCtrlTokens(newCfg);
              try { if (ui) ui.setShowCmd(''); } catch (_) {}
            } else {
              loadConfig().then((baseCfg) => {
                parser.setConfig(baseCfg);
                parser.reset();
                rebuildBoundCtrlTokens(baseCfg);
              });
            }
          } catch (_) {}
        }
      });
    } catch (_) {}

    API.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.action === 'reloadMotionsConfig') {
        loadConfig().then((newCfg) => {
          parser.setConfig(newCfg);
          parser.reset();
          rebuildBoundCtrlTokens(newCfg);
          try { if (ui) ui.setShowCmd(''); } catch (_) {}
          sendResponse({ ok: true });
        });
        return true;
      } else if (msg && msg.action === 'updateSettings' && msg.settings) {
        try {
          if (typeof msg.settings.theme !== 'undefined') { uiTheme = msg.settings.theme || 'vim'; if (ui) ui.setTheme(uiTheme); }
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
        return true;
      }
      return false;
    });

    try {
      window.addEventListener('beforeunload', () => {
        try { executor.exec({ kind: 'command', command: { id: 'record_last_exit' }, count: 1 }); } catch (_) {}
      });
    } catch (_) {}
  }

  function refreshModeIndicator() {
    try {
      if (!ui) return;
      ui.setTempNormal(!!tempNormal);
      ui.setMode(mode);
      ui.updateCursorStyle();
      if (mode === 'insert' && replaceMode) try { ui.setReplaceMode(true); } catch (_) {}
      else try { ui.setReplaceMode(false); } catch (_) {}
    } catch (_) {}
  }

  function setMode(newMode) {
    if (newMode === 'insert' && mode !== 'insert') resetInsertOps();
    mode = newMode;
    try { if (parser && typeof parser.setMode === 'function') parser.setMode(newMode); } catch (_) {}
    refreshModeIndicator();
    setTimeout(() => { if (mode === newMode) refreshModeIndicator(); }, 0);
    // Also clear showcmd when entering normal from insert/visual (fresh Vim does)
    if (newMode === 'normal') try { if (ui) ui.setShowCmd(''); } catch (_) {}
    if (newMode === 'insert') try { if (ui && ui.clearMessage) ui.clearMessage(); } catch (_) {}
  }

  const modeAPI = {
    setMode: (m) => { setMode(m); },
    getMode: () => mode,
    isVisual: () => mode === 'visual' || mode === 'visualLine',
    getReplaceMode: () => replaceMode,
    setReplaceMode: (v) => {
      replaceMode = !!v;
      try { if (ui && ui.setReplaceMode) ui.setReplaceMode(replaceMode); } catch (_) {}
      refreshModeIndicator();
    }
  };
  const settingsAPI = { getUseDisplayLines: () => useDisplayLines };
  executor = window.createVimExecutor(modeAPI, settingsAPI);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
