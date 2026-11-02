// My Calendar - 폰(웹앱)용 PC↔폰 동기화 (v1.26)
// 구글 로그인: Google Identity Services(토큰 방식, 1시간 유효). 만료 후에는 화면을 한 번 탭할 때 자동 재로그인.
// 비밀번호로 만든 암호 키는 이 폰 안에 '꺼낼 수 없는 키'로 보관(비밀번호 자체는 저장하지 않음).
(function () {
  const API = window.calendarAPI, ST = window.__mcStore, C = window.SyncCore;
  if (!API || !ST || !C) return;
  const CLIENT_ID = (window.MC_CONFIG && window.MC_CONFIG.googleClientId) || '';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

  let token = null;            // { access_token, expiresAt }
  let tokenClient = null, authInFlight = false, lastAuthTry = 0;
  const handlers = { cb: () => {}, err: () => {} };
  let statusCb = null, status = { state: 'idle', message: '' };
  let running = false, again = false, timer = null;
  let state = { configured: false, lastSync: null, lastError: null, consented: false };

  const tokenValid = () => token && token.access_token && Date.now() < token.expiresAt - 60000;
  const store = {
    getSnapshot: async () => ST.snapshot(),
    applyIfSeq: (d, seq) => ST.applyIfSeq(d, seq),
    getBase: async () => (await ST.kvGet('syncBase')) || null,
    setBase: b => ST.kvPut('syncBase', b),
    listAttachments: () => ST.listAttachments(),
    readAttachment: n => ST.readAttachmentBytes(n),
    writeAttachment: (n, b) => ST.writeAttachmentBytes(n, b)
  };
  const drive = new C.DriveClient({
    getToken: async () => {
      if (tokenValid()) return token.access_token;
      const e = new Error('구글 로그인이 만료되었습니다. 화면을 한 번 탭하면 다시 동기화합니다.'); e.code = 'NEED_LOGIN'; throw e;
    }
  });
  const engine = new C.SyncEngine({ drive, store, deviceName: 'PHONE' });

  async function saveState(patch) { state = { ...state, ...patch }; await ST.kvPut('syncState', state); }
  function publicStatus() { return { configured: !!state.configured, state: status.state, message: status.message, lastSync: state.lastSync, lastError: state.lastError }; }
  function emit(s, m = '') { status = { state: s, message: m }; if (statusCb) statusCb(publicStatus()); }

  function friendly(err) {
    const m = String((err && (err.detail || err.message)) || err);
    if (err && err.code === 'NEED_LOGIN') return err.message;
    if (/accessNotConfigured|has not been used|is disabled/i.test(m)) return 'Google Drive API가 꺼져 있습니다. 구글 클라우드에서 "사용"으로 바꿔 주세요.';
    if (/popup_closed|popup_failed/i.test(m)) return '구글 로그인 창이 닫혔습니다. 다시 시도해 주세요.';
    if (/access_denied/i.test(m)) return '구글 로그인에서 권한을 허용하지 않았습니다.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return '인터넷에 연결되어 있지 않습니다. 연결되면 자동으로 다시 시도합니다.';
    return m;
  }

  // ---------- Google 로그인 ----------
  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    if (!CLIENT_ID) throw new Error('폰용 구글 클라이언트 ID가 설정되지 않았습니다.');
    if (!(window.google && google.accounts && google.accounts.oauth2)) throw new Error('구글 로그인 모듈을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요.');
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: r => handlers.cb(r), error_callback: e => handlers.err(e) });
    return tokenClient;
  }
  // 반드시 사용자의 탭(클릭) 처리 중에 호출해야 팝업이 열린다
  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      let tc;
      try { tc = ensureTokenClient(); } catch (e) { reject(e); return; }
      authInFlight = true; lastAuthTry = Date.now();
      handlers.cb = async resp => {
        authInFlight = false;
        if (!resp || resp.error) { reject(new Error(resp && (resp.error_description || resp.error) || '로그인 실패')); return; }
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) { reject(new Error('access_denied')); return; }
        token = { access_token: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        try { await ST.kvPut('gtoken', token); await saveState({ consented: true }); } catch {}
        resolve(token);
      };
      handlers.err = err => { authInFlight = false; reject(new Error((err && err.type) || 'popup_failed')); };
      tc.requestAccessToken({ prompt });
    });
  }

  // ---------- 동기화 ----------
  function schedule(ms = 3000) {
    if (!state.configured) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow().catch(() => {}), ms);
  }
  async function syncNow(opts = {}) {
    if (running) { again = true; return publicStatus(); }
    if (!state.configured) return publicStatus();
    running = true;
    try {
      if (!engine.key) {
        const k = await ST.kvGet('syncKey');
        if (!k) { emit('locked', '동기화 비밀번호를 다시 입력해 주세요. [동기화 설정]'); return publicStatus(); }
        engine.key = k;
      }
      if (!tokenValid()) { emit('idle', '⏸ 화면을 한 번 탭하면 구글 로그인 후 동기화합니다.'); return publicStatus(); }
      emit('syncing', '동기화 중...');
      const s = await engine.sync(opts);
      await saveState({ lastSync: new Date().toISOString(), lastError: null });
      const parts = [];
      if (s.pulled) parts.push('PC 변경 반영');
      if (s.pushed) parts.push('업로드');
      if (s.attUp || s.attDown) parts.push(`사진 ${s.attUp + s.attDown}장`);
      emit('idle', parts.length ? `동기화 완료 (${parts.join(' · ')})` : '동기화 완료 (변경 없음)');
    } catch (err) {
      if (err && err.code === 'RETRY') { again = true; emit('idle', err.message); }
      else if (err && err.code === 'NEED_LOGIN') { emit('idle', '⏸ ' + err.message); }
      else { const msg = friendly(err); await saveState({ lastError: msg }); emit('error', msg); }
    } finally {
      running = false;
      if (again) { again = false; schedule(1500); }
    }
    return publicStatus();
  }

  // ---------- 화면(index.html)에서 쓰는 함수: PC와 같은 이름 ----------
  API.syncStatus = async () => publicStatus();
  API.onSyncStatus = cb => { statusCb = cb; };
  API.syncConnect = () => {
    // 탭 처리 중 동기적으로 로그인 팝업을 연다
    const p = requestToken(state.consented ? '' : 'consent');
    return p.then(async () => {
      const info = await engine.remoteInfo();
      const base = await ST.kvGet('syncBase');
      const localHas = C.hasContent(ST.snapshot().data);
      return { ok: true, mode: info.hasMeta ? 'enter' : 'create', askFirstMode: !!(info.hasData && localHas && !base) };
    }).catch(err => ({ ok: false, error: friendly(err) }));
  };
  API.syncUnlock = async (passphrase, firstMode) => {
    try {
      await engine.unlock(passphrase, false);   // 꺼낼 수 없는 키
      await ST.kvPut('syncKey', engine.key);
      await saveState({ configured: true });
      const st = await syncNow({ firstMode });
      return { ok: !st.lastError, status: st, error: st.lastError || '' };
    } catch (err) {
      return { ok: false, error: err.code === 'BAD_PASSWORD' ? err.message : friendly(err) };
    }
  };
  API.syncNow = () => {
    if (!tokenValid() && state.configured) {
      return requestToken('').then(() => syncNow()).then(st => ({ ok: !st.lastError, status: st }))
        .catch(err => { emit('error', friendly(err)); return { ok: false, status: publicStatus() }; });
    }
    return syncNow().then(st => ({ ok: !st.lastError, status: st }));
  };
  API.syncDisconnect = async () => {
    for (const k of ['syncKey', 'syncBase']) { try { await ST.kvDel(k); } catch {} }
    engine.key = null;
    await saveState({ configured: false, lastError: null });
    emit('idle', '이 폰의 동기화를 해제했습니다. (데이터는 그대로 남아 있습니다)');
    return { ok: true, status: publicStatus() };
  };

  // ---------- 자동 동기화 ----------
  window.addEventListener('calendar:saved', () => schedule(3000));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(600); });
  window.addEventListener('online', () => schedule(500));
  setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, 5 * 60 * 1000);
  // 로그인 만료 상태에서 화면을 탭하면 조용히 재로그인 후 동기화
  document.addEventListener('click', e => {
    if (!state.configured || tokenValid() || authInFlight || !CLIENT_ID) return;
    if (Date.now() - lastAuthTry < 30000) return;
    if (e.target && e.target.closest && e.target.closest('#syncPanel')) return;
    requestToken('').then(() => syncNow()).catch(err => emit('idle', '⏸ ' + friendly(err)));
  }, true);

  ST.ready.then(async () => {
    try {
      state = { ...state, ...((await ST.kvGet('syncState')) || {}) };
      const t = await ST.kvGet('gtoken');
      if (t && t.access_token) token = t;
    } catch {}
    if (statusCb) statusCb(publicStatus());
    schedule(1200);
  });
})();
