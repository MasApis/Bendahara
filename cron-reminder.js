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
 * Helper untuk mendapatkan nama Hari, "Bulan Tahun", dan Jam sistem saat ini (WIB).
 */
function getSystemDateTime() {
    const now = new Date();
    
    // Fungsi format khusus untuk zona waktu Jakarta (WIB)
    const formatStr = (opts) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', ...opts }).format(now);
    
    const hariIni = formatStr({ weekday: 'long' }); // ex: "Kamis"
    const bulanIni = formatStr({ month: 'long' }); // ex: "Juni"
    const tahunIni = formatStr({ year: 'numeric' }); // ex: "2026"
    const bulanTahunIni = `${bulanIni} ${tahunIni}`; // ex: "Juni 2026"
    
    // Ambil jam (2 digit) dan paskan menit ke 00 untuk validasi jadwal
    let jam = formatStr({ hour: '2-digit', hour12: false }).replace('.', ':');
    const jamIni = `${jam.split(':')[0]}:00`; // ex: "08:00" atau "20:00"
    
    return { hariIni, bulanTahunIni, jamIni };
}

/**
 * Fungsi utama Backend Cron Reminder (Fase 2: Multi-Bulan, Multi-Grup, Waktu Dinamis)
 */
async function runCronReminder() {
    const { hariIni, bulanTahunIni, jamIni } = getSystemDateTime();
    
    console.log(`\n===================================================================`);
    console.log(`[CRON START] Waktu Server WIB: ${hariIni}, ${bulanTahunIni} | Jam: ${jamIni}`);
    console.log(`===================================================================`);
    
    try {
        const usersRef = db.collection('users'); 
        
        // FASE 2: Validasi Level 1 - Query dinamis ke Map schedulesByMonth berdasarkan bulan saat ini
        const fieldStatus = `schedulesByMonth.${bulanTahunIni}.statusPengaturan`;
        const fieldHari = `schedulesByMonth.${bulanTahunIni}.hariAktif`;

        const snapshot = await usersRef
            .where(fieldStatus, '==', 'aktif')
            .where(fieldHari, 'array-contains', hariIni)
            .get();

        if (snapshot.empty) {
            console.log(`[CRON INFO] Tidak ada jadwal aktif yang ditemukan untuk hari ${hariIni} di bulan ${bulanTahunIni}.`);
            return;
        }

        console.log(`[CRON INFO] Menemukan ${snapshot.size} user potensial. Memulai Validasi Level 2 (Jam Eksekusi)...`);

        // Iterasi setiap user yang lolos filter hari
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const userId = doc.id;
            
            // Ambil jadwal spesifik untuk bulan berjalan
            const configBulanIni = data.schedulesByMonth[bulanTahunIni];

            // FASE 2: Validasi Level 2 - Mencocokkan Jam Eksekusi Bendahara dengan Jam Server
            if (configBulanIni.jamEksekusi !== jamIni) {
                console.log(`[VALIDASI SKIP] User: ${userId} -> Jadwalnya jam ${configBulanIni.jamEksekusi}, bukan jam ${jamIni}`);
                continue; 
            }

            console.log(`\n[VALIDASI LOLOS] Memproses pengiriman pesan untuk User ID: ${userId}`);
            
            const greenApi = data.greenApiConfig;
            if (!greenApi || !greenApi.idInstance || !greenApi.apiTokenInstance) {
                console.warn(`[WARNING] User ${userId} tidak memiliki kredensial Green-API.`);
                continue;
            }

            // FASE 2: Ambil daftar multi-grup (Fallback ke konfigurasi lama jika bendahara belum update)
            let listTargetGrup = greenApi.selectedGroups || [];
            if (listTargetGrup.length === 0 && greenApi.nomorTujuan) {
                listTargetGrup.push({ id: greenApi.nomorTujuan, name: greenApi.namaGrupTerpilih || "Grup Utama" });
            }

            if (listTargetGrup.length === 0) {
                console.warn(`[WARNING] User ${userId} tidak memilih grup target satupun.`);
                continue;
            }

            const templatePesan = configBulanIni.templatePesan || "";

            // --- PROSES LIVE: Eksekusi Blast ke Semua Grup Terpilih ---
            for (const target of listTargetGrup) {
                // 1. Auto-Replace Variabel Dinamis [BULAN] dan [NAMA_GRUP]
                let pesanFinal = templatePesan
                    .replace(/\[BULAN\]/g, bulanTahunIni)
                    .replace(/\[NAMA_GRUP\]/g, target.name);

                // 2. Pembersihan & Validasi String chatId
                let chatId = target.id.trim();
                if (chatId.includes('@g.us')) {
                    chatId = chatId.replace('@c.us', '');
                } else if (!chatId.includes('@')) {
                    chatId = `${chatId}@c.us`;
                }

                const url = `https://api.green-api.com/waInstance${greenApi.idInstance}/sendMessage/${greenApi.apiTokenInstance}`;
                const payload = {
                    chatId: chatId,
                    message: pesanFinal
                };

                console.log(`[SENDING] -> Menembak ke Grup: ${target.name} (${chatId})`);

                try {
                    const response = await axios.post(url, payload, {
                        headers: { 'Content-Type': 'application/json' }
                    });

                    if (response.status === 200 || response.data.idMessage) {
                        console.log(`[LIVE SUCCESS] Pesan terkirim! Message ID: ${response.data.idMessage}`);
                    } else {
                        console.warn(`[WARNING] Respon diterima tetapi ada keanehan struktur data:`, response.data);
                    }
                } catch (apiError) {
                    console.error(`[GREEN-API ERROR] Gagal mengirim ke ${target.name}:`, apiError.message);
                    if (apiError.response) {
                        console.error(`[DETAIL API ERROR]:`, apiError.response.data);
                    }
                }
            }
        }

        console.log(`\n[CRON END] Seluruh proses blast pesan selesai.`);

    } catch (error) {
        console.error(`[CRON CRITICAL ERROR] Terjadi kegagalan sistem pada backend:`, error);
    }
}

// Jalankan fungsi utama
runCronReminder();