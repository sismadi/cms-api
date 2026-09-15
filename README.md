# Konversi POS → Blog Multi-User

Ringkasan perubahan dari `pos-api-main` + `pos-app-main` menjadi platform
blog multi-user dengan routing publik `piawai.id/<user>/<slug-artikel>`.

## Keputusan arsitektur (dikonfirmasi sebelum coding)

1. **1 user = 1 tenant**, isolasi data penuh — persis pola toko di versi
   POS, hanya kontennya diganti dari produk/transaksi menjadi artikel.
2. **SSR dari awal** — halaman publik (`/`, `/:user`, `/:user/:slug`)
   dirender penuh sebagai HTML oleh Worker (bukan SPA), supaya:
   - Google/mesin pencari bisa mengindeks artikel tanpa menjalankan JS.
   - Pengunjung bisa membaca & mengirim komentar walau JS dimatikan
     (form komentar POST langsung ke Worker, pola POST-redirect-GET).

## Perubahan struktur yang PALING PENTING

**Deployment berubah dari 2 origin terpisah menjadi 1 origin.** Versi POS
men-deploy `pos-api` (Worker, JSON API) dan `pos-app` (static site, fetch
ke Worker via absolute URL) secara independen. Untuk SSR bekerja di
domain publik (`piawai.id`), keduanya SEKARANG HARUS satu deployment:

```
blog-api/          <- repo ini (Worker: API + SSR + serve static)
  worker.js
  schema.sql
  wrangler.toml     (binding [assets] menunjuk ke ../blog-app)
blog-app/           <- aset statis + app admin (SPA)
  app.html          (shell admin, BUKAN index.html — lihat alasan di bawah)
  engine.js, db.js, auth.js, dataset.js
  style.css, svg.css, svg.js
  pages/*.js
  robots.txt
```

Deploy dengan `wrangler deploy` dari dalam `blog-api/` (isi dulu
`database_id` di `wrangler.toml` hasil `wrangler d1 create`, lalu
`wrangler d1 execute <NAMA_DB> --file=schema.sql`).

### Mengapa `app.html`, bukan `index.html`?

Cloudflare Workers Assets otomatis menyajikan `index.html` untuk request
ke `/` SEBELUM Worker dijalankan. Kita justru ingin `/` dirender oleh
Worker (daftar blog publik), bukan file statis. Dengan menamainya
`app.html`, path `/` tidak pernah "tersandung" file statis — semua
request yang bukan file aset nyata (style.css, engine.js, dst.) otomatis
sampai ke `worker.js`, yang lalu memutuskan: SSR publik, atau serve
`app.html` untuk path admin. Ini perilaku default Workers Assets: Worker
hanya dipanggil kalau tidak ada aset yang match — jadi tidak perlu
`run_worker_first`.

## Pemetaan skema (POS → Blog)

| POS                          | Blog                                    |
|-------------------------------|------------------------------------------|
| `tenants` (toko)              | `tenants` (blog/penulis) — kolom `kodeToko` kini RANGKAP: kode login **dan** slug URL publik |
| `users` (kasir/gudang/owner)   | `users` (penulis/owner/superadmin)       |
| `produk`, `lokasi`, `distribusi`, `transaksi`, `kontak`, `akun`, `jurnal`, dst. | **dihapus** |
| — | `post` (artikel) — baru |
| — | `komentar` (komentar publik per artikel) — baru |

`worker.js` mempertahankan pola CRUD generik `/api/:table` yang sama
persis (termasuk aturan isolasi tenant), hanya `TABLES`/`SCOPED_TABLES`
yang diperbarui.

## Rute publik (SSR, tanpa perlu JS)

- `GET /` — daftar blog aktif
- `GET /:user` — profil + daftar artikel *publish* milik `:user`
- `GET /:user/:slug` — 1 artikel penuh, meta tag OG/JSON-LD, form komentar
- `POST /:user/:slug` — submit komentar (form HTML biasa, redirect 303)

## Rute admin (SPA, butuh login)

`login`, `register`, `dashboard`, `editor` (+ `editor/:id`), `postingan`,
`profil`, `tenant` (superadmin). Semua path ini disajikan `app.html` apa
pun sub-path-nya; router client (`engine.js`) membaca
`window.location.pathname` untuk menampilkan halaman yang benar.

## Yang SENGAJA belum digarap di v1 (agar rilis cepat & terkontrol)

- **Konten artikel = HTML mentah**, bukan editor rich-text atau markdown.
  Penulis mengetik HTML dasar (`<p>`, `<strong>`, `<a>`) langsung di
  textarea. Cocok untuk profil "pracademic"/developer; kalau target
  pengguna lebih luas, tambahkan parser markdown-lite atau rich-text
  editor sebagai iterasi berikutnya.
- **Moderasi komentar**: kolom `status` sudah ada di tabel `komentar`
  (default `approved`) tapi belum ada UI moderasi — semua komentar
  langsung tampil. Tambahkan halaman moderasi di dashboard kalau spam
  jadi masalah.
- **`sitemap.xml`** belum dibuat (robots.txt sudah ada). Mudah ditambah:
  query semua tenant aktif + post publish di worker.js, generate XML.
- Keamanan `tenantId` di query string masih pola yang sama seperti versi
  POS (lihat catatan di worker.js) — belum pakai sesi/JWT server-side.
