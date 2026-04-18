#include <WiFi.h>
#include <FirebaseESP32.h>
#include <DHT.h>

// ==================== KONFIGURASI ====================
#define WIFI_SSID "enumatechz"
#define WIFI_PASSWORD "3numaTechn0l0gy"

#define FIREBASE_HOST "steriflow-id-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_AUTH "Aj1KCC0TwMdyxOj21FS0DX5V2wCqXl3xp3jt0JMH"

// ==================== DEVICE ID ====================
#define DEVICE_ID     "steriflow-001"

// ==================== PIN SENSOR ====================
#define MQ8_ANALOG_PIN   34
#define MQ8_DIGITAL_PIN  27
#define MQ6_ANALOG_PIN   35
#define MQ6_DIGITAL_PIN  26
#define MQ3_ANALOG_PIN   32
#define MQ3_DIGITAL_PIN  25
#define DHT_PIN          15
#define DHT_TYPE         DHT11

// ==================== PIN RELAY ====================
#define RELAY_FAN_PIN    14    // Relay 1 → Fan
#define RELAY_UV_PIN     4     // Relay 3 → UV Light
#define RELAY_ON         LOW
#define RELAY_OFF        HIGH

// ==================== THRESHOLD ====================
#define GAS_ANALOG_THRESHOLD   2000
#define TEMP_FAN_THRESHOLD     35.0
#define TEMP_FAN_HYSTERESIS    2.0
#define HUMIDITY_UV_THRESHOLD  70.0
#define UV_DURATION_MS         30000

// ==================== INTERVAL ====================
#define SENSOR_READ_INTERVAL   2000
#define FIREBASE_SEND_INTERVAL 5000

// ==================== OBJEK ====================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
DHT dht(DHT_PIN, DHT_TYPE);

// ==================== VARIABEL SENSOR ====================
float temperature  = 0;
float humidity     = 0;
int   mq8Analog    = 0;
int   mq6Analog    = 0;
int   mq3Analog    = 0;
bool  mq8Digital   = false;
bool  mq6Digital   = false;
bool  mq3Digital   = false;

// ==================== VARIABEL RELAY ====================
bool fanState      = false;
bool uvState       = false;
bool fanManual     = false;
bool uvManual      = false;

unsigned long uvStartTime  = 0;
bool          uvAutoActive = false;

// ==================== VARIABEL WAKTU ====================
unsigned long lastSensorRead   = 0;
unsigned long lastFirebaseSend = 0;

// ==================== HELPER: PATH BUILDER ====================
String path(String subPath) {
  return "/" + String(DEVICE_ID) + subPath;
}

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
  Serial.printf("[FAN]  %s  ← sumber: %s\n", state ? "ON ✓" : "OFF ✗", source.c_str());
}

void setUV(bool state, String source = "auto") {
  uvState = state;
  digitalWrite(RELAY_UV_PIN, state ? RELAY_ON : RELAY_OFF);
  Serial.printf("[UV]   %s  ← sumber: %s\n", state ? "ON ✓" : "OFF ✗", source.c_str());
  if (state && source == "auto") {
    uvStartTime  = millis();
    uvAutoActive = true;
  } else if (!state) {
    uvAutoActive = false;
  }
}

// ==================== TAMPILKAN MENU SERIAL ====================
void printMenu() {
  Serial.println("╔══════════════════════════════════════╗");
  Serial.println("║     KONTROL SERIAL MONITOR           ║");
  Serial.println("╠══════════════════════════════════════╣");
  Serial.println("║  1  → FAN  ON  (Relay 1 / GPIO14)   ║");
  Serial.println("║  0  → FAN  OFF (Relay 1 / GPIO14)   ║");
  Serial.println("║  2  → UV   ON  (Relay 3 / GPIO4)    ║");
  Serial.println("║  9  → UV   OFF (Relay 3 / GPIO4)    ║");
  Serial.println("║  a  → Auto mode ON  (semua relay)   ║");
  Serial.println("║  s  → Status sensor & relay         ║");
  Serial.println("║  h  → Tampilkan menu ini             ║");
  Serial.println("╚══════════════════════════════════════╝");
}

// ==================== BACA PERINTAH SERIAL ====================
void handleSerialCommand() {
  if (!Serial.available()) return;

  String input = Serial.readStringUntil('\n');
  input.trim();

  if (input.length() == 0) return;

  Serial.println(">> Perintah diterima: [" + input + "]");

  if (input == "1") {
    fanManual = true;
    setFan(true, "serial");
    Serial.println("✅ FAN dinyalakan via Serial Monitor");
    Serial.println("   (Auto mode dinonaktifkan untuk FAN)");
    Firebase.setBool(fbdo, path("/relayCommand/fan"), true);

  } else if (input == "0") {
    fanManual = true;
    setFan(false, "serial");
    Serial.println("✅ FAN dimatikan via Serial Monitor");
    Serial.println("   (Auto mode dinonaktifkan untuk FAN)");
    Firebase.setBool(fbdo, path("/relayCommand/fan"), false);

  } else if (input == "2") {
    uvManual     = true;
    uvAutoActive = false;
    setUV(true, "serial");
    Serial.println("✅ UV dinyalakan via Serial Monitor");
    Serial.println("   (Auto mode & timer dinonaktifkan untuk UV)");
    Firebase.setBool(fbdo, path("/relayCommand/uv"), true);

  } else if (input == "9") {
    uvManual     = true;
    uvAutoActive = false;
    setUV(false, "serial");
    Serial.println("✅ UV dimatikan via Serial Monitor");
    Serial.println("   (Auto mode & timer dinonaktifkan untuk UV)");
    Firebase.setBool(fbdo, path("/relayCommand/uv"), false);

  } else if (input == "a") {
    fanManual    = false;
    uvManual     = false;
    uvAutoActive = false;
    Serial.println("🔄 Mode AUTO diaktifkan untuk semua relay");
    Serial.println("   Relay akan dikontrol sensor secara otomatis");

  } else if (input == "s") {
    printStatus();

  } else if (input == "h") {
    printMenu();

  } else {
    Serial.println("⚠ Perintah tidak dikenal: [" + input + "]");
    Serial.println("  Ketik 'h' untuk melihat daftar perintah");
  }
}

// ==================== TAMPILKAN STATUS ====================
void printStatus() {
  Serial.println("════════════════════════════════════════");
  Serial.println("           STATUS SISTEM");
  Serial.println("════════════════════════════════════════");
  Serial.printf(" Suhu       : %.1f °C\n", temperature);
  Serial.printf(" Kelembaban : %.1f %%\n", humidity);
  Serial.println("────────────────────────────────────────");
  Serial.printf(" MQ-8 (H2)  : %4d ADC | %s\n", mq8Analog, mq8Digital ? "⚠ BAHAYA" : "✓ AMAN");
  Serial.printf(" MQ-6 (LPG) : %4d ADC | %s\n", mq6Analog, mq6Digital ? "⚠ BAHAYA" : "✓ AMAN");
  Serial.printf(" MQ-3 (Alc) : %4d ADC | %s\n", mq3Analog, mq3Digital ? "⚠ BAHAYA" : "✓ AMAN");
  Serial.println("────────────────────────────────────────");
  Serial.printf(" FAN  (Relay1) : %-3s  [Mode: %s]\n",
    fanState ? "ON" : "OFF",
    fanManual ? "MANUAL" : "AUTO");
  Serial.printf(" UV   (Relay3) : %-3s  [Mode: %s]%s\n",
    uvState ? "ON" : "OFF",
    uvManual ? "MANUAL" : "AUTO",
    uvAutoActive ? " ⏱timer aktif" : "");
  Serial.println("════════════════════════════════════════");
}

// ==================== BACA SENSOR ====================
void readSensors() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity    = h;

  mq8Analog  = analogRead(MQ8_ANALOG_PIN);
  mq8Digital = !digitalRead(MQ8_DIGITAL_PIN);
  mq6Analog  = analogRead(MQ6_ANALOG_PIN);
  mq6Digital = !digitalRead(MQ6_DIGITAL_PIN);
  mq3Analog  = analogRead(MQ3_ANALOG_PIN);
  mq3Digital = !digitalRead(MQ3_DIGITAL_PIN);
}

// ==================== LOGIKA OTOMATIS RELAY ====================
void autoControlRelay() {
  bool gasDanger = (mq8Analog > GAS_ANALOG_THRESHOLD) ||
                   (mq6Analog > GAS_ANALOG_THRESHOLD) ||
                   (mq3Analog > GAS_ANALOG_THRESHOLD) ||
                   mq8Digital || mq6Digital || mq3Digital;

  if (!fanManual) {
    bool shouldOn  = (temperature >= TEMP_FAN_THRESHOLD) || gasDanger;
    bool shouldOff = (temperature < (TEMP_FAN_THRESHOLD - TEMP_FAN_HYSTERESIS)) && !gasDanger;
    if (shouldOn  && !fanState) setFan(true,  "auto");
    if (shouldOff && fanState)  setFan(false, "auto");
  }

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
  // Fan dari Firebase
  if (Firebase.getBool(fbdo, path("/relayCommand/fan"))) {
    bool cmd = fbdo.boolData();
    if (cmd != fanState) {
      fanManual = true;
      setFan(cmd, "firebase");
    }
  }
  // UV dari Firebase
  if (Firebase.getBool(fbdo, path("/relayCommand/uv"))) {
    bool cmd = fbdo.boolData();
    if (cmd != uvState) {
      uvManual     = true;
      uvAutoActive = false;
      setUV(cmd, "firebase");
    }
  }
}

// ==================== KIRIM DATA KE FIREBASE ====================
void sendToFirebase() {
  FirebaseJson json;
  json.set("dht11/temperature", temperature);
  json.set("dht11/humidity",    humidity);
  json.set("mq8/analog",   mq8Analog);
  json.set("mq8/digital",  mq8Digital);
  json.set("mq8/status",   mq8Digital ? "BAHAYA" : "AMAN");
  json.set("mq6/analog",   mq6Analog);
  json.set("mq6/digital",  mq6Digital);
  json.set("mq6/status",   mq6Digital ? "BAHAYA" : "AMAN");
  json.set("mq3/analog",   mq3Analog);
  json.set("mq3/digital",  mq3Digital);
  json.set("mq3/status",   mq3Digital ? "BAHAYA" : "AMAN");
  json.set("relay/fan",    fanState ? "ON" : "OFF");
  json.set("relay/uv",     uvState  ? "ON" : "OFF");
  json.set("relay/fan_mode", fanManual ? "MANUAL" : "AUTO");
  json.set("relay/uv_mode",  uvManual  ? "MANUAL" : "AUTO");

  bool anyGas = mq8Digital || mq6Digital || mq3Digital ||
                (mq8Analog > GAS_ANALOG_THRESHOLD) ||
                (mq6Analog > GAS_ANALOG_THRESHOLD) ||
                (mq3Analog > GAS_ANALOG_THRESHOLD);
  json.set("status/gas_alert",  anyGas ? "BAHAYA" : "AMAN");
  json.set("status/temp_alert", (temperature >= TEMP_FAN_THRESHOLD) ? "PANAS"  : "NORMAL");
  json.set("status/hum_alert",  (humidity >= HUMIDITY_UV_THRESHOLD) ? "LEMBAB" : "NORMAL");
  json.set("timestamp", (int)millis());

  // ✅ Semua data dikirim ke dalam /steriflow-001/sensorData
  if (Firebase.setJSON(fbdo, path("/sensorData"), json)) {
    Serial.println("✓ Firebase terkirim → /" + String(DEVICE_ID) + "/sensorData");
  } else {
    Serial.println("✗ Firebase error: " + fbdo.errorReason());
  }
}

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== SteriFlow IoT System ===");
  Serial.println("Device ID: " + String(DEVICE_ID));

  pinMode(MQ8_DIGITAL_PIN, INPUT);
  pinMode(MQ6_DIGITAL_PIN, INPUT);
  pinMode(MQ3_DIGITAL_PIN, INPUT);

  pinMode(RELAY_FAN_PIN, OUTPUT);
  pinMode(RELAY_UV_PIN,  OUTPUT);
  digitalWrite(RELAY_FAN_PIN, RELAY_OFF);
  digitalWrite(RELAY_UV_PIN,  RELAY_OFF);

  dht.begin();
  delay(2000);

  connectWiFi();
  connectFirebase();

  printMenu();
  Serial.println("\n✓ Sistem siap! Ketik perintah di Serial Monitor\n");
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
