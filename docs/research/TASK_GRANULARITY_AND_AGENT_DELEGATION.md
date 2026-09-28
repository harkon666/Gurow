# Granularitas pekerjaan untuk delegasi agent

Tanggal riset: 28 September 2026. Catatan ini adalah rekomendasi proses, bukan perubahan spesifikasi, status tiket, atau keputusan arsitektur.

## Kesimpulan

Istilah yang paling sesuai adalah **task decomposition / task granularity**: memecah tujuan besar menjadi pekerjaan yang batas, dependensi, dan keberhasilannya dapat diperiksa. Penamaan **L1 product spec → L2 feature/slice spec → L3 executable task** berguna sebagai konvensi lokal. Riset ini tidak menemukan standar universal yang menetapkan ketiga nomor itu atau menjamin bahwa L3 otomatis cocok untuk model Flash.

Rekomendasi: planner yang kuat menyelesaikan ketidakjelasan dan keputusan arsitektur; executor cepat mengerjakan paket terbatas; reviewer independen memeriksa perilaku dan bukti. Graphify membantu memilih konteks sumber yang relevan. Ia tidak menggantikan kontrak task atau pengujian.

## Tiga hal yang perlu dibedakan

| Dimensi | Contoh | Makna |
| --- | --- | --- |
| Besar pekerjaan | Product/epic → feature/vertical slice → executable task | Cakupan yang didelegasikan; nomor L1–L3 adalah pilihan tim. |
| Tahapan pengerjaan | Requirements → design → tasks | Kiro memakai tiga artefak untuk satu spec: kebutuhan, rancangan, dan rencana implementasi. Ini bukan tiga ukuran spec. |
| Peran spec sepanjang waktu | Spec-first → spec-anchored → spec-as-source | Taksonomi Birgitta Böckeler: spec mendahului implementasi; dipelihara untuk evolusi; atau menjadi sumber utama sementara manusia tidak mengedit kode. Ini bukan ukuran task atau kelas model. |

Sumber: [dokumentasi Kiro](https://kiro.dev/docs/specs/) dan [taksonomi asli Böckeler](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html). Istilah tingkat rigor tersebut merupakan kategorisasi penulis, bukan standar formal.

## Temuan dari sumber primer

**GitHub Spec Kit.** Template task menggunakan ID, penanda story, path file yang tepat, serta dependensi. Task dikelompokkan menurut story agar hasil story bisa diuji dan diserahkan mandiri. Penanda paralel berarti file berbeda dan tanpa dependensi; template memperingatkan tentang task kabur dan konflik file. Jadi task kecil tetap harus terhubung ke perilaku yang dapat dibuktikan. Template menjadikan test opsional bila spec tidak meminta; Gurow memiliki aturan lokal lebih ketat, sehingga bagian opsional itu tidak diadopsi. [Template resmi](https://github.com/github/spec-kit/blob/main/templates/tasks-template.md).

**Kiro.** Dokumentasinya menyarankan spec terpisah per feature agar tetap terfokus. Requirements-First cocok ketika perilaku sudah diketahui; Design-First relevan ketika ada batas teknis atau persyaratan nonfungsional ketat. Eksekusi paralel mengikuti dependensi. Ini mendukung pemecahan berdasarkan hasil dan urutan kerja, bukan sekadar jumlah file. [Best practices resmi](https://kiro.dev/docs/specs/best-practices/).

**Anthropic.** Eksperimen harness menggunakan agent inisialisasi dan agent implementasi yang maju secara bertahap, satu feature per giliran, dengan artefak untuk melanjutkan sesi serta verifikasi. Pekerjaan lanjut mengeksplorasi pemisahan planner, generator, dan evaluator. Ini bukti praktik harness dari lingkungan mereka, bukan benchmark yang membuktikan model cepat tertentu memadai bagi Gurow. [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Rekomendasi paket L3

Satu paket sebaiknya memuat:

1. Tiket induk, AC yang dilayani, commit dasar, dan dependensi yang sudah selesai.
2. Satu hasil yang dapat diamati; perilaku sebelum/sesudah dan kasus gagal.
3. Batas perubahan, titik integrasi, kontrak yang telah diputuskan, serta hal di luar scope.
4. Path/simbol relevan, ADR yang berlaku, dan referensi contoh implementasi.
5. Perintah pengujian serta assertion yang akan gagal bila perilaku rusak; bukti yang perlu diserahkan.
6. Kondisi berhenti: konflik kontrak, keputusan arsitektur baru, atau kegagalan berulang yang membutuhkan eskalasi.

Ukuran ideal tidak perlu ditetapkan sebagai jumlah baris atau file. Pertanyaan praktisnya: **apakah executor dapat mengerjakan dan membuktikan satu hasil tanpa menciptakan keputusan produk/arsitektur baru?** Task yang hanya berbunyi “buat tabel”, “buat endpoint”, atau “buat komponen” belum cukup bila hubungan dengan perilaku dan kontraknya tidak jelas. Subtask teknis tetap sah ketika batas integrasinya telah ditetapkan dan tiket induknya tetap memiliki validasi menyeluruh.

Task yang cocok untuk pilot executor cepat: menambah skenario uji terhadap kontrak mapan, mengimplementasikan satu perilaku lokal dengan seam yang sudah ada, atau memperbaiki regresi dengan reproduksi yang sudah dipersempit. Diagnosis performa lintas Rust/Wasm/browser, perubahan ownership, serta keputusan autentikasi/otorisasi memerlukan planner atau reviewer yang lebih kuat terlebih dahulu. Ini rekomendasi berdasarkan ketidakpastian dan dampak, bukan klaim bahwa suatu model selalu mampu/tidak mampu.

Pertahankan [harness Gurow](../agents/harness.md): pin tiket/base sekali, petakan semua AC ke assertion observable, jalankan full checks pada sumber terkini, lalu review independen. Setelah dua siklus koreksi gagal atau persoalan arsitektur belum selesai, eskalasikan dengan reproduksi dan log. Kelulusan satu subtask tidak menutup AC tiket induk yang belum dibuktikan.

## Peran Graphify

Rekomendasi alur: **tiket dan AC terkini → query graph → baca sumber asli → susun paket L3 → implementasi → uji dan review → perbarui indeks**.

Graph dapat membantu menemukan simbol, dokumen, hubungan antarmodul, dan kandidat dampak perubahan. Sertakan potongan relevan beserta asal file dan identitas revisinya; hindari memasukkan seluruh graph ke prompt. Relasi hasil ekstraksi merupakan petunjuk yang harus diperiksa pada kode/dokumen asal, terutama bila snapshot tertinggal atau relasi tidak terselesaikan.

Status issue, dependensi kerja, dan gate yang lulus harus berasal dari tracker serta bukti eksekusi yang sesuai revisi. Jangan menganggap edge graph sebagai bukti bahwa sebuah test melindungi AC atau gate performa sudah lolos. Jangan pula menyamakan dependency graph task dengan knowledge graph kode: edge task menentukan urutan eksekusi yang disepakati, sementara edge kode membantu investigasi.

## Pilot yang disarankan

Dalam konvensi lokal yang diusulkan, [issue #1](https://github.com/harkon666/Gurow/issues/1) berisi 85 user story dan dapat disebut L1/product spec. Sebanyak 32 tiket turunannya (#2–#33) sudah berupa vertical slice atau gate; ini paling dekat dengan L2, bukan sekadar judul feature yang belum dibatasi. L3 dapat berupa paket pelaksanaan di bawah tiket itu, sehingga tidak perlu membuat sistem spec kedua yang menduplikasi tracker. Penilaian ini memakai pemeriksaan tracker pada sesi riset ini.

Pilih satu tiket berikutnya yang benar-benar siap. Planner menulis beberapa paket kecil setelah membaca implementasi dan bukti terkini; reviewer memeriksa kualitas paket sebelum delegasi. Jalankan beberapa paket dengan executor cepat, lalu ukur biaya total, waktu hingga diterima, jumlah perbaikan, dan cacat yang ditemukan review. Gunakan hasil itu untuk menyesuaikan ukuran task dan pemilihan model. Jangan memecah seluruh backlog menjadi puluhan detail implementasi jauh hari ketika desainnya masih dapat berubah.

Untuk Gurow, kandidat pembahasan adalah [issue #7](https://github.com/harkon666/Gurow/issues/7), gate responsivitas P1: fixture 1.000 card, sekitar 200 terlihat, 2.000 koneksi, p95 frame ≤20 ms dan input-to-visible ≤50 ms. Setelah planner menetapkan kontrak pengukuran, executor cepat dapat mengerjakan fixture deterministik atau format laporan beserta validasinya. Penentuan metode ukur, diagnosis bottleneck, dan keputusan kelulusan gate tetap memerlukan pemeriksaan tersendiri. Pada pemeriksaan sesi ini, #7 terbuka dan blocker #6 sudah tertutup; [#8](https://github.com/harkon666/Gurow/issues/8) masih bergantung pada #7. Ini snapshot tracker, bukan status permanen.

Pemeriksaan [harness.json](../../harness.json) pada sesi ini menemukan registrasi acceptance T04 dan T05, belum T06 untuk #7. Karena itu rencana #7 perlu mencakup registrasi pemeriksaannya dan bukti semua AC; kelulusan pemeriksaan tiket terdahulu tidak membuktikan gate ini.

Catatan ini tidak mengubah issue, label, implementasi, harness state, maupun brain. Tidak ada test runtime atau benchmark model dijalankan karena pengguna meminta riset dan pembahasan sebelum implementasi; perubahan hanya berupa hasil riset.
