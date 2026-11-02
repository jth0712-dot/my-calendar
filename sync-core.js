// My Calendar - PC/폰 공용 동기화 엔진 (v1.26)
// - 저장소: 사용자 구글 드라이브의 숨김 앱 폴더(appDataFolder)
// - 암호화: 사용자 비밀번호 -> PBKDF2(SHA-256) -> AES-GCM 256. 구글에는 암호문만 저장됨
// - 병합: 마지막 동기화 시점(base)을 기준으로 항목(id)별 3방향 병합
// PC(Electron main, Node)와 폰(브라우저) 양쪽에서 같은 파일을 사용한다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();

  const DATA_FILE = 'mc-data.bin';
  const META_FILE = 'mc-meta.json';
  const ATT_PREFIX = 'att_';
  const KDF_ITER = 310000;
  const CHECK_TEXT = 'my-calendar-sync-ok';
  const COLLECTIONS = ['events', 'instructionNotes', 'myNotes'];
  const SKIP_KEYS = new Set(['version', 'updatedAt', 'executiveNotes', 'teamNotes']);

  // ---------- utils ----------
  function b64(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function stable(v) {
    if (v === undefined) return 'undefined';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  const eq = (a, b) => stable(a) === stable(b);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function concat(...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(len);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---------- data shape ----------
  function normalize(d) {
    d = clone(d || {}) || {};
    if (!Array.isArray(d.instructionNotes)) {
      d.instructionNotes = [
        ...(d.executiveNotes || []).map(n => ({ ...n, category: 'executive' })),
        ...(d.teamNotes || []).map(n => ({ ...n, category: 'team' }))
      ];
    }
    for (const c of COLLECTIONS) if (!Array.isArray(d[c])) d[c] = [];
    for (const k of SKIP_KEYS) delete d[k];
    return d;
  }
  function denormalize(d) {
    const out = clone(d);
    out.executiveNotes = out.instructionNotes.filter(n => (n.category || 'executive') === 'executive');
    out.teamNotes = out.instructionNotes.filter(n => n.category === 'team');
    out.version = 26;
    return out;
  }
  // 항목 순서와 무관하게 비교하기 위한 정규형 (화면은 날짜/저장된 순서 목록으로 정렬하므로 배열 순서는 의미 없음)
  function canon(d) {
    const n = normalize(d);
    for (const c of COLLECTIONS) n[c] = n[c].slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return n;
  }
  const sameData = (a, b) => eq(canon(a), canon(b));
  function hasContent(d) {
    d = normalize(d);
    return COLLECTIONS.some(c => d[c].length > 0);
  }

  // ---------- 3-way merge ----------
  function pick(b, l, r) {
    if (eq(l, r)) return l;
    if (eq(l, b)) return r;          // 이 기기에서 안 바뀜 -> 상대 기기 내용
    if (eq(r, b)) return l;          // 상대 기기에서 안 바뀜 -> 이 기기 내용
    // 양쪽 모두 변경(충돌): 삭제보다 수정 우선, 그 외에는 이 기기 내용 우선
    if (l === undefined) return r;
    if (r === undefined) return l;
    return l;
  }
  function merge(base, local, remote) {
    const B = normalize(base || {}), L = normalize(local), R = normalize(remote);
    const out = {};
    let conflicts = 0;
    for (const c of COLLECTIONS) {
      const bm = new Map(B[c].map(x => [String(x.id), x]));
      const lm = new Map(L[c].map(x => [String(x.id), x]));
      const rm = new Map(R[c].map(x => [String(x.id), x]));
      const ids = [...lm.keys()];
      for (const id of rm.keys()) if (!lm.has(id)) ids.push(id);
      out[c] = [];
      for (const id of ids) {
        const b = bm.get(id), l = lm.get(id), r = rm.get(id);
        if (!eq(l, r) && !eq(l, b) && !eq(r, b)) conflicts++;
        const v = pick(b, l, r);
        if (v !== undefined) out[c].push(clone(v));
      }
    }
    const keys = new Set([...Object.keys(L), ...Object.keys(R)].filter(k => !COLLECTIONS.includes(k)));
    for (const k of keys) {
      const v = pick(B[k], L[k], R[k]);
      if (v !== undefined) out[k] = clone(v);
    }
    return { merged: out, conflicts };
  }

  function referencedAttachments(d) {
    const set = new Set();
    d = normalize(d);
    for (const c of COLLECTIONS) for (const item of d[c]) {
      for (const a of (Array.isArray(item.attachments) ? item.attachments : [])) {
        if (a && a.fileName) set.add(String(a.fileName));
      }
    }
    return set;
  }

  // ---------- crypto ----------
  async function deriveKey(passphrase, salt, iter, extractable) {
    const base = await subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, !!extractable, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, bytes) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    return concat(iv, ct);
  }
  async function decrypt(key, buf) {
    buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12)));
  }
  async function exportRawKey(key) { return b64(new Uint8Array(await subtle.exportKey('raw', key))); }
  async function importRawKey(str, extractable) {
    return subtle.importKey('raw', unb64(str), { name: 'AES-GCM' }, !!extractable, ['encrypt', 'decrypt']);
  }

  // ---------- Google Drive (appDataFolder) ----------
  class DriveClient {
    // getToken(force) -> access token ; fetchFn
    constructor({ getToken, fetchFn }) { this.getToken = getToken; this.fetch = fetchFn || globalThis.fetch.bind(globalThis); }
    async req(method, url, { body, headers, raw } = {}, retried) {
      const token = await this.getToken(false);
      const res = await this.fetch(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...(headers || {}) } });
      if (res.status === 401 && !retried) { await this.getToken(true); return this.req(method, url, { body, headers, raw }, true); }
      if (!res.ok) {
        let msg = '';
        try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.status)) || ''; if (j.error && j.error.errors && j.error.errors[0]) msg += ` [${j.error.errors[0].reason}]`; } catch {}
        const err = new Error(`드라이브 오류 (${res.status}${msg ? ': ' + msg : ''})`);
        err.status = res.status; err.detail = msg;
        throw err;
      }
      if (raw) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 204) return null;
      return res.json();
    }
    async list() {
      const out = new Map();
      let pageToken = '';
      do {
        const q = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,modifiedTime,size)', pageSize: '1000' });
        if (pageToken) q.set('pageToken', pageToken);
        const j = await this.req('GET', `https://www.googleapis.com/drive/v3/files?${q}`);
        for (const f of j.files || []) if (!out.has(f.name)) out.set(f.name, f);
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      return out;
    }
    download(id) { return this.req('GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { raw: true }); }
    async create(name, bytes, mime) {
      const boundary = 'mcb' + Math.random().toString(36).slice(2);
      const head = te.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`);
      const tail = te.encode(`\r\n--${boundary}--`);
      return this.req('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
        { body: concat(head, bytes, tail), headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
    }
    update(id, bytes, mime) {
      return this.req('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id`,
        { body: bytes, headers: { 'Content-Type': mime || 'application/octet-stream' } });
    }
    async put(files, name, bytes, mime) {
      const f = files.get(name);
      if (f) return this.update(f.id, bytes, mime);
      const r = await this.create(name, bytes, mime);
      files.set(name, { id: r.id, name });
      return r;
    }
  }

  // ---------- engine ----------
  // store adapter:
  //   getSnapshot() -> {data, seq}
  //   applyIfSeq(denormalizedData, seq) -> bool (이 기기 데이터를 병합 결과로 교체. 그 사이 저장이 있었으면 false)
  //   getBase() / setBase(d)
  //   listAttachments() -> Set(names) ; readAttachment(name) -> Uint8Array ; writeAttachment(name, bytes)
  class SyncEngine {
    constructor({ drive, store, deviceName }) { this.drive = drive; this.store = store; this.deviceName = deviceName || ''; this.key = null; }

    async remoteInfo() {
      const files = await this.drive.list();
      return { hasMeta: files.has(META_FILE), hasData: files.has(DATA_FILE) };
    }

    // 비밀번호로 잠금 해제(기존) 또는 최초 생성. 성공 시 this.key 설정
    async unlock(passphrase, extractable) {
      if (!passphrase || passphrase.length < 6) throw new Error('비밀번호는 6자 이상으로 입력해 주세요.');
      const files = await this.drive.list();
      if (files.has(META_FILE)) {
        const meta = JSON.parse(td.decode(await this.drive.download(files.get(META_FILE).id)));
        const key = await deriveKey(passphrase, unb64(meta.salt), meta.iter, extractable);
        try {
          const ok = td.decode(await decrypt(key, unb64(meta.check)));
          if (ok !== CHECK_TEXT) throw new Error();
        } catch { const e = new Error('동기화 비밀번호가 맞지 않습니다.'); e.code = 'BAD_PASSWORD'; throw e; }
        this.key = key;
        return { created: false };
      }
      const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(passphrase, salt, KDF_ITER, extractable);
      const meta = { v: 1, kdf: 'PBKDF2-SHA256', iter: KDF_ITER, salt: b64(salt), check: b64(await encrypt(key, te.encode(CHECK_TEXT))), createdAt: new Date().toISOString() };
      await this.drive.create(META_FILE, te.encode(JSON.stringify(meta)), 'application/json');
      this.key = key;
      return { created: true };
    }

    // firstMode: 'merge'(기본) | 'replace'(이 기기 데이터를 버리고 드라이브 데이터로 시작)
    async sync({ firstMode } = {}) {
      if (!this.key) { const e = new Error('동기화 비밀번호 입력이 필요합니다.'); e.code = 'LOCKED'; throw e; }
      const stats = { pulled: false, pushed: false, attUp: 0, attDown: 0, conflicts: 0 };
      const files = await this.drive.list();
      const snap = await this.store.getSnapshot();
      const base = await this.store.getBase();

      let remote = null;
      if (files.has(DATA_FILE)) {
        const plain = await decrypt(this.key, await this.drive.download(files.get(DATA_FILE).id));
        remote = JSON.parse(td.decode(plain));
      }
      const local = normalize(snap.data);
      let merged;
      if (!remote) merged = local;
      else if (firstMode === 'replace') merged = normalize(remote.data);
      else { const m = merge(base, local, remote.data); merged = m.merged; stats.conflicts = m.conflicts; }

      // 1) 이 기기에 반영 (그 사이 사용자가 저장했다면 중단하고 다음 기회에 재시도)
      if (!sameData(merged, local)) {
        const ok = await this.store.applyIfSeq(denormalize(merged), snap.seq);
        if (!ok) { const e = new Error('동기화 중 새 저장이 있어 잠시 후 다시 시도합니다.'); e.code = 'RETRY'; throw e; }
        stats.pulled = true;
      }

      // 2) 첨부 이미지
      const refs = referencedAttachments(merged);
      const localAtt = await this.store.listAttachments();
      for (const name of refs) {
        const remoteName = ATT_PREFIX + name;
        if (localAtt.has(name) && !files.has(remoteName)) {
          const bytes = await this.store.readAttachment(name);
          if (bytes && bytes.length) { await this.drive.put(files, remoteName, await encrypt(this.key, bytes)); stats.attUp++; }
        } else if (!localAtt.has(name) && files.has(remoteName)) {
          const bytes = await decrypt(this.key, await this.drive.download(files.get(remoteName).id));
          await this.store.writeAttachment(name, bytes); stats.attDown++;
        }
      }

      // 3) 드라이브에 반영
      if (!remote || !sameData(merged, remote.data)) {
        const payload = { data: merged, savedAt: new Date().toISOString(), device: this.deviceName };
        await this.drive.put(files, DATA_FILE, await encrypt(this.key, te.encode(JSON.stringify(payload))));
        stats.pushed = true;
      }
      await this.store.setBase(merged);
      return stats;
    }
  }

  return { SyncEngine, DriveClient, merge, normalize, canon, sameData, denormalize, hasContent, referencedAttachments, stable, eq,
    deriveKey, encrypt, decrypt, exportRawKey, importRawKey, b64, unb64, DATA_FILE, META_FILE, ATT_PREFIX };
});
