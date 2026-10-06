import re, glob, sys

VOCAB = """
beranda kembali mulai selesai berikutnya sebelumnya tutup buka cari simpan batal
hapus tambah detail peringatan kesalahan gagal berhasil memuat lokasi peta dunia
pemain petualangan misi tantangan hadiah imbalan dompet pengaturan bantuan panduan
tentang bahasa indonesia inggris selamat halo kabar bagaimana siapa kapan dimana
kenapa mengapa berapa kota desa hutan gunung sungai danau pulau markas toko pasar
kandang lumbung pelabuhan rumah jalan warga penduduk serigala kambing domba ayam
sapi kuda anjing kucing tikus burung ular bebek kelinci monyet beruang rusa gajah
jerapah zebra bagus buruk besar kecil panas dingin cepat lambat kuat lemah tinggi
rendah tebal tipis berat ringan gelap terang bersih kotor aman bahaya susah mudah
baru lama muda tua hidup mati sehat sakit senang sedih marah takut tenang sibuk
santai bertani menanam panen membeli menjual membayar mendapat mengambil
meninggalkan tiba berangkat pergi datang duduk berdiri berjalan berlari tidur
bangun makan minum bicara mendengar melihat menulis membaca bermain bekerja
istirahat menunggu memanggil menjawab membantu mengajarkan belajar mengirim
menerima membawa meletakkan membuka menutup memasak mencuci membersihkan
memperbaiki membangun menghancurkan membuat menghapus memilih memutus menyetujui
menolak memberi membagikan mengumpulkan menemukan menghitung mengukur menimbang
memotong menjahit merajut menenun melukis menyanyi menari bertanya bercerita
menggambar mewarnai menyusun mengatur menyiapkan memasang mencabut menyiram
memupuk sampah kotoran lumpur pasir kayu daun ranting akar bunga rumput biji
buah sayur umbi beras gandum jagung kacang kentang tomat wortel bawang cabai lada
garam gula minyak susu telur daging ikan udang kepiting cumi gurita kerang tiram
lautan ombak angin hujan salju hangat sejuk lembab kering basah berawan cerah
mendung badai petir kilat pelangi matahari bulan bintang langit awan embun kabut
asap debu tanah batuan bukit lembah jurang samudra negeri negara kampung
jembatan alun gubuk sekolah pabrik gudang dermaga stasiun bandara kantor kafe
restoran warung kantin klub bengkel salon hotel penginapan villa kabin tenda pohon
semak duri bambu kelapa pisang mangga jambu durian rambutan salak apel pir anggur
melon semangka pepaya nanas tebu kopi coklat cengkeh vanila karet melati mawar
anggrek kamboja kupu lebah semut nyamuk capung belalang cacing lipan kalajengking
kecoa tawon madu sarang induk betina jantan panda koala kanguru singa macan
jaguar kerbau unta babi landak gorila simpanse orangutan babon kalkun merpati
puyuh elang perkutut murai kacer pleci kenari walet kuntul bangau camar gagak
beo nuri bayan dara untung rugi modal gaji upah komisi murah harga biaya ongkir
pajak hasil nasabah rekening saham obligasi dompet koper kardus peti lemari meja
kursi sofa kasur bantal selimut guling kipas kompor blender mixer kulkas mesin
setrika sapu lap kain handuk sabun sikat gigi lantai dinding atap pintu jendela
kaca cermin gorden tirai karpet keset tikar semen bata genteng logam besi baja
tembaga emas perak kuningan perunggu timah seng plastik kertas liat kerikil kuas
paku obeng palu gergaji bor gunting cangkul sabit garpu ember gayung selang
kaleng kantong kresek kemasan bungkus merek stempel stiker buku pulpen pensil
spidol klip lakban lem perekat tinta printer laptop monitor kabel charger
baterai lampu bohlam senter lilin korek asbak pemantik listrik saluran kran pipa
kloset kamar mandi toilet dapur ruang tamu tidur balkon teras pagar gerbang
tangga plafon makmur sejahtera sakti jaya sentosa damai rahayu bahagia panjang
umur semoga tepat waktu telah akan sedang masih saja juga hanya sangat terlalu
paling lebih kurang agak sedikit banyak sekali kali ini itu sini situ mana yang
dan atau tetapi tapi karena jika kalau supaya agar agar bisa dapat boleh mau
ingin harus wajib perlu mungkin barangkali mungkin tentu pasti sudah belum
selalu sering kadang jarang pernah tidak bukan ya kenapa kok sih dong deh
lhoh kan aja doang sih ya gimana tolong bantu kasih lihat dengar coba cek
cek perhatian tanda tanya seru titik koma dua satu tiga empat lima enam tujuh
delapan sembilan sepuluh nol pertama kedua ketiga keempat kelima keenam ketujuh
kedelapan kesembilan kesepuluh sekarang kemarin besok lusa hari ini kemarin
besok besok pagi siang sore malam dini hari musim semi panas gugur dingin hujan
kemarau banjir kebakaran gempa gunung meletus tsunami angin topan badai
petir kilat pelangi gerhana siang hari matahari bulan bintang planet bumi
bulan sabit purnama gerhana gerhana gerhana
""".split()

# remove empties and dedupe
VOCAB = [w for w in VOCAB if w]
# drop words that are common English substrings too
BAD_ENGLISH = {"air","api","tanah","daun","biji","bisa","mana","dan","atau","itu","ini","saya","kamu","dia","mereka","kami","kita","ada","tidak","bukan","sudah","belum","juga","saja","hanya","sangat","paling","lebih","kurang","agak","sedikit","banyak","sekali","kali","yang","tersebut","demikian","begini","begitu","begitulah","beginilah","seperti","ibarat","laksana","bagai","seolah","andai","kalau","jika","bila","bilamana","asal","asalkan","selama","selaginya","sedangkan","padahal","namun","tetapi","tapi","melainkan","karena","sebab","oleh","karena","sehingga","maka","maka","supaya","agar","biar","biarpun","walaupun","meskipun","kendatipun","padahal","sementara","sementara","itu","tadi","tadi","baru","lama","muda","tua","besar","kecil","panjang","pendek","tinggi","rendah","tebal","tipis","berat","ringan","luas","sempit","dalam","dangkal","jauh","dekat","cepat","lambat","kuat","lemah","keras","lunak","panas","dingin","hangat","sejuk","manis","pahit","asam","asin","pedas","gurih","bau","wangi","indah","cantik","ganteng","tampan","jelek","buruk","baik","bagus","benar","salah","tepat"," keliru","rajin","malas","pintar","bodoh","pandai","pemalas","penyabar","sabar","teliti","ceroboh","hati-hati","tenang","bersemangat","semangat","antusias","malu","bangga","rendah hati","sombong","angkuh"," ramah","bersahabat","kejam","baik hati","jahat","adil","jujur","dusta","pembohong","setia","khianat","berani","penakut","taksuka","suka","cinta","kasih","sayang","benci","marah","kesal","muak","jengkel","kesal","sedih","duka","derita","sakit","perih","nyeri","enak","nikmat","senang","gembira","riang","ceria","bahagia","damai","tenang","kacau","ramai","sepi","sunyi","bising","teriak","berteriak","memanggil","menyapa","menjawab","berbicara","berkata","bertanya","berkisah","menceritakan","mendengar","menyimak","melihat","memandang","mengamati","mengintip","menatap","membaca","menulis","menggambar","melukis","mewarnai","menyanyi","bernyanyi","menari","berdansa","bermain","bertanding","berlomba","berolahraga","bekerja","berkarya","bertani","berkebun","memancing","berburu","berdagang","belanja","membeli","menjual","menukar","meminjam","meminjamkan","menabung","menyimpan","mengambil","mengembalikan","memberi","membagikan","menghadiahkan","menerima","memperoleh","mendapatkan","memperhatikan","mengikuti","menemani","membimbing","memimpin","mengawasi","menjaga","melindungi","membela","mendukung","membantu","menolong","menyembuhkan","merawat","memelihara","menyayangi","menyayangi"}
VOCAB = [w for w in VOCAB if w not in BAD_ENGLISH]

# word-boundary, case-insensitive
PAT = re.compile(r"\b(" + "|".join(sorted(set(VOCAB), key=len, reverse=True)) + r")\b", re.IGNORECASE)

paths = []
for base in ("frontend/src", "backend/src", "mcp/src", "shared/src", "api"):
    for ext in ("*.ts", "*.tsx"):
        paths += glob.glob(base + "/**/" + ext, recursive=True)
    paths += glob.glob(base + "/" + ext)

JSX = re.compile(r">([^<>{}]+)<")
STR = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"')
for p in sorted(set(paths)):
    if "node_modules" in p:
        continue
    try:
        lines = open(p, encoding="utf-8").read().split("\n")
    except Exception:
        continue
    for i, ln in enumerate(lines, 1):
        for m in JSX.finditer(ln):
            t = m.group(1).strip()
            if t and not t.startswith("(") and not t.startswith("{"):
                print(f"{p}:{i}: JSX {t!r}")
        for m in STR.finditer(ln):
            t = m.group(1)
            if " " in t and re.search(r"[A-Za-z]", t) and len(t) > 6:
                print(f"{p}:{i}: STR {t!r}")

