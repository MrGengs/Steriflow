// ============================================================
//  SteriFlow — Bilingual (ID / EN) Manager
//
//  Cara pakai di HTML:
//    <span data-i18n="nav.home">Home</span>
//    <input data-i18n-placeholder="auth.email_ph" placeholder="Email" />
//    <button data-i18n-title="common.refresh" title="Refresh"></button>
//    <span data-i18n="hero.title" data-i18n-html>Smart <b>Sterilization</b></span>
//
//  Toggle:
//    <button data-lang-toggle></button>
//    <input type="checkbox" id="langToggle"> (checked = EN)
//    <button data-lang-set="id">ID</button>
//    <button data-lang-set="en">EN</button>
//
//  JS:
//    SteriflowI18n.t('nav.home')       // string sesuai bahasa aktif
//    SteriflowI18n.setLang('en')
//    window.addEventListener('language:change', e => console.log(e.detail.lang));
// ============================================================

(function() {
  'use strict';

  const STORAGE_KEY = 'steriflow-lang';
  const DEFAULT_LANG = 'id';

  const DICT = {
    // ──────────── COMMON / NAV ────────────
    'nav.home':        { id: 'Beranda',   en: 'Home' },
    'nav.monitor':     { id: 'Monitor',   en: 'Monitor' },
    'nav.ai':          { id: 'Deteksi AI', en: 'AI Detection' },
    'nav.history':     { id: 'Riwayat',   en: 'History' },
    'nav.account':     { id: 'Akun',      en: 'Account' },
    'nav.login_register': { id: 'Masuk / Daftar', en: 'Login / Register' },

    'common.live':       { id: 'LIVE',      en: 'LIVE' },
    'common.loading':    { id: 'Memuat…',    en: 'Loading…' },
    'common.refresh':    { id: 'Segarkan',  en: 'Refresh' },
    'common.notifications': { id: 'Notifikasi', en: 'Notifications' },
    'common.last_updated':  { id: 'Diperbarui:', en: 'Last updated:' },
    'common.just_now':   { id: 'baru saja', en: 'just now' },
    'common.device':     { id: 'Perangkat', en: 'Device' },
    'common.status':     { id: 'Status',    en: 'Status' },
    'common.close':      { id: 'Tutup',     en: 'Close' },
    'common.cancel':     { id: 'Batal',     en: 'Cancel' },
    'common.save':       { id: 'Simpan',    en: 'Save' },
    'common.stop':       { id: 'Stop',      en: 'Stop' },
    'common.start':      { id: 'Mulai',     en: 'Start' },
    'common.skip':       { id: 'Lewati',    en: 'Skip' },
    'common.ok':         { id: 'OK',        en: 'OK' },

    // ──────────── LANDING PAGE ────────────
    'landing.meta.title':       { id: 'SteriFlow — Sterilisasi Cerdas Berbasis IoT', en: 'SteriFlow — IoT-Based Smart Sterilization' },
    'landing.nav.home':         { id: 'Beranda',    en: 'Home' },
    'landing.nav.how':          { id: 'Cara Kerja', en: 'How It Works' },
    'landing.nav.features':     { id: 'Fitur',       en: 'Features' },
    'landing.nav.team':         { id: 'Tim Kami',    en: 'Our Team' },
    'landing.nav.contact':      { id: 'Kontak',      en: 'Contact' },
    'landing.nav.cta':          { id: 'Masuk / Daftar', en: 'Login / Register' },

    'landing.hero.badge.ai':       { id: 'Didukung AI',   en: 'AI Powered' },
    'landing.hero.badge.realtime': { id: 'Real-time',     en: 'Real-time' },
    'landing.hero.badge.iot':      { id: 'Terhubung IoT', en: 'IoT Connected' },

    'landing.hero.heading_line1':  { id: 'Sterilisasi Cerdas,', en: 'Smart Sterilization,' },
    'landing.hero.heading_line2':  { id: 'Berbasis IoT',        en: 'IoT-Based' },
    'landing.hero.subtitle': {
      id: 'Sistem sterilisasi otomatis untuk ompreng stainless. Deteksi kontaminasi berbasis AI, UV-C, dan semprot ethanol dalam satu alat cerdas.',
      en: 'Automated sterilization system for stainless serving trays (ompreng). AI contamination detection, UV-C, and ethanol spray in one smart device.'
    },
    'landing.hero.cta.start':      { id: 'Mulai Sekarang', en: 'Get Started' },
    'landing.hero.cta.learn':      { id: 'Pelajari Lebih Lanjut', en: 'Learn More' },

    'landing.hero.mockup.title':   { id: 'Dashboard SteriFlow', en: 'SteriFlow Dashboard' },
    'landing.hero.mockup.gas':     { id: 'Tingkat Gas',         en: 'Gas Level' },
    'landing.hero.mockup.temp':    { id: 'Suhu',                 en: 'Temperature' },
    'landing.hero.mockup.hum':     { id: 'Kelembapan',           en: 'Humidity' },
    'landing.hero.mockup.system':  { id: 'Status Sistem',        en: 'System Status' },
    'landing.hero.mockup.sterilizing': { id: 'STERILISASI',      en: 'STERILIZING' },
    'landing.hero.mockup.uv_on':   { id: 'Lampu UV-C ON',        en: 'UV-C Lamp ON' },
    'landing.hero.mockup.spray':   { id: 'Semprot Ethanol',      en: 'Ethanol Spray' },

    'landing.stats.effect':        { id: 'Efektivitas Sterilisasi', en: 'Sterilization Effectiveness' },
    'landing.stats.duration':      { id: 'Durasi Proses',            en: 'Process Duration' },
    'landing.stats.sensors':       { id: 'Sensor Aktif',             en: 'Active Sensors' },
    'landing.stats.monitoring':    { id: 'Pemantauan Aktif',         en: 'Active Monitoring' },

    // How It Works
    'landing.how.tag':       { id: 'Alur Sistem',              en: 'System Flow' },
    'landing.how.title':     { id: 'Cara Kerja SteriFlow',      en: 'How SteriFlow Works' },
    'landing.how.subtitle':  { id: 'Sterilisasi otomatis dari deteksi sampai selesai dalam 6 langkah cerdas', en: 'Automated sterilization from detection to completion in 6 smart steps' },

    'landing.how.s1.title':  { id: 'Inisialisasi Sistem', en: 'System Initialization' },
    'landing.how.s1.desc':   { id: 'ESP32 mengaktifkan semua komponen: sensor gas, DHT11, modul relay, lampu UV-C, dan kipas siap beroperasi.', en: 'ESP32 activates all components: gas sensors, DHT11, relay module, UV-C lamp and fan ready to operate.' },
    'landing.how.s2.title':  { id: 'Deteksi Kontaminasi', en: 'Contamination Detection' },
    'landing.how.s2.desc':   { id: 'Sensor VOC menganalisis kontaminasi udara. Jika ambang terlampaui, sistem otomatis aktif.', en: 'VOC sensor analyzes air contamination. If the threshold is exceeded, the system is automatically activated.' },
    'landing.how.s3.title':  { id: 'Proses Sterilisasi', en: 'Sterilization Process' },
    'landing.how.s3.desc':   { id: 'Lampu UV-C membunuh mikroorganisme patogen secara langsung, diikuti semprot ethanol 70% food-grade.', en: 'UV-C lamp actively kills pathogenic microorganisms, along with 70% food-grade ethanol spray through the system nozzle.' },
    'landing.how.s4.title':  { id: 'Pantau Lingkungan',   en: 'Environment Monitoring' },
    'landing.how.s4.desc':   { id: 'Sensor DHT11 terus memantau suhu dan kelembapan ruangan untuk memastikan kondisi optimal selama sterilisasi.', en: 'DHT11 sensor continuously monitors room temperature and humidity to ensure optimal conditions during the sterilization process.' },
    'landing.how.s5.title':  { id: 'Pemantauan Realtime', en: 'Real-time Monitoring' },
    'landing.how.s5.desc':   { id: 'Dashboard web menampilkan data sensor realtime dari Firebase. Pantau gas, suhu, kelembapan, dan relay dari mana saja.', en: 'Web dashboard displays real-time sensor data from Firebase Realtime Database. Monitor gas levels, temperature, humidity, and relay status from anywhere.' },
    'landing.how.s6.title':  { id: 'Proses Selesai', en: 'Process Complete' },
    'landing.how.s6.desc':   { id: 'Sistem otomatis mematikan semua aktuator setelah sterilisasi selesai. Log tersimpan dan indikator hijau menandakan bersih.', en: 'System automatically turns off all actuators after sterilization is complete. Logs are saved to the dashboard and the green indicator shows clean.' },

    // Components
    'landing.comp.tag':      { id: 'Hardware & Software',  en: 'Hardware & Software' },
    'landing.comp.title':    { id: 'Komponen Sistem',      en: 'System Components' },
    'landing.comp.subtitle': { id: 'Teknologi terpilih untuk sterilisasi yang presisi dan andal', en: 'Selected technology for precise and reliable sterilization' },
    'landing.comp.cat.controller': { id: 'Kontroler',  en: 'Controller' },
    'landing.comp.cat.sensor':     { id: 'Sensor',     en: 'Sensor' },
    'landing.comp.cat.actuator':   { id: 'Aktuator',   en: 'Actuator' },
    'landing.comp.cat.indicator':  { id: 'Indikator',  en: 'Indicator' },
    'landing.comp.esp.desc':    { id: 'Pusat kendali pemantauan AI & kamera terintegrasi. WiFi bawaan untuk konektivitas IoT realtime.', en: 'Integrated AI monitoring control center & camera. Built-in WiFi for real-time IoT connectivity.' },
    'landing.comp.mq.name':     { id: 'MQ135 (VOC)',    en: 'MQ135 (VOC)' },
    'landing.comp.mq.desc':     { id: 'Sensor kualitas udara mendeteksi senyawa organik volatil. Otomatis memicu sterilisasi saat level melewati aman.', en: 'Air-quality sensor detecting volatile organic compounds. Automatically triggers sterilization when the level exceeds the safe range.' },
    'landing.comp.uv.desc':     { id: 'Sterilisasi UV membunuh 99,9% mikroorganisme patogen termasuk bakteri, virus, dan jamur pada permukaan.', en: 'UV sterilization kills 99.9% of pathogenic microorganisms including bacteria, viruses, and fungi on surfaces.' },
    'landing.comp.dht.desc':    { id: 'Memantau suhu dan kelembapan. Data tampil realtime di dashboard web.', en: 'Monitors temperature and humidity. Data displayed in real-time on the web dashboard.' },
    'landing.comp.fan.desc':    { id: 'Kipas ventilasi untuk sirkulasi udara saat sterilisasi. Dikontrol via relay dengan mode AUTO/MANUAL.', en: 'Ventilation fan for air circulation during sterilization. Controlled by relay module with AUTO/MANUAL mode.' },
    'landing.comp.rgb.desc':    { id: 'Indikator visual status sistem tiga warna: merah (kontaminasi), kuning (proses), hijau (steril & aman).', en: 'Visual system status indicator with three colors: red (contamination), yellow (processing), green (sterile & safe).' },

    // Dashboard preview
    'landing.dash.tag':      { id: 'Antarmuka Web',    en: 'Web Interface' },
    'landing.dash.title':    { id: 'Pemantauan Dashboard', en: 'Dashboard Monitoring' },
    'landing.dash.subtitle': { id: 'Pantau semua sensor dan kontrol sistem dari mana saja lewat browser', en: 'Monitor all sensors and control the system from anywhere via web browser' },
    'landing.dash.tab.home': { id: 'Beranda',    en: 'Home' },
    'landing.dash.tab.mon':  { id: 'Monitoring', en: 'Monitoring' },
    'landing.dash.tab.ai':   { id: 'Deteksi AI',  en: 'AI Detection' },
    'landing.dash.tab.log':  { id: 'Log',         en: 'Log' },
    'landing.dash.active':   { id: 'Sistem Aktif', en: 'System Active' },
    'landing.dash.gas_avg':  { id: 'Gas (Rata2)',  en: 'Gas (Avg)' },
    'landing.dash.alert':    { id: 'Peringatan Gas', en: 'Gas Alert' },
    'landing.dash.fan_on':   { id: 'Kipas: ON',     en: 'Fan: ON' },

    // AI Highlight
    'landing.ai.tag':       { id: 'Computer Vision', en: 'Computer Vision' },
    'landing.ai.title_a':   { id: 'Real-time',       en: 'Real-time' },
    'landing.ai.title_b':   { id: 'Deteksi AI',       en: 'AI Detection' },
    'landing.ai.desc':      { id: 'Sistem AI terintegrasi menganalisis visual permukaan secara realtime memanfaatkan ESP32-CAM.', en: 'Integrated AI system analyzes surface visuals in real-time using ESP32-CAM and YOLO model running on TensorFlow Lite.' },
    'landing.ai.f1.t':      { id: 'Klasifikasi 3 Tingkat', en: '3-Level Classification' },
    'landing.ai.f1.d':      { id: 'Deteksi status otomatis: Clean, Moderate, dan Dirty dengan akurasi tinggi.', en: 'Automatic status detection: Clean, Moderate, and Dirty with high accuracy' },
    'landing.ai.f2.t':      { id: 'YOLO Computer Vision', en: 'YOLO Computer Vision' },
    'landing.ai.f2.d':      { id: 'Model deteksi objek yang dioptimalkan agar efisien di mikrokontroler ESP32.', en: 'Optimized object detection model for efficient operation on ESP32 microcontroller' },
    'landing.ai.f3.t':      { id: 'Integrasi Otomatis',    en: 'Automatic Integration' },
    'landing.ai.f3.d':      { id: 'Deteksi "Dirty" langsung memicu proses sterilisasi UV-C dan semprot ethanol otomatis.', en: '"Dirty" detection directly triggers UV-C sterilization and ethanol spray process automatically' },

    // Team
    'landing.team.tag':       { id: 'Tim Kami',         en: 'Our Team' },
    'landing.team.title':     { id: 'Tim Kami',         en: 'Our Team' },
    'landing.team.subtitle':  { id: 'Para inovator di balik sistem sterilisasi cerdas SteriFlow', en: 'The innovators behind SteriFlow smart sterilization system' },

    // CTA / Footer
    'landing.cta.tagline':    { id: 'Sterilisasi cerdas berbasis IoT untuk ompreng stainless. Lebih bersih, lebih aman, lebih pintar.', en: 'IoT-based smart sterilization for stainless serving trays (ompreng). Cleaner, safer, smarter.' },
    'landing.footer.rights':  { id: '© 2026 SteriFlow. Semua hak dilindungi.', en: '© 2026 SteriFlow. All rights reserved.' },
    'landing.footer.built':   { id: 'Dibangun dengan IoT & AI', en: 'Built with IoT & AI' },

    // Language switcher label
    'common.language':        { id: 'Bahasa',            en: 'Language' },
    'common.lang.id':         { id: 'Indonesia',         en: 'Indonesian' },
    'common.lang.en':         { id: 'Inggris',           en: 'English' },

    // ──────────── DASHBOARD ────────────
    'dash.page.subtitle':    { id: 'Memuat tanggal…', en: 'Loading date…' },
    'dash.system_status':    { id: 'Status Sistem',   en: 'System Status' },
    'dash.sterilization':    { id: 'Sterilisasi',     en: 'Sterilization' },
    'dash.start':            { id: 'Mulai',            en: 'Start' },
    'dash.cycle_progress':   { id: 'Progres Siklus',   en: 'Cycle Progress' },
    'dash.last_cycle':       { id: 'Siklus Terakhir',  en: 'Last Cycle' },
    'dash.duration':         { id: 'Durasi',           en: 'Duration' },
    'dash.cycles_today':     { id: 'Siklus Hari Ini',  en: 'Cycles Today' },
    'dash.uvc_lamp':         { id: 'Lampu UV-C',       en: 'UV-C Lamp' },
    'dash.ethanol_spray':    { id: 'Semprot Ethanol',  en: 'Ethanol Spray' },
    'dash.fan':              { id: 'Kipas',             en: 'Fan' },
    'dash.mode':             { id: 'Mode:',            en: 'Mode:' },
    'dash.tray_clean_level': { id: 'Tingkat Kebersihan Ompreng', en: 'Tray Cleanliness Level' },
    'dash.sterile':          { id: 'Steril',           en: 'Sterile' },
    'dash.bacteria_status':  { id: 'Status Bakteri',   en: 'Bacteria Status' },
    'dash.safe':             { id: 'Aman',              en: 'Safe' },
    'dash.ompreng_safety':   { id: 'Keamanan Ompreng', en: 'Ompreng Safety' },
    'dash.last_scan':        { id: 'Pemindaian terakhir: 5 menit lalu', en: 'Last scan: 5 minutes ago' },
    'dash.next_steril':      { id: 'Sterilisasi Berikutnya', en: 'Next Sterilization' },
    'dash.scheduled':        { id: 'Terjadwal',        en: 'Scheduled' },
    'dash.device_status':    { id: 'Status Alat',      en: 'Device Status' },
    'dash.ready':            { id: 'SIAP',              en: 'READY' },
    'dash.ready_desc':       { id: 'Alat siap digunakan', en: 'Device ready to use' },
    'dash.last_sterilized':  { id: 'Terakhir disteril:', en: 'Last sterilized:' },
    'dash.complete':         { id: '✓ Selesai',         en: '✓ Complete' },

    // ──────────── MONITORING ────────────
    'mon.page.title':        { id: 'Monitoring Realtime', en: 'Realtime Monitoring' },
    'mon.page.subtitle':     { id: 'Data sensor langsung', en: 'Live sensor data' },
    'mon.label.voc':         { id: 'VOC',              en: 'VOC' },
    'mon.label.temp':        { id: 'Suhu',              en: 'Temperature' },
    'mon.label.hum':         { id: 'Kelembapan',        en: 'Humidity' },
    'mon.waiting':           { id: 'Menunggu…',         en: 'Waiting…' },
    'mon.voc.card.title':    { id: 'VOC (Kualitas Udara)', en: 'VOC (Air Quality)' },
    'mon.voc.card.desc':     { id: '20 bacaan terakhir · sensor MQ135', en: 'Last 20 readings · MQ135 sensor' },
    'mon.env.card.title':    { id: 'Suhu & Kelembapan', en: 'Temperature & Humidity' },
    'mon.env.card.desc':     { id: 'Kondisi lingkungan', en: 'Environment condition' },
    'mon.steril.status':     { id: 'Status Sterilisasi', en: 'Sterilization Status' },
    'mon.current_state':     { id: 'Kondisi Saat Ini',   en: 'Current State' },
    'mon.voc_alert':         { id: 'Peringatan VOC',     en: 'VOC Alert' },
    'mon.cycle_progress':    { id: 'Progres Siklus Saat Ini', en: 'Current Cycle Progress' },
    'mon.avg_duration':      { id: 'Rata Durasi',        en: 'Avg Duration' },
    'mon.cycles_today':      { id: 'Siklus Hari Ini',    en: 'Cycles Today' },
    'mon.success_rate':      { id: 'Tingkat Sukses',     en: 'Success Rate' },
    'mon.threshold.title':   { id: 'Referensi Ambang',   en: 'Thresholds Reference' },
    'mon.threshold.safe':    { id: 'Aman:',              en: 'Safe:' },

    // ──────────── AI DETECTION ────────────
    'ai.page.title':         { id: 'Deteksi AI',        en: 'AI Detection' },
    'ai.page.subtitle':      { id: 'Analisis kontaminasi', en: 'Contamination analysis' },
    'ai.camera_feed':        { id: 'Tampilan Kamera',   en: 'Camera Feed' },
    'ai.tap_to_start':       { id: 'Tekan tombol di bawah untuk buka kamera', en: 'Tap below to start camera' },
    'ai.analyzing':          { id: 'MENGANALISIS…',     en: 'ANALYZING…' },
    'ai.cam_denied':         { id: 'Akses kamera ditolak', en: 'Camera access denied' },
    'ai.cam_mixed_https':    { id: 'ESP32-CAM hanya tersedia lewat HTTP. Browser memblokir stream di halaman HTTPS. Buka aplikasi ini lewat HTTP (mis. http://<ip-lokal>) atau izinkan konten tidak aman di pengaturan situs.', en: 'ESP32-CAM only serves HTTP. The browser blocks the stream on an HTTPS page. Open this app over HTTP (e.g. http://<local-ip>) or allow insecure content in site settings.' },
    'ai.overlay.title':      { id: 'Menganalisis ompreng…', en: 'Analyzing tray…' },
    'ai.overlay.subtitle':   { id: 'Gemini sedang memeriksa permukaan & data sensor', en: 'Gemini is reviewing the surface & sensor data' },
    'ai.model':              { id: 'Model: Gemini 2.5 Flash Lite', en: 'Model: Gemini 2.5 Flash Lite' },
    'ai.resolution':         { id: 'Resolusi: —',       en: 'Resolution: —' },
    'ai.status_idle':        { id: 'Status: Idle',      en: 'Status: Idle' },
    'ai.btn.open':           { id: 'Buka Kamera',       en: 'Open Camera' },
    'ai.btn.close':          { id: 'Tutup Kamera',      en: 'Close Camera' },
    'ai.btn.scan':           { id: 'Mulai Scan',        en: 'Start Scan' },
    'ai.btn.scan_again':     { id: 'Scan Lagi',         en: 'Scan Again' },
    'ai.result.title':       { id: 'Hasil Deteksi',     en: 'Detection Result' },
    'ai.result.scanned':     { id: 'Dipindai',          en: 'Scanned' },
    'ai.result.confidence':  { id: 'Skor Keyakinan',    en: 'Confidence Score' },
    'ai.result.gemini_conf': { id: 'Keyakinan AI Gemini', en: 'Gemini AI confidence' },
    'ai.result.cont_level':  { id: 'Tingkat Kontaminasi', en: 'Contamination Level' },
    'ai.result.analysis':    { id: 'Analisis AI',       en: 'AI Analysis' },
    'ai.result.residue':     { id: 'Analisis Residu',   en: 'Residue Analysis' },
    'ai.steril.title':       { id: 'Sterilisasi',       en: 'Sterilization' },
    'ai.steril.duration':    { id: 'Durasi',             en: 'Duration' },
    'ai.steril.status':      { id: 'Status',             en: 'Status' },
    'ai.steril.ready':       { id: 'Siap',               en: 'Ready' },
    'ai.steril.cycle':       { id: 'Progres Siklus',    en: 'Cycle Progress' },
    'ai.steril.time_remaining': { id: 'Sisa waktu',     en: 'Time remaining' },
    'ai.steril.start_btn':   { id: 'Mulai Sterilisasi', en: 'Start Sterilization' },
    'ai.steril.skip':        { id: 'Lewati',             en: 'Skip' },
    'ai.class.title':        { id: 'Panduan Klasifikasi', en: 'Classification Guide' },
    'ai.class.clean':        { id: 'Bersih',             en: 'Clean' },
    'ai.class.clean.desc':   { id: 'Permukaan ompreng steril. Tidak ada kontaminasi. Siap dipakai.', en: 'Tray surface is sterile. No contamination detected. Ready for use.' },
    'ai.class.mod':          { id: 'Sedang',             en: 'Moderate' },
    'ai.class.mod.desc':     { id: 'Ada kontaminasi ringan. Sebaiknya disterilkan sebelum dipakai.', en: 'Minor contamination present. Sterilization recommended before use.' },
    'ai.class.dirty':        { id: 'Kotor',              en: 'Dirty' },
    'ai.class.dirty.desc':   { id: 'Tingkat kontaminasi tinggi. Harus segera disterilkan. Jangan dipakai.', en: 'High contamination level. Immediate sterilization required. Do not use.' },
    'ai.recent':             { id: 'Pemindaian Terakhir', en: 'Recent Scans' },
    'ai.no_scans':           { id: 'Belum ada. Mulai scan untuk melihat riwayat.', en: 'No scans yet. Start scanning to see history.' },
    'ai.select_device':      { id: 'Pilih Perangkat',   en: 'Select Device' },
    'ai.select_desc':        { id: 'Pilih perangkat SteriFlow untuk membuka stream ESP32-CAM-nya', en: 'Choose a SteriFlow device to open its ESP32-CAM stream' },
    'ai.loading_devices':    { id: 'Memuat perangkat…', en: 'Loading devices…' },

    // ──────────── AI CHAT ────────────
    'chat.page.title':       { id: 'Asisten AI',        en: 'AI Assistant' },
    'chat.page.subtitle':    { id: 'Didukung Gemini',   en: 'Powered by Gemini' },
    'chat.welcome.title':    { id: 'SteriFlow AI',      en: 'SteriFlow AI' },
    'chat.welcome.desc':     { id: 'Tanya apa saja tentang sistem sterilisasi, data sensor, atau riwayat sterilisasi Anda.', en: 'Ask anything about the sterilization system, sensor data, or your sterilization history.' },
    'chat.sugg.sensors':     { id: 'Kondisi sensor saat ini', en: 'Current sensor condition' },
    'chat.sugg.today':       { id: 'Sterilisasi hari ini',    en: 'Sterilizations today' },
    'chat.sugg.air':         { id: 'Kualitas udara',          en: 'Air quality' },
    'chat.sugg.last':        { id: 'Riwayat terakhir',        en: 'Latest history' },
    'chat.input.placeholder':{ id: 'Ketik pesan…',            en: 'Type a message…' },

    // ──────────── HISTORY ────────────
    'hist.page.title':       { id: 'Log Sterilisasi',  en: 'Sterilization Log' },
    'hist.page.subtitle':    { id: 'Riwayat aktivitas',  en: 'Activity history' },
    'hist.filter.all':       { id: 'Semua',             en: 'All' },
    'hist.filter.today':     { id: 'Hari ini',          en: 'Today' },
    'hist.filter.week':      { id: 'Minggu ini',        en: 'This Week' },
    'hist.filter.month':     { id: 'Bulan ini',         en: 'This Month' },
    'hist.total_cycles':     { id: 'Total Siklus',      en: 'Total Cycles' },
    'hist.avg_duration':     { id: 'Rata Durasi',       en: 'Avg Duration' },
    'hist.clean_rate':       { id: 'Rasio Bersih',      en: 'Clean Rate' },
    'hist.cycle_records':    { id: 'Catatan Siklus',    en: 'Cycle Records' },
    'hist.th.date':          { id: 'Tanggal',           en: 'Date' },
    'hist.th.time':          { id: 'Waktu',             en: 'Time' },
    'hist.th.duration':      { id: 'Durasi',            en: 'Duration' },
    'hist.th.result':        { id: 'Hasil',             en: 'Result' },
    'hist.loading':          { id: 'Memuat riwayat…',   en: 'Loading history…' },
    'hist.breakdown':        { id: 'Rincian Deteksi',   en: 'Detection Breakdown' },
    'hist.success_rate':     { id: 'Rasio Sukses Siklus', en: 'Cycle Success Rate' },
    'hist.sterilized':       { id: 'Disterilkan',       en: 'Sterilized' },
    'hist.skipped':          { id: 'Dilewati',          en: 'Skipped' },
    'hist.total':            { id: 'Total',             en: 'Total' },

    // ──────────── ACCOUNT ────────────
    'acc.page.title':        { id: 'Akun',              en: 'Account' },
    'acc.page.subtitle':     { id: 'Profil & Pengaturan', en: 'Profile & Settings' },
    'acc.info.title':        { id: 'Informasi Akun',    en: 'Account Information' },
    'acc.info.email':        { id: 'Email',             en: 'Email' },
    'acc.info.since':        { id: 'Anggota Sejak',     en: 'Member Since' },
    'acc.info.last_login':   { id: 'Login Terakhir',    en: 'Last Login' },
    'acc.info.method':       { id: 'Metode Login',      en: 'Login Method' },
    'acc.appearance':        { id: 'Tampilan',          en: 'Appearance' },
    'acc.light_mode':        { id: 'Mode Terang',       en: 'Light Mode' },
    'acc.language':          { id: 'Bahasa',            en: 'Language' },
    'acc.lang.hint':         { id: 'Indonesia / Inggris', en: 'Indonesian / English' },
    'acc.actions.logout':    { id: 'Keluar',            en: 'Logout' },
    'acc.status.active':     { id: 'Aktif',             en: 'Active' },

    // ──────────── AUTH ────────────
    'auth.login':            { id: 'Masuk',             en: 'Login' },
    'auth.register':         { id: 'Daftar',            en: 'Register' },
    'auth.email':            { id: 'Email',             en: 'Email' },
    'auth.password':         { id: 'Kata Sandi',        en: 'Password' },
    'auth.confirm_pw':       { id: 'Konfirmasi Sandi',  en: 'Confirm Password' },
    'auth.or':               { id: 'atau',              en: 'or' },
    'auth.google':           { id: 'Lanjutkan dengan Google', en: 'Continue with Google' },
    'auth.forgot_pw':        { id: 'Lupa kata sandi?',  en: 'Forgot password?' },
    'auth.subtitle':         { id: 'Masuk untuk mengakses dashboard pemantauan', en: 'Sign in to access the monitoring dashboard' },
    'auth.full_name':        { id: 'Nama Lengkap',      en: 'Full Name' },
    'auth.full_name_ph':     { id: 'Nama lengkap',      en: 'Full name' },
    'auth.email_ph':         { id: 'nama@email.com',    en: 'name@email.com' },
    'auth.password_ph':      { id: 'Masukkan kata sandi', en: 'Enter password' },
    'auth.password_min':     { id: 'Minimal 6 karakter', en: 'Minimum 6 characters' },
    'auth.sign_in':          { id: 'Masuk',             en: 'Sign In' },
    'auth.sign_up':          { id: 'Daftar',            en: 'Sign Up' },
    'auth.google_in':        { id: 'Masuk dengan Google', en: 'Sign in with Google' },
    'auth.google_up':        { id: 'Daftar dengan Google', en: 'Sign up with Google' },
    'auth.continue_with':    { id: 'atau lanjutkan dengan', en: 'or continue with' },
    'auth.back_home':        { id: 'Kembali ke Beranda', en: 'Back to Home' },

    // ──────────── 404 ────────────
    '404.title':             { id: '404 — Halaman Tidak Ditemukan', en: '404 — Page Not Found' },
    '404.desc':              { id: 'Halaman yang kamu cari tidak ada.', en: 'The page you were looking for does not exist.' },
    '404.back':              { id: 'Kembali ke Beranda', en: 'Back to Home' }
  };

  function getLang() {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (saved === 'id' || saved === 'en') ? saved : DEFAULT_LANG;
  }

  function saveLang(lang) {
    localStorage.setItem(STORAGE_KEY, lang);
  }

  function t(key, lang) {
    lang = lang || getLang();
    const entry = DICT[key];
    if (!entry) return key; // kunci tidak dikenal → biarkan key mentah biar kelihatan
    return entry[lang] ?? entry.en ?? entry.id ?? key;
  }

  function translateRoot(root, lang) {
    // Text content
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key, lang);
      if (el.hasAttribute('data-i18n-html')) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });
    // Common HTML attributes
    const attrPairs = [
      ['data-i18n-placeholder',  'placeholder'],
      ['data-i18n-title',        'title'],
      ['data-i18n-aria-label',   'aria-label'],
      ['data-i18n-alt',          'alt'],
      ['data-i18n-value',        'value']
    ];
    attrPairs.forEach(([dataAttr, targetAttr]) => {
      root.querySelectorAll(`[${dataAttr}]`).forEach(el => {
        el.setAttribute(targetAttr, t(el.getAttribute(dataAttr), lang));
      });
    });
  }

  function applyLang(lang) {
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);
    translateRoot(document, lang);

    // Sinkronkan UI tombol toggle yang ada
    document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
      // Update label kalau ada elemen .lang-toggle-label di dalamnya
      const label = btn.querySelector('.lang-toggle-label');
      if (label) label.textContent = lang === 'en' ? 'EN' : 'ID';
    });
    document.querySelectorAll('[data-lang-set]').forEach(btn => {
      const isActive = btn.getAttribute('data-lang-set') === lang;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    const toggle = document.getElementById('langToggle');
    if (toggle) toggle.checked = lang === 'en';

    // Fire event agar kode dinamis (realtime.js, ai-detection.html, dll) bisa re-render string
    window.dispatchEvent(new CustomEvent('language:change', { detail: { lang } }));
  }

  function setLang(lang) {
    if (lang !== 'id' && lang !== 'en') return;
    saveLang(lang);
    applyLang(lang);
  }

  function toggleLang() {
    setLang(getLang() === 'id' ? 'en' : 'id');
  }

  // Terapkan segera (sebelum DOMContentLoaded) supaya teks awal sudah sesuai
  try { applyLang(getLang()); } catch (_) { /* DOM belum siap — akan dicoba lagi di DOMContentLoaded */ }

  document.addEventListener('DOMContentLoaded', () => {
    applyLang(getLang());

    // Tombol toggle (data-lang-toggle)
    document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        toggleLang();
      });
    });

    // Tombol set bahasa eksplisit (data-lang-set="id|en")
    document.querySelectorAll('[data-lang-set]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        setLang(btn.getAttribute('data-lang-set'));
      });
    });

    // Checkbox toggle (id=langToggle, checked = EN)
    const toggle = document.getElementById('langToggle');
    if (toggle) {
      toggle.checked = getLang() === 'en';
      toggle.addEventListener('change', () => {
        setLang(toggle.checked ? 'en' : 'id');
      });
    }
  });

  // Expose API
  window.SteriflowI18n = { t, getLang, setLang, applyLang, toggle: toggleLang };
})();
