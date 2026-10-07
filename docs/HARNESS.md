# Menjalankan harness Gurow

Harness ini menambahkan pemeriksaan nyata dan paket handoff di sekitar coding agent. Bisa dipanggil dari terminal atau oleh agent. Tidak membutuhkan API key/model tambahan.

## Antigravity dan Gemini CLI

Aturan Antigravity tersedia di `.agent/rules/gurow-harness.md` dengan `trigger: always_on`. Jalur kompatibilitas `.agent/rules` dipakai karena `.agents/` dikelola read-only oleh lingkungan sesi ini; [Google masih mendukung jalur tersebut](https://antigravity.google/docs/rules-workflows). Buka proyek ini di Antigravity, mulai sesi baru, lalu periksa **Customizations → Rules** untuk memastikan `gurow-harness` aktif. Integrasi UI tidak otomatis menjalankan tes: agent memanggil runner mengikuti aturan itu.

Untuk Gemini CLI, `GEMINI.md` menunjuk instruksi repo yang sama. Gunakan `/memory reload`, lalu `/memory show` untuk memeriksa pemuatannya sesuai [dokumentasi Gemini CLI](https://geminicli.com/docs/cli/gemini-md/). Jika editor lain tidak membaca kedua format ini, sertakan `AGENTS.md` dan `docs/agents/harness.md` dalam prompt.

## Mulai

Jalankan dari root repo di Linux/macOS. Dependensi aplikasi mengikuti README; runner menggunakan Python 3.10+, Git, dan `gh` yang sudah login untuk mengambil issue.

```bash
python3 scripts/harness.py start T04 --base main
```

Ganti T04 dengan tiket yang dikerjakan. Untuk melanjutkan sesi yang sudah ada, gunakan `status`, bukan `start` lagi. `start` tidak membuat/memindahkan branch; gunakan branch fitur yang sesuai. Baseline dipatok menjadi SHA agar review berikutnya membandingkan perubahan yang sama. Issue diambil dari GitHub memakai mapping `docs/tickets/README.md`; kegagalan jaringan tidak diam-diam beralih ke spec lokal.

Agent mengisi `.harness/task.json`, satu baris untuk setiap acceptance criterion. Contoh isi suatu baris:

```json
{
  "id": "AC3",
  "requirement": "Pertahankan teks asli yang diambil dari issue",
  "test": "frontend/scripts/t04-smoke-check.ts",
  "assertion": "Drag kartu, zoom, reload; bandingkan geometri label dan seluruh koneksi dari engine yang baru dimuat. Injeksi foreign Path, lalu edit Task; checkpoint yang ditolak harus tetap tersimpan."
}
```

Isi ini adalah rencana/peta bukti untuk reviewer. Runner hanya memastikan pemetaan lengkap dan file ada; reviewer tetap memeriksa apakah assertion di tes benar-benar membuktikan requirement.

## Selama coding dan sebelum review

```bash
# Cepat: tes runner, typecheck, tes frontend, dan tes Rust
python3 scripts/harness.py check --quick

# Lengkap: pemeriksaan di atas, build baru, browser, dan acceptance tiket
python3 scripts/harness.py check

# Terfokus: hanya check pilihan beserta yang dibutuhkannya (build, database)
python3 scripts/harness.py check --only t28-recovery t16-path-authoring

# Lihat hasil dan apakah kode berubah sejak diperiksa
python3 scripts/harness.py status

# Siapkan paket untuk reviewer setelah full check lulus
python3 scripts/harness.py review
```

Check serial (build, database, backend, Rust) berjalan lebih dulu, lalu check bertanda `parallel` (tes browser dan unit test frontend, masing-masing dengan port, database, dan file sendiri) berjalan bersamaan, sebanyak `jobs` sekaligus (default 3; `--jobs 1` untuk menjalankannya satu per satu saat menyelidiki tes yang flaky). Tes browser memakai build dari run itu (`--skip-build` dan `requires: ["build"]`), jadi frontend dibangun sekali per run. Kegagalan pertama menghentikan check yang belum mulai dan mengembalikan exit code bukan nol. Log per perintah tersimpan di `.harness/runs/`; hasil terbaru ada di `.harness/quick.json`, `focused.json`, dan `full.json`. Perubahan source, file baru, konfigurasi, atau peta AC membuat bukti lama `STALE`. Pemeriksaan yang gagal/terputus tidak memakai ulang status lulus sebelumnya. Hanya `full.json` yang bisa dipakai untuk paket review.

Selama siklus perbaikan review, jalankan `--only` dengan check acceptance tiket dan regresi area yang disentuh; full run cukup sekali setelah perbaikan terakhir, sebelum commit atau merge.

`review` menghasilkan `.harness/review.md` dan `review.diff`. Buka sesi reviewer baru dan kirim:

> Review pekerjaan ini dengan membaca `.harness/review.md`, spec, diff, dan assertion tes sebenarnya. Periksa Standards dan Spec secara terpisah. Cari reproduksi konkret, termasuk jalur gagal. Jangan anggap status tes lulus sebagai bukti seluruh acceptance criteria terpenuhi.

Untuk agent implementer, gunakan prompt:

> Kerjakan T05 mengikuti `AGENTS.md` dan `docs/agents/harness.md`. Mulai/resume harness dengan baseline main. Petakan semua AC ke assertion yang bisa diamati, buat regresi gagal sebelum memperbaiki bug, lalu jalankan pemeriksaan lengkap dan siapkan paket review. Laporkan gap apa pun dengan jujur.

## Menambahkan tiket baru

Konfigurasi awal memiliki acceptance T04. Untuk T05 dan seterusnya, agent perlu menulis tes fitur tersebut lalu mendaftarkannya di `harness.json`. Runner sengaja menolak full verification tiket yang belum terdaftar.

Contoh **setelah** script T05 dibuat, tambahkan objek di `checks` dan mapping di `tickets`:

```json
{
  "checks": {
    "t05-browser": {
      "cwd": "frontend",
      "argv": ["bun", "run", "scripts/t05-smoke-check.ts", "--check-only"],
      "timeout": 180
    }
  },
  "tickets": {"T05": ["t05-browser"]}
}
```

Gabungkan dengan konfigurasi yang sudah ada. Script baru harus benar-benar mendukung mode tersebut, menjalankan browser pada build terbaru, gagal dengan exit code bukan nol, dan menyimpan output tanpa mengubah source yang sedang diuji. Untuk P2 tambahkan setup PostgreSQL dan tes API nyata; profil P1 sekarang tidak membuktikan backend atau benchmark T06.

Untuk memulai tiket lain, arsipkan seluruh `.harness/` di luar repo, kemudian jalankan `start` lagi. `.harness/` tidak di-commit dan tidak ikut berpindah otomatis bersama Git branch.

## Batas dan praktik pemakaian

- Full pass berarti perintah terkonfigurasi berhasil pada fingerprint kode tersebut. Review independen tetap menilai cakupan spec, kualitas tes, dan arsitektur.
- Instruksi Markdown memberi arahan; runner menolak hasil gagal/usang saat dipanggil. Ini bukan sandbox atau branch protection: agent masih dapat melewati runner atau mengubah pemeriksaannya. Review perubahan `harness.json`, scripts, dan tes. CI/required checks dapat menjadi lapisan berikutnya.
- Pisahkan implementer dan reviewer dalam konteks berbeda. Model yang lebih kuat dapat dipakai untuk review perubahan state/persistence/recovery; model yang lebih cepat tetap berguna untuk tugas yang sempit dengan tes jelas. Dua putaran review tidak otomatis menandakan model tertentu buruk.
- Ukur hasil pada beberapa tiket: jumlah temuan P1/P2 setelah full pass, berapa kali implementasi diperbaiki, dan waktu/biaya sampai diterima. Tambahkan regresi untuk kesalahan yang berulang.

Rancangan ini mengikuti [verifikasi lokal Google](https://www.antigravity.google/docs/cli/best-practices/) serta pola [pekerjaan bertahap, catatan sesi, dan tes menyeluruh Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents). Keduanya mendukung pendekatan ini; keduanya bukan jaminan model tidak akan salah.
