import re, glob

# Indonesian function/grammar words that are NEVER valid English words on their own.
# Long/unique enough to avoid false positives.
ID = [
    "dokumen", "dokumentasi", "menjelaskan", "membedah", "mengupas",
    "mendokumentasikan", "katalog", "antarmuka", "fungsinya", "keterangan",
    "daftar", "peran", "implementasi", "limitasi", "rencana", "dampak",
    "batasan", "konsep", "perilaku", "mekanisme", "variabel", "persegi",
    "transport", "pemanggilan", "pemanggil", "terjemahan", "menerjemahkan",
    "dirancang", "dibangun", "dibuat", "diambil", "diterima", "dikirim",
    "disimpan", "ditampilkan", "digunakan", "diperlukan", "disediakan",
    "diterapkan", "diintegrasikan", "dipasang", "dikerjakan", "dipanggil",
    "diproses", "dieksekusi", "di-broadcast", "di-flush", "di-skip",
    "di-cache", "di-set", "diatur", "dibatasi", "dibungkus", "dianggap",
    "dihasilkan", "diciptakan", "didefinisikan", "dideklarasikan",
    "berikutnya", "sebelumnya", "pertama", "kedua", "ketiga", "tersebut",
    "demikian", "berikut", "selanjutnya", "masing-masing", "bersangkutan",
    "digambarkan", "gambarkan", "gambaran", "prinsipnya", "dasarnya",
    "secara", "melalui", "kepada", "terhadap", "bagi", "oleh karena",
    "yaitu", "ialah", "adalah", "merupakan", "berupa", "berdasarkan",
    "seperti", "contoh", "misal", "misalnya", "contohnya", "perhatikan",
    "catatan", "intinya", "singkatnya", "sehingga", "maka", "karena",
    "sebab", "agar", "supaya", "biar", "bila", "jika", "kalau", "ketika",
    "saat", "selama", "hingga", "sampai", "setelah", "sebelum", "lalu",
    "kemudian", "selanjutnya", "akhirnya", "sekarang", "sebelumnya",
    "hari ini", "besok", "kemarin", "pagi", "siang", "sore", "malam",
    "tadi", "baru saja", "sudah", "belum", "masih", "selalu", "pernah",
    "sering", "jarang", "terus", "lagi", "juga", "saja", "hanya",
    "semua", "sebagian", "beberapa", "banyak", "sedikit", "cukup",
    "kurang", "lebih", "paling", "sangat", "amat", "sekali", "banget",
    "sama", "serupa", "lain", "beda", "berbeda", "seperti itu",
    "macam", "jenis", "tipe", "bentuk", "ciri", "aspek", "bagian",
    "elemen", "komponen", "modul", "sistem", "arsitektur", "struktur",
    "kerangka", "algoritma", "metode", "teknik", "prosedur", "proses",
    "langkah", "tahap", "fase", "siklus", "iterasi", "percabangan",
    "pengulangan", "rekursi", "fungsi", "kelas", "objek", "instans",
    "konstanta", "parameter", "argumen", "masukan", "keluaran", "nilai",
    "data", "informasi", "pesan", "sinyal", "kejadian", "pemicu",
    "penangan", "pendengar", "nilai balik", "rentang", "jangkauan",
    "batas", "ambang", "ukuran", "dimensi", "posisi", "lokasi",
    "tempat", "area", "wilayah", "kota", "desa", "hutan", "sungai",
    "danau", "gunung", "bukit", "lembah", "pesisir", "pantai",
    "anggap", "asumsikan", "misalkan", "anda", "kamu", "saya",
    "kita", "kami", "mereka", "dia", "ia", "beliau", "kalian",
    "ini", "itu", "tersebut", "sini", "situ", "sana", "mana",
    "bagaimana", "mengapa", "kenapa", "berapa", "siapa",
    "menggunakan", "memakai", "guna", "pakai", "membuat", "menciptakan",
    "membangun", "mengatur", "mengelola", "memimpin", "mengikuti",
    "menghindari", "menyerang", "melindungi", "menolong", "menyelamatkan",
    "membantu", "menyusun", "menyusahkan", "mencari", "menemukan",
    "kehilangan", "menyimpan", "mengirim", "menerima", "membeli",
    "menjual", "membayar", "mendapat", "memperoleh", "menambah",
    "mengurangi", "menaikkan", "menurunkan", "memperbesar", "memperkecil",
    "menghitung", "membaca", "menulis", "mendengar", "melihat",
    "merasakan", "mencium", "menyentuh", "berbicara", "berkata",
    "mengatakan", "bertanya", "menjawab", "memberi", "mengambil",
    "membawa", "mengantar", "memuat", "memakai", "memilih",
    "mengganti", "menukar", "mengubah", "memodifikasi", "memperbarui",
    "memperbaiki", "memecahkan", "menyelesaikan", "mengatasi",
    "membuka", "menutup", "mengaktifkan", "menonaktifkan", "memulai",
    "menghentikan", "menjeda", "melanjutkan", "mengulang", "menguji",
    "mengujikan", "menguji", "memverifikasi", "memvalidasi", "mengecek",
    "memeriksa", "memonitor", "mengawasi", "mengamati", "menganalisis",
    "mengevaluasi", "mengoptimalkan", "meningkatkan", "mempercepat",
    "memperlambat", "menangguhkan", "menunda", "memperpanjang",
    "memperdalam", "memperluas", "menyempitkan", "memfokuskan",
    "memperjelas", "memperinci", "merangkum", "menyimpulkan",
    "menyebutkan", "mengulas", "membahas", "menjelaskan", "menguraikan",
    "mendeskripsikan", "menggambarkan", "mengilustrasikan",
    "menunjukkan", "menampilkan", "memperlihatkan", "menyajikan",
    "mempresentasikan", "melaporkan", "mencatat", "membukukan",
    "mengarsipkan", "menyimpan", "membackup", "memulihkan",
    "mengembalikan", "menghapus", "membuang", "membersihkan",
    "menyiapkan", "menginstal", "memasang", "mengonfigurasi",
    "menyetel", "mengatur", "mengeset", "mengkalibrasi",
    "bukan", "tidak", "jangan", "belum", "tak",
    "wajib", "harus", "perlu", "bisa", "dapat", "boleh", "mau",
    "ingin", "suka", "senang", "baik", "buruk", "bagus", "jelek",
    "benar", "salah", "tepat", "keliru", "cepat", "lambat",
    "besar", "kecil", "panjang", "pendek", "tinggi", "rendah",
    "tebal", "tipis", "berat", "ringan", "panas", "dingin",
    "kuat", "lemah", "keras", "lunak", "baru", "lama", "muda", "tua",
    "hidup", "mati", "sehat", "sakit", "aman", "bahaya", "rusak",
    "baik", "jelek", "indah", "cantik", "tampan", "buruk",
    "senang", "sedih", "marah", "kesal", "takut", "berani",
    "tenang", "semangat", "malu", "bangga", "sombong", "ramah",
    "kejam", "adil", "jujur", "setia", "rajin", "malas",
    "pintar", "bodoh", "pandai", "sabar", "teliti", "ceroboh",
    "umum", "khusus", "umumnya", "biasanya", "seringnya", "kadang",
    "terkadang", "barangkali", "mungkin", "pasti", "tentu",
    "selalu", "tidak pernah", "tidak akan", "tidak bisa",
    "akan", "telah", "sudah", "sedang", "berupa", "yaitu",
]

PAT = re.compile(r"\b(" + "|".join(re.escape(w) for w in ID if len(w) > 2) + r")\b", re.I)

hits = []
for path in sorted(glob.glob("*.md")):
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        continue
    for m in PAT.finditer(text):
        line = text[:m.start()].count("\n") + 1
        hits.append((path, line, m.group(1)))

print(f"TOTAL HITS: {len(hits)}")
for path, line, word in hits[:60]:
    print(f"{path}:{line}: {word}")
