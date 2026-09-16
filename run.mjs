import fs from 'node:fs';
import worker, { __test__ } from '../out/cms-api-secured/worker.js';
import { makeD1 } from './d1shim.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

// ---- siapkan DB dengan seed ter-hash ----
let schema = fs.readFileSync(new URL('../out/cms-api-secured/schema.sql', import.meta.url), 'utf8');
const hSuper = await __test__.hashPassword('Sup3rAdmin!2026');
const hWawan = await __test__.hashPassword('Wawan!Demo2026');
schema = schema.replace('__HASH_SUPERADMIN__', hSuper).replace('__HASH_WAWAN__', hWawan);

const env = {
  DB: makeD1(schema),
  SESSION_SECRET: 'x'.repeat(48),
  TURNSTILE_SECRET_KEY: 'dummy-secret',
  ALLOWED_ORIGINS: 'https://cms.piawai.id',
};

// mock siteverify: token 'good' sukses, lainnya gagal
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('siteverify')) {
    const resp = init.body.get('response');
    return new Response(JSON.stringify({ success: resp === 'good' }), { headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};

const ORIGIN = 'https://cms.piawai.id';
function req(path, { method = 'GET', body, token, ip = '1.2.3.4' } = {}) {
  const h = { 'Origin': ORIGIN, 'CF-Connecting-IP': ip };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  return new Request(`https://api.test${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const call = async (...a) => {
  const res = await worker.fetch(req(...a), env);
  let data = null;
  try { data = await res.clone().json(); } catch (e) {}
  return { status: res.status, data, headers: res.headers };
};

console.log('\n== 1. Hashing password ==');
ok('hash tidak memuat plaintext', !hWawan.includes('Wawan!Demo2026'));
ok('verify password benar', await __test__.verifyPassword('Wawan!Demo2026', hWawan));
ok('verify password salah ditolak', !(await __test__.verifyPassword('salah', hWawan)));
ok('dua hash password sama berbeda (salt unik)',
  (await __test__.hashPassword('abc')) !== (await __test__.hashPassword('abc')));

console.log('\n== 2. Tabel users/komentar diblokir dari /api ==');
let r = await call('/api?table=users&cmsId=cms_demo');
ok('GET users tanpa token -> 401', r.status === 401, JSON.stringify(r.data));

console.log('\n== 3. Login ==');
r = await call('/public?view=login', { method: 'POST', body: { kodeCms: 'wawan', username: 'wawan', password: 'Wawan!Demo2026', turnstileToken: 'bad' } });
ok('captcha gagal -> 400', r.status === 400, JSON.stringify(r.data));

r = await call('/public?view=login', { method: 'POST', body: { kodeCms: 'wawan', username: 'wawan', password: 'salah', turnstileToken: 'good' } });
ok('password salah -> 401', r.status === 401);

r = await call('/public?view=login', { method: 'POST', body: { kodeCms: 'wawan', username: 'wawan', password: 'Wawan!Demo2026', turnstileToken: 'good' } });
ok('login benar -> 200 + token', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
ok('respons login tidak memuat hash/password', !JSON.stringify(r.data).match(/pbkdf2|password/i), JSON.stringify(r.data));
const tokenWawan = r.data.token;

r = await call('/api?table=users', { token: tokenWawan });
ok('GET users dengan token valid -> 403 (tetap diblokir)', r.status === 403, JSON.stringify(r.data));
r = await call('/api?table=komentar', { token: tokenWawan });
ok('GET komentar lewat /api -> 403', r.status === 403);

console.log('\n== 4. Registrasi + isolasi CMS (IDOR) ==');
r = await call('/public?view=register', { method: 'POST', ip: '9.9.9.9', body: {
  kodeCms: 'siti', namaCms: 'Catatan Siti', ownerName: 'Siti', username: 'siti', password: 'pendek', turnstileToken: 'good' } });
ok('password < 8 karakter ditolak', r.status === 400, JSON.stringify(r.data));

r = await call('/public?view=register', { method: 'POST', ip: '9.9.9.9', body: {
  kodeCms: 'siti', namaCms: 'Catatan Siti', ownerName: 'Siti', username: 'siti', password: 'SitiRahasia9', turnstileToken: 'good' } });
ok('registrasi sukses -> 201 + token', r.status === 201 && !!r.data.token, JSON.stringify(r.data));
const tokenSiti = r.data.token;
const cmsIdSiti = r.data.user.cmsId;

// Siti membuat artikel
r = await call('/api?table=post', { method: 'POST', token: tokenSiti, body: { slug: 'rahasia-siti', judul: 'Rahasia Siti', konten: '<p>hai</p>', status: 'publish' } });
ok('Siti bisa membuat artikel', r.status === 201, JSON.stringify(r.data));
const postSitiId = r.data?.id;

// Wawan mencoba membaca artikel Siti dengan memalsukan cmsId di query (IDOR klasik)
r = await call(`/api?table=post&cmsId=${cmsIdSiti}`, { token: tokenWawan });
const judulTerlihat = JSON.stringify(r.data);
ok('cmsId palsu di query DIABAIKAN (tak ada artikel Siti)', !judulTerlihat.includes('Rahasia Siti'), judulTerlihat);

r = await call(`/api?table=post&id=${postSitiId}&cmsId=${cmsIdSiti}`, { token: tokenWawan });
ok('GET by id lintas-CMS -> 404', r.status === 404);
r = await call(`/api?table=post&id=${postSitiId}&cmsId=${cmsIdSiti}`, { method: 'DELETE', token: tokenWawan });
const stillThere = await call(`/api?table=post&id=${postSitiId}`, { token: tokenSiti });
ok('DELETE lintas-CMS tidak menghapus apa pun', stillThere.status === 200 && stillThere.data?.id === postSitiId);

r = await call('/api?table=cms', { token: tokenWawan });
ok('non-superadmin hanya melihat CMS sendiri', Array.isArray(r.data) && r.data.length === 1 && r.data[0].id === 'cms_demo', JSON.stringify(r.data));

r = await call('/api?table=cms&id=cms_demo', { method: 'PATCH', token: tokenSiti, body: { nama: 'Dibajak' } });
ok('PATCH cms milik orang lain -> 403', r.status === 403);

r = await call(`/api?table=cms&id=${cmsIdSiti}`, { method: 'PATCH', token: tokenSiti, body: { nama: 'Siti Baru', status: 'nonaktif', kodeCms: 'hack' } });
ok('owner bisa ubah nama', r.status === 200 && r.data.nama === 'Siti Baru');
ok('owner TIDAK bisa ubah status/kodeCms', r.data.status === 'aktif' && r.data.kodeCms === 'siti', JSON.stringify(r.data));

console.log('\n== 5. Token palsu / kedaluwarsa ==');
const forged = tokenWawan.split('.')[0] + '.' + 'AAAA';
r = await call('/api?table=post', { token: forged });
ok('tanda tangan token dipalsukan -> 401', r.status === 401);
// payload diubah (role jadi superadmin) tanpa tanda tangan baru
const payload = JSON.parse(Buffer.from(tokenWawan.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString());
payload.role = 'superadmin';
const tamper = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + tokenWawan.split('.')[1];
r = await call('/api?table=cms', { token: tamper });
ok('payload diubah jadi superadmin -> 401', r.status === 401);

console.log('\n== 6. Sanitasi HTML ==');
const dirty = `<p>ok</p><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">klik</a><a href="java&#115;cript:alert(1)">y</a><iframe src="//evil"></iframe><p onclick="bad()">z</p>`;
const clean = __test__.sanitizeHtml(dirty);
ok('<script> dibuang', !/script/i.test(clean), clean);
ok('onerror/onclick dibuang', !/on\w+=/i.test(clean), clean);
ok('javascript: dibuang', !/javascript:/i.test(clean), clean);
ok('entity-encoded javascript: dibuang', !clean.includes('&#115;cript:'), clean);
ok('iframe dibuang', !/iframe/i.test(clean), clean);
ok('konten sah dipertahankan', clean.includes('<p>ok</p>'), clean);

r = await call('/api?table=post', { method: 'POST', token: tokenWawan, body: { slug: 'uji-xss', judul: 'Uji', konten: dirty, status: 'publish' } });
ok('konten tersimpan sudah bersih', r.status === 201 && !/script|onerror/i.test(r.data.konten), JSON.stringify(r.data?.konten));

r = await call('/public?view=artikel&user=wawan&slug=uji-xss');
ok('konten tersaji lewat /public juga bersih', r.status === 200 && !/script|onerror/i.test(r.data.post.konten));

console.log('\n== 7. Injeksi nama kolom / field tak sah ==');
r = await call('/api?table=post', { method: 'POST', token: tokenWawan, body: {
  slug: 'uji-kolom', judul: 'Uji Kolom', konten: '<p>a</p>',
  'views = 999, judul': 'x', cmsId: cmsIdSiti, id: 'pst_1', views: 9999 } });
ok('field tak sah diabaikan, insert tetap sukses', r.status === 201, JSON.stringify(r.data));
ok('cmsId dari body diabaikan', r.data?.cmsId === 'cms_demo', r.data?.cmsId);
ok('id dari body diabaikan (tidak menimpa pst_1)', r.data?.id !== 'pst_1');
ok('views tidak bisa diset klien', r.data?.views === 0);

console.log('\n== 8. Komentar ==');
r = await call('/public?view=komentar&user=wawan&slug=selamat-datang', { method: 'POST', body: { nama: 'Anonim Palsu', isi: 'spam' } });
ok('komentar tanpa token -> 401', r.status === 401);

r = await call('/public?view=komentar&user=wawan&slug=selamat-datang', { method: 'POST', token: tokenSiti, body: { nama: 'Super Admin', userId: 'usr_super', isi: 'Halo!' } });
ok('komentar dengan token -> 201', r.status === 201, JSON.stringify(r.data));
ok('nama komentator diambil dari token, bukan body', r.data?.nama === 'Siti', r.data?.nama);
ok('userId diambil dari token', r.data?.userId !== 'usr_super');

console.log('\n== 9. Rate limit login ==');
let lastStatus = 0;
for (let i = 0; i < 8; i++) {
  const rr = await call('/public?view=login', { method: 'POST', ip: '5.5.5.5', body: { kodeCms: 'wawan', username: 'wawan', password: 'salah-terus', turnstileToken: 'good' } });
  lastStatus = rr.status;
}
ok('setelah beberapa percobaan gagal -> 429 (terkunci)', lastStatus === 429, `status terakhir ${lastStatus}`);
r = await call('/public?view=login', { method: 'POST', ip: '5.5.5.5', body: { kodeCms: 'wawan', username: 'wawan', password: 'Wawan!Demo2026', turnstileToken: 'good' } });
ok('password benar pun tetap ditolak selama terkunci', r.status === 429);

console.log('\n== 10. CORS ==');
const res = await worker.fetch(new Request('https://api.test/public?view=home', { headers: { Origin: 'https://evil.example' } }), env);
ok('origin asing tidak mendapat Access-Control-Allow-Origin', !res.headers.get('Access-Control-Allow-Origin'));
const res2 = await worker.fetch(new Request('https://api.test/public?view=home', { headers: { Origin: ORIGIN } }), env);
ok('origin terdaftar diizinkan', res2.headers.get('Access-Control-Allow-Origin') === ORIGIN);

console.log('\n== 11. Kebocoran error internal ==');
r = await call('/api?table=post&id=x%27%20OR%201=1--', { token: tokenWawan });
ok('id aneh tidak membocorkan SQL', r.status === 404 || r.status === 200);

console.log(`\n=== ${pass} lulus, ${fail} gagal ===`);
process.exit(fail ? 1 : 0);
