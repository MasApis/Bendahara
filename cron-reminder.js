import admin from 'firebase-admin';
import axios from 'axios';

// 1. Inisialisasi Firebase Admin menggunakan Server-to-Server Secret dari GitHub Environment
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function jalankanPengingatKas() {
    // Array hari untuk mencocokkan waktu UTC/WIB
    const daftarHari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
    const hariIni = daftarHari[new Date().getDay()];
    
    console.log(`[LOG] Memulai pengecekan otomatisasi untuk hari: ${hariIni}`);

    try {
        // Query organisasi yang jadwal pengingatnya jatuh pada HARI INI dan status botnya AKTIF
        const snapshot = await db.collection('organizations')
            .where('jadwalPengingat.hari', '==', hariIni)
            .where('jadwalPengingat.status', '==', 'aktif')
            .get();

        if (snapshot.empty) {
            console.log('[LOG] Tidak ada jadwal pengingat kas yang aktif untuk hari ini.');
            return;
        }

        // Loop jika ada organisasi yang jadwalnya pas hari ini
        for (const doc of snapshot.docs) {
            const orgData = doc.data();
            const orgId = doc.id;
            
            console.log(`[LOG] Memproses pengingat untuk: ${orgData.namaOrganisasi}`);

            // Ambil daftar nama anggota secara dinamis dari sub-koleksi 'members'
            const membersSnapshot = await db.collection('organizations').doc(orgId).collection('members').get();
            let teksDaftarAnggota = "\n\n*Daftar Anggota Terdaftar:*";
            
            membersSnapshot.forEach(memberDoc => {
                teksDaftarAnggota += `\n- ${memberDoc.data().namaAnggota}`;
            });

            // Gabungkan Template Pesan dari Bendahara + Daftar Anggota
            const pesanFinal = `${orgData.templatePesan}${teksDaftarAnggota}`;

            // Ambil variabel rahasia dari GitHub Environment
            const idInstance = process.env.GREEN_API_INSTANCE_ID;
            const apiToken = process.env.GREEN_API_API_TOKEN;
            const chatId = process.env.GREEN_API_CHAT_ID; 

            // 2. Tembak API Green-API untuk mengirimkan pesan langsung ke grup WA
            const urlGreenApi = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiToken}`;
            
            await axios.post(urlGreenApi, {
                chatId: chatId,
                message: pesanFinal
            });

            console.log(`[SUKSES] Pesan berhasil dikirim ke grup untuk ${orgData.namaOrganisasi}!`);
        }

    } catch (error) {
        console.error("[ERROR] Terjadi kegagalan pada sistem:", error.message);
    }
}

jalankanPengingatKas();