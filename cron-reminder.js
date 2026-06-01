import admin from 'firebase-admin';
import axios from 'axios';
import { createRequire } from 'module';

// Membuat fungsi require manual agar fallback ke file JSON lokal tetap aman di mode ESM
const requireManual = createRequire(import.meta.url);

// Mengambil service account dari environment variable yang disuntikkan GitHub Actions
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : requireManual('./path-to-local-serviceAccountKey.json'); // fallback untuk lokal testing

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

/**
 * Helper untuk mendapatkan nama hari (Indonesia) dan format "Bulan Tahun" saat ini.
 */
function getSystemDateTime() {
    const opsiHari = { weekday: 'long' };
    const opsiBulanTahun = { month: 'long', year: 'numeric' };
    
    // Menggunakan locale 'id-ID' agar menghasilkan "Senin", "Juni 2026", dll.
    const hariIni = new Intl.DateTimeFormat('id-ID', opsiHari).format(new Date());
    const bulanTahunIni = new Intl.DateTimeFormat('id-ID', opsiBulanTahun).format(new Date());
    
    return { hariIni, bulanTahunIni };
}

/**
 * Fungsi utama Backend Cron Reminder
 */
async function runCronReminder() {
    const { hariIni, bulanTahunIni } = getSystemDateTime();
    console.log(`[CRON START] Menjalankan sistem pengingat untuk: ${hariIni}, ${bulanTahunIni}`);
    
    try {
        // FASE 2: Validasi Level 1 - Query Firestore menggunakan array-contains & status aktif
        const usersRef = db.collection('users'); // Sesuaikan dengan nama koleksi Anda
        const snapshot = await usersRef
            .where('configJadwal.statusPengaturan', '==', 'aktif')
            .where('configJadwal.hariAktif', 'array-contains', hariIni)
            .get();

        if (snapshot.empty) {
            console.log(`[CRON INFO] Tidak ada jadwal aktif yang ditemukan untuk hari ${hariIni}.`);
            return;
        }

        console.log(`[CRON INFO] Menemukan ${snapshot.size} potensi kecocokan jadwal hari ini. Memulai Validasi Level 2...`);

        // Iterasi setiap user/grup yang lolos filter hariAktif
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const config = data.configJadwal;
            const userId = doc.id;

            // FASE 2: Validasi Level 2 - Mencocokkan string bulanTarget dengan kalender sistem
            if (config.bulanTarget !== bulanTahunIni) {
                console.warn(`[VALIDASI GAGAL] User: ${userId} dilewati. bulanTarget (${config.bulanTarget}) tidak sesuai dengan sistem saat ini (${bulanTahunIni}). Perlu reset state di frontend!`);
                continue; 
            }

            // --- PROSES LANJUTAN: Eksekusi pengiriman via Green-API jika lolos kedua validasi ---
            console.log(`[VALIDASI LOLOS] Memproses pengiriman pengingat untuk User ID: ${userId}`);
            
            // Contoh payload pesan menggabungkan header dan footer baru
            // --- PROSES LANJUTAN: Eksekusi pengiriman via Green-API jika lolos kedua validasi ---
            console.log(`[VALIDASI LOLOS] Memproses pengiriman pengingat untuk User ID: ${userId}`);
            
            // Menggabungkan template pesan baru (Fase 1) dengan rapi
            const pesanKonten = `${config.headerPesan}\n\n${config.footerPesan}`;
            
            try {
                const { idInstance, apiTokenInstance, nomorTujuan } = data.greenApiConfig;
                
                // Validasi format chatId: Jika mengandung "@us.c", berarti itu ID grup, 
                // jika hanya angka, kita format sebagai nomor personal (@c.us)
                const chatId = nomorTujuan.includes('@us.c') 
                    ? nomorTujuan 
                    : `${nomorTujuan}@c.us`;

                const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiTokenInstance}`;
                const payload = {
                    chatId: chatId,
                    message: pesanKonten
                };

                // Untuk keperluan SIMULASI (Dry-Run), baris axios di-comment dulu.
                // Jika sudah siap live, cukup hapus tanda comment (//) di bawah ini:
                // await axios.post(url, payload); 

                console.log(`[DRY-RUN SUCCESS] Payload siap dikirim ke ${chatId}`);
                console.log(`[ISI PESAN]:\n---------\n${pesanKonten}\n---------`);
                
            } catch (apiError) {
                console.error(`[GREEN-API ERROR] Gagal memproses data untuk User: ${userId}:`, apiError.message);
            }
        }

        console.log(`[CRON END] Seluruh proses pengkondisian jadwal selesai.`);

    } catch (error) {
        console.error(`[CRON CRITICAL ERROR] Terjadi kegagalan sistem pada backend:`, error);
    }
}

// Jalankan fungsi utama
runCronReminder();