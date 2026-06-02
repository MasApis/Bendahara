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
// GANTI FUNGSI INI SECARA UTUH:
function getSystemDateTime() {
    const now = new Date();
    const formatStr = (opts) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', ...opts }).format(now);
    
    const hariIni = formatStr({ weekday: 'long' }); 
    const bulanIni = formatStr({ month: 'long' }); 
    const tahunIni = formatStr({ year: 'numeric' }); 
    const bulanTahunIni = `${bulanIni} ${tahunIni}`; 
    
    // Ambil tanggal format standar ISO Jakarta (ex: 2026-06-02) untuk pengunci status blast
    const tanggalIni = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); 
    
    return { hariIni, bulanTahunIni, tanggalIni };
}
/**
 * Fungsi utama Backend Cron Reminder (Fase 2: Multi-Bulan, Multi-Grup, Waktu Dinamis)
 */
// CARI DI DALAM RUNCRONREMINDER(), GANTI PROSES LOOPING USER MENJADI SEPERTI INI:
async function runCronReminder() {
    const { hariIni, bulanTahunIni, tanggalIni } = getSystemDateTime();
    
    console.log(`\n===================================================================`);
    console.log(`[CRON START] Waktu Server WIB: ${hariIni}, ${bulanTahunIni} | Tanggal: ${tanggalIni}`);
    console.log(`===================================================================`);
    
    try {
        const usersRef = db.collection('users'); 
        
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

        console.log(`[CRON INFO] Menemukan ${snapshot.size} user potensial. Memulai Validasi Level 2 (Tanggal Eksekusi)...`);

        for (const doc of snapshot.docs) {
            const data = doc.data();
            const userId = doc.id;
            const configBulanIni = data.schedulesByMonth[bulanTahunIni];

            // VALIDASI LEVEL 2: Cek apakah hari ini user tersebut sudah sukses dikirimi blast
            if (configBulanIni.lastExecutionDate === tanggalIni) {
                console.log(`[VALIDASI SKIP] User: ${userId} -> Hari ${hariIni} ini sudah sukses dieksekusi sebelumnya.`);
                continue; 
            }

            console.log(`\n[VALIDASI LOLOS] Memproses pengiriman pesan untuk User ID: ${userId}`);
            
            const greenApi = data.greenApiConfig;
            if (!greenApi || !greenApi.idInstance || !greenApi.apiTokenInstance) {
                console.warn(`[WARNING] User ${userId} tidak memiliki kredensial Green-API.`);
                continue;
            }

            let listTargetGrup = greenApi.selectedGroups || [];
            if (listTargetGrup.length === 0 && greenApi.nomorTujuan) {
                listTargetGrup.push({ id: greenApi.nomorTujuan, name: greenApi.namaGrupTerpilih || "Grup Utama" });
            }

            if (listTargetGrup.length === 0) {
                console.warn(`[WARNING] User ${userId} tidak memilih grup target satupun.`);
                continue;
            }

            const templatePesan = configBulanIni.templatePesan || "";
            let semuaGrupSukses = true;

            // --- PROSES LIVE: Eksekusi Blast ---
            for (const target of listTargetGrup) {
                let pesanFinal = templatePesan
                    .replace(/\[BULAN\]/g, bulanTahunIni)
                    .replace(/\[NAMA_GRUP\]/g, target.name);

                let chatId = target.id.trim();
                if (chatId.includes('@g.us')) {
                    chatId = chatId.replace('@c.us', '');
                } else if (!chatId.includes('@')) {
                    chatId = `${chatId}@c.us`;
                }

                const url = `https://api.green-api.com/waInstance${greenApi.idInstance}/sendMessage/${greenApi.apiTokenInstance}`;
                const payload = { chatId: chatId, message: pesanFinal };

                console.log(`[SENDING] -> Menembak ke Grup: ${target.name} (${chatId})`);

                try {
                    const response = await axios.post(url, payload, {
                        headers: { 'Content-Type': 'application/json' }
                    });

                    if (response.status === 200 || response.data.idMessage) {
                        console.log(`[LIVE SUCCESS] Pesan terkirim! Message ID: ${response.data.idMessage}`);
                    }
                } catch (apiError) {
                    semuaGrupSukses = false;
                    console.error(`[GREEN-API ERROR] Gagal mengirim ke ${target.name}:`, apiError.message);
                }
            }

            // JIKA SEMUA GRUP SUKSES DITEMBAK, KUNCI TANGGALNYA DI FIRESTORE USER
            if (semuaGrupSukses) {
                const userDocRef = db.collection('users').doc(userId);
                await userDocRef.update({
                    [`schedulesByMonth.${bulanTahunIni}.lastExecutionDate`]: tanggalIni
                });
                console.log(`[FIRESTORE LOCKED] Status sukses hari ini dikunci untuk user ${userId}`);
            }
        }

        console.log(`\n[CRON END] Seluruh proses blast pesan selesai.`);
    } catch (error) {
        console.error(`[CRON CRITICAL ERROR] Terjadi kegagalan sistem pada backend:`, error);
    }
}

// Jalankan fungsi utama
runCronReminder();