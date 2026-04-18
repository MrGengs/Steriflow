#include <WiFi.h>
#include <FirebaseESP32.h>
#include <DHT.h>

// ==================== KONFIGURASI ====================
#define WIFI_SSID "enumatechz"
#define WIFI_PASSWORD "3numaTechn0l0gy"

#define FIREBASE_HOST "steriflow-id-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_AUTH "Aj1KCC0TwMdyxOj21FS0DX5V2wCqXl3xp3jt0JMH"

// ==================== PIN DHT11 ====================
#define DHT_PIN   15
#define DHT_TYPE  DHT11

// ==================== PIN RELAY ====================
#define RELAY_FAN_PIN    14    // Relay 1 → Fan
#define RELAY_PUMP_PIN   13    // Relay 2 → Pompa Air
#define RELAY_UV_PIN     4     // Relay 3 → UV Light

#define RELAY_ON         LOW
#define RELAY_OFF        HIGH

// ==================== THRESHOLD ====================
#define TEMP_FAN_THRESHOLD    35.0   // °C → Fan ON
#define TEMP_FAN_HYSTERESIS   2.0    // °C → Fan OFF di 33°C
#define HUMIDITY_UV_THRESHOLD 70.0   // % → UV ON
#define UV_DURATION_MS        30000  // UV nyala maks 30 detik otomatis

// ==================== INTERVAL ====================
#define SENSOR_READ_INTERVAL   2000  // 2 detik
#define FIREBASE_SEND_INTERVAL 5000  // 5 detik

// ==================== OBJEK ====================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
DHT dht(DHT_PIN, DHT_TYPE);

// ==================== VARIABEL SENSOR ====================
float temperature = 0;
float humidity    = 0;

// ==================== VARIABEL RELAY ====================
bool fanState    = false;
bool pumpState   = false;
bool uvState     = false;

bool fanManual   = false;
bool pumpManual  = false;
bool uvManual    = false;

unsigned long uvStartTime  = 0;
bool          uvAutoActive = false;

// ==================== VARIABEL WAKTU ====================
unsigned long lastSensorRead   = 0;
unsigned long lastFirebaseSend = 0;

// ==================== KONEKSI WIFI ====================
void connectWiFi() {
  Serial.print("Menghubungkan WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempt = 0;
  while (WiFi.status() != WL_CONNECTED && attempt < 20) {
    delay(500);
    Serial.print(".");
    attempt++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✓ WiFi Terhubung! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\n✗ Gagal konek WiFi. Restart...");
    ESP.restart();
  }
}

// ==================== KONEKSI FIREBASE ====================
void connectFirebase() {
  config.host = FIREBASE_HOST;
  config.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(4096);
  Serial.println("✓ Firebase Terhubung!");
}

// ==================== SET RELAY ====================
void setFan(bool state, String source = "auto") {
  fanState = state;
  digitalWrite(RELAY_FAN_PIN, state ? RELAY_ON : RELAY_OFF);
  Serial.printf("[FAN]   %s  ← %s\n", state ? "ON  ✓" : "OFF ✗", source.c_str());
}

void setPump(bool state, String source = "manual") {
  pumpState = state;
  digitalWrite(RELAY_PUMP_PIN, state ? RELAY_ON : RELAY_OFF);
  Serial.printf("[PUMP]  %s  ← %s\n", state ? "ON  ✓" : "OFF ✗", source.c_str());
}

void setUV(bool state, String source = "auto") {
  uvState = state;
  digitalWrite(RELAY_UV_PIN, state ? RELAY_ON : RELAY_OFF);
  Serial.printf("[UV]    %s  ← %s\n", state ? "ON  ✓" : "OFF ✗", source.c_str());
  if (state && source == "auto") {
    uvStartTime  = millis();
    uvAutoActive = true;
  } else if (!state) {
    uvAutoActive = false;
  }
}

// ==================== MENU SERIAL ====================
void printMenu() {
  Serial.println("╔═════════════════════════════════════════╗");
  Serial.println("║       KONTROL SERIAL MONITOR            ║");
  Serial.println("╠═════════════════════════════════════════╣");
  Serial.println("║  1  → FAN   ON   (Relay 1 / GPIO14)    ║");
  Serial.println("║  0  → FAN   OFF  (Relay 1 / GPIO14)    ║");
  Serial.println("║  3  → PUMP  ON   (Relay 2 / GPIO13)    ║");
  Serial.println("║  8  → PUMP  OFF  (Relay 2 / GPIO13)    ║");
  Serial.println("║  2  → UV    ON   (Relay 3 / GPIO4)     ║");
  Serial.println("║  9  → UV    OFF  (Relay 3 / GPIO4)     ║");
  Serial.println("╠═════════════════════════════════════════╣");
  Serial.println("║  a  → Auto mode ON  (semua relay)      ║");
  Serial.println("║  s  → Status sensor & relay            ║");
  Serial.println("║  h  → Tampilkan menu ini               ║");
  Serial.println("╚═════════════════════════════════════════╝");
}

// ==================== STATUS ====================
void printStatus() {
  Serial.println("══════════════════════════════════════════");
  Serial.println("              STATUS SISTEM");
  Serial.println("══════════════════════════════════════════");
  Serial.printf(" Suhu        : %.1f °C\n", temperature);
  Serial.printf(" Kelembaban  : %.1f %%\n", humidity);
  Serial.println("──────────────────────────────────────────");
  Serial.printf(" FAN  (Relay1/GPIO14) : %-3s  [%s]\n",
    fanState  ? "ON" : "OFF", fanManual  ? "MANUAL" : "AUTO");
  Serial.printf(" PUMP (Relay2/GPIO13) : %-3s  [%s]\n",
    pumpState ? "ON" : "OFF", pumpManual ? "MANUAL" : "AUTO");
  Serial.printf(" UV   (Relay3/GPIO4)  : %-3s  [%s]%s\n",
    uvState   ? "ON" : "OFF", uvManual   ? "MANUAL" : "AUTO",
    uvAutoActive ? " ⏱timer aktif" : "");
  Serial.println("══════════════════════════════════════════");
}

// ==================== HANDLE SERIAL ====================
void handleSerialCommand() {
  if (!Serial.available()) return;

  String input = Serial.readStringUntil('\n');
  input.trim();
  if (input.length() == 0) return;

  Serial.println(">> Perintah: [" + input + "]");

  if (input == "1") {
    fanManual = true;
    setFan(true, "serial");
    Firebase.setBool(fbdo, "/relayCommand/fan", true);
    Serial.println("✅ FAN ON — mode MANUAL aktif");

  } else if (input == "0") {
    fanManual = true;
    setFan(false, "serial");
    Firebase.setBool(fbdo, "/relayCommand/fan", false);
    Serial.println("✅ FAN OFF — mode MANUAL aktif");

  } else if (input == "3") {
    pumpManual = true;
    setPump(true, "serial");
    Firebase.setBool(fbdo, "/relayCommand/pump", true);
    Serial.println("✅ POMPA ON — mode MANUAL aktif");

  } else if (input == "8") {
    pumpManual = true;
    setPump(false, "serial");
    Firebase.setBool(fbdo, "/relayCommand/pump", false);
    Serial.println("✅ POMPA OFF — mode MANUAL aktif");

  } else if (input == "2") {
    uvManual     = true;
    uvAutoActive = false;
    setUV(true, "serial");
    Firebase.setBool(fbdo, "/relayCommand/uv", true);
    Serial.println("✅ UV ON — mode MANUAL aktif");

  } else if (input == "9") {
    uvManual     = true;
    uvAutoActive = false;
    setUV(false, "serial");
    Firebase.setBool(fbdo, "/relayCommand/uv", false);
    Serial.println("✅ UV OFF — mode MANUAL aktif");

  } else if (input == "a") {
    fanManual    = false;
    pumpManual   = false;
    uvManual     = false;
    uvAutoActive = false;
    Serial.println("🔄 Mode AUTO aktif untuk semua relay");

  } else if (input == "s") {
    printStatus();

  } else if (input == "h") {
    printMenu();

  } else {
    Serial.println("⚠ Perintah tidak dikenal. Ketik 'h' untuk menu");
  }
}

// ==================== BACA SENSOR ====================
void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity    = h;
  else Serial.println("⚠ Gagal baca DHT11!");
}

// ==================== LOGIKA AUTO RELAY ====================
void autoControlRelay() {

  // --- FAN: auto berdasarkan suhu ---
  if (!fanManual) {
    bool shouldOn  = (temperature >= TEMP_FAN_THRESHOLD);
    bool shouldOff = (temperature < (TEMP_FAN_THRESHOLD - TEMP_FAN_HYSTERESIS));
    if (shouldOn  && !fanState) setFan(true,  "auto");
    if (shouldOff &&  fanState) setFan(false, "auto");
  }

  // --- PUMP: hanya manual, tidak ada trigger otomatis ---

  // --- UV: auto berdasarkan kelembaban + timer ---
  if (!uvManual) {
    if (uvAutoActive && (millis() - uvStartTime >= UV_DURATION_MS)) {
      setUV(false, "auto-timeout");
      Serial.println("⚠ UV timeout 30 detik — dimatikan otomatis");
    }
    if (humidity >= HUMIDITY_UV_THRESHOLD && !uvState && !uvAutoActive) {
      setUV(true, "auto");
    }
  }
}

// ==================== CEK PERINTAH FIREBASE ====================
void checkRelayCommand() {
  // Fan
  if (Firebase.getBool(fbdo, "/relayCommand/fan")) {
    bool cmd = fbdo.boolData();
    if (cmd != fanState) { fanManual = true; setFan(cmd, "firebase"); }
  }
  // Pump
  if (Firebase.getBool(fbdo, "/relayCommand/pump")) {
    bool cmd = fbdo.boolData();
    if (cmd != pumpState) { pumpManual = true; setPump(cmd, "firebase"); }
  }
  // UV
  if (Firebase.getBool(fbdo, "/relayCommand/uv")) {
    bool cmd = fbdo.boolData();
    if (cmd != uvState) { uvManual = true; uvAutoActive = false; setUV(cmd, "firebase"); }
  }
}

// ==================== KIRIM KE FIREBASE ====================
void sendToFirebase() {
  FirebaseJson json;

  // DHT11
  json.set("dht11/temperature", temperature);
  json.set("dht11/humidity",    humidity);

  // Status relay
  json.set("relay/fan",       fanState  ? "ON" : "OFF");
  json.set("relay/pump",      pumpState ? "ON" : "OFF");
  json.set("relay/uv",        uvState   ? "ON" : "OFF");

  // Mode relay
  json.set("relay/fan_mode",  fanManual  ? "MANUAL" : "AUTO");
  json.set("relay/pump_mode", pumpManual ? "MANUAL" : "AUTO");
  json.set("relay/uv_mode",   uvManual   ? "MANUAL" : "AUTO");

  // Alert suhu & kelembaban
  json.set("status/temp_alert", (temperature >= TEMP_FAN_THRESHOLD)    ? "PANAS"  : "NORMAL");
  json.set("status/hum_alert",  (humidity    >= HUMIDITY_UV_THRESHOLD) ? "LEMBAB" : "NORMAL");
  json.set("timestamp", (int)millis());

  if (Firebase.setJSON(fbdo, "/sensorData", json)) {
    Serial.println("✓ Firebase terkirim");
  } else {
    Serial.println("✗ Firebase error: " + fbdo.errorReason());
  }
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== SteriFlow IoT System ===");

  // Relay output — default OFF
  pinMode(RELAY_FAN_PIN,  OUTPUT); digitalWrite(RELAY_FAN_PIN,  RELAY_OFF);
  pinMode(RELAY_PUMP_PIN, OUTPUT); digitalWrite(RELAY_PUMP_PIN, RELAY_OFF);
  pinMode(RELAY_UV_PIN,   OUTPUT); digitalWrite(RELAY_UV_PIN,   RELAY_OFF);

  dht.begin();
  delay(2000);

  connectWiFi();
  connectFirebase();

  printMenu();
  Serial.println("\n✓ Sistem siap!\n");
}

// ==================== LOOP ====================
void loop() {
  unsigned long now = millis();

  handleSerialCommand();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠ WiFi putus, menghubungkan ulang...");
    connectWiFi();
  }

  if (now - lastSensorRead >= SENSOR_READ_INTERVAL) {
    lastSensorRead = now;
    readSensors();
    autoControlRelay();
  }

  if (now - lastFirebaseSend >= FIREBASE_SEND_INTERVAL) {
    lastFirebaseSend = now;
    sendToFirebase();
    checkRelayCommand();
  }
}