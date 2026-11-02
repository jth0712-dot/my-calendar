// My Calendar - 폰(웹앱)용 저장소 어댑터
// PC(Electron)의 window.calendarAPI 와 같은 함수 이름을 제공하여 index.html을 그대로 사용한다.
// 데이터: 이 기기 브라우저의 IndexedDB (앱 삭제/사이트 데이터 삭제 시 함께 삭제됨)
(function () {
  const DB_NAME = 'my-calendar', DB_VER = 1;
  let db = null, data = {}, attachments = new Map();

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('attachments')) d.createObjectStore('attachments');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  }
  function getAll(store) {
    return new Promise((resolve, reject) => {
      const out = new Map();
      const req = db.transaction(store).objectStore(store).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out); };
      req.onerror = () => reject(req.error);
    });
  }

  let saveFailed = false;
  function warnSave(err) {
    console.error('저장 실패', err);
    if (!saveFailed) { saveFailed = true; alert('이 기기에 저장하지 못했습니다. 저장 공간을 확인해 주세요.'); }
  }

  window.calendarAPI = {
    platform: 'web',
    loadData: () => JSON.parse(JSON.stringify(data || {})),
    saveData: d => {
      try {
        data = JSON.parse(JSON.stringify(d || {}));
        data.updatedAt = new Date().toISOString();
        tx('kv', 'readwrite', s => s.put(data, 'data')).catch(warnSave);
        window.dispatchEvent(new CustomEvent('calendar:saved'));
        return true;
      } catch (e) { warnSave(e); return false; }
    },
    getDataPath: () => '이 휴대폰(앱 저장소)',
    saveAttachment: dataUrl => {
      const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp);base64,/i);
      if (!m) return null;
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      attachments.set(fileName, dataUrl);
      tx('attachments', 'readwrite', s => s.put(dataUrl, fileName)).catch(warnSave);
      return { fileName };
    },
    readAttachment: fileName => attachments.get(String(fileName || '')) || '',
    deleteAttachment: fileName => {
      const k = String(fileName || '');
      attachments.delete(k);
      tx('attachments', 'readwrite', s => s.delete(k)).catch(() => {});
      return true;
    },
    notify: (title, body) => {
      try {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(r => r.showNotification(title || '일정 알림', { body: body || '', icon: 'icons/icon-192.png' }));
        } else new Notification(title || '일정 알림', { body: body || '' });
      } catch (e) { console.error(e); }
    },
    // 2단계(동기화)에서 사용
    _exportAll: () => ({ data: JSON.parse(JSON.stringify(data || {})), attachments: Object.fromEntries(attachments) }),
    _importAll: async (payload) => {
      data = payload.data || {};
      await tx('kv', 'readwrite', s => s.put(data, 'data'));
      for (const [k, v] of Object.entries(payload.attachments || {})) {
        attachments.set(k, v);
        await tx('attachments', 'readwrite', s => s.put(v, k));
      }
    }
  };

  function startApp() {
    const src = document.getElementById('appMain');
    const s = document.createElement('script');
    s.textContent = src.textContent;
    document.body.appendChild(s);
  }

  async function boot() {
    try {
      db = await openDb();
      data = (await tx('kv', 'readonly', s => s.get('data'))) || {};
      attachments = await getAll('attachments');
    } catch (e) {
      console.error(e);
      alert('저장소를 열지 못했습니다. 브라우저의 시크릿 모드가 아닌지 확인해 주세요.');
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
    startApp();
    // 알림 권한은 첫 터치 때 요청
    document.addEventListener('click', () => {
      try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {}
    }, { once: true });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
