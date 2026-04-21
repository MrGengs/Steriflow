/*
  SteriFlow - ESP32-CAM (Supabase Storage + Postgres)
  Board: AI-Thinker ESP32-CAM

  Alur:
    - Connect WiFi.
    - Serve MJPEG di http://<IP>/stream    (LAN-only, live view)
    - Serve JPEG  di http://<IP>/capture   (snapshot satu frame)
    - Tombol di GPIO 13 ditekan:
        1. Capture JPEG dari kamera.
        2. Upload binary JPEG ke Supabase Storage:
             POST https://<host>/storage/v1/object/captures/<filename>
        3. INSERT row ke Postgres table 'captures' via PostgREST:
             POST https://<host>/rest/v1/captures
             body { url, path, size, ip, device }
    - Web listen realtime ke table 'captures' -> auto render <img>.

  Project ini pakai Supabase project "vita-steriflow".
  Lihat SETUP_SUPABASE.md untuk panduan setup dashboard.
*/

#include "esp_camera.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include <EEPROM.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <esp_http_server.h>

// ====== KONFIGURASI WIFI ======
const char* WIFI_SSID     = "Vita Station";
const char* WIFI_PASSWORD = "vita1357";

// ====== KONFIGURASI SUPABASE ======
const char* SUPABASE_HOST   = "jonpztihoxuzzdjneoqv.supabase.co"; // tanpa https://
const char* SUPABASE_BUCKET = "captures";
const char* DEVICE_ID       = "Vita-001";

// anon public key (JWT). Aman ditaruh di client/ESP32, dikontrol oleh RLS.
const char* SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpvbnB6dGlob3h1enpkam5lb3F2Iiwicm9sZSI6"
  "ImFub24iLCJpYXQiOjE3NzY3ODI0NTksImV4cCI6MjA5MjM1ODQ1OX0."
  "JKszK9PY_IpxEOtaRy_kuD0jJyiB4Lg40sQGOs9HvVc";

// ====== KONFIGURASI FIREBASE RTDB (device registry + lock) ======
// Dipakai untuk publish IP ESP32 + status online. Web nulis lockedBy di sini.
const char* RTDB_HOST = "vita-id-default-rtdb.asia-southeast1.firebasedatabase.app";
const char* RTDB_AUTH = "Fk70LW7wgK21TyIkNxqDWGjNR97Ydn7BYa4mrQgN";

// ====== PIN KAMERA (AI-Thinker ESP32-CAM) ======
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ====== PIN EKSTERNAL ======
#define BUTTON_PIN        13
#define FLASH_LED_PIN      4

// ====== KONSTANTA ======
#define EEPROM_SIZE        4
#define DEBOUNCE_MS       50
#define HEARTBEAT_MS      30000UL   // update RTDB tiap 30 detik

int pictureNumber = 0;
unsigned long lastHeartbeat = 0;
httpd_handle_t http_server = NULL;

// ---------- UTIL ----------
void blinkFlash(int times, int onMs = 80, int offMs = 120) {
  for (int i = 0; i < times; i++) {
    digitalWrite(FLASH_LED_PIN, HIGH); delay(onMs);
    digitalWrite(FLASH_LED_PIN, LOW);  delay(offMs);
  }
}

// ---------- KAMERA ----------
bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  bool hasPsram = psramFound();
  Serial.printf("PSRAM: %s\n", hasPsram ? "YES" : "NO");

  if (hasPsram) {
    config.frame_size   = FRAMESIZE_UXGA;  // 1600x1200
    config.jpeg_quality = 10;
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    // Tanpa PSRAM: frame buffer di DRAM, ukuran wajib kecil.
    config.frame_size   = FRAMESIZE_SVGA;  // 800x600
    config.jpeg_quality = 12;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    // Fallback bertahap: coba resolusi makin kecil kalau alokasi gagal.
    Serial.printf("Camera init gagal 0x%x, retry lebih kecil...\n", err);
    config.frame_size   = FRAMESIZE_VGA;   // 640x480
    config.jpeg_quality = 14;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    err = esp_camera_init(&config);
  }
  if (err != ESP_OK) {
    Serial.printf("Camera init gagal lagi 0x%x, retry QVGA...\n", err);
    config.frame_size   = FRAMESIZE_QVGA;  // 320x240
    config.jpeg_quality = 15;
    err = esp_camera_init(&config);
  }
  if (err != ESP_OK) {
    Serial.printf("Camera init FINAL FAILED 0x%x\n", err);
    return false;
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s) {
    Serial.printf("Sensor PID=0x%02x\n", s->id.PID);
    // Rotate 180 + mirror horizontal = vertical flip saja
    s->set_vflip(s, 1);
    s->set_hmirror(s, 0);
  }
  return true;
}

// ---------- WIFI ----------
bool connectWifi(uint32_t timeoutMs = 20000) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to %s", WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(400); Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) { Serial.println("WiFi GAGAL"); return false; }
  Serial.print("WiFi OK. IP: "); Serial.println(WiFi.localIP());
  return true;
}

// ---------- PUSH DEVICE INFO KE FIREBASE RTDB ----------
// PATCH (merge) supaya field 'lockedBy' yang ditulis web tidak tertimpa.
bool pushDeviceInfo() {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client; client.setInsecure();
  HTTPClient https;

  String url = String("https://") + RTDB_HOST +
               "/" + DEVICE_ID + ".json";
  if (strlen(RTDB_AUTH) > 0) { url += "?auth="; url += RTDB_AUTH; }

  if (!https.begin(client, url)) return false;
  https.addHeader("Content-Type", "application/json");

  String ip = WiFi.localIP().toString();
  String payload = "{";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\",";
  payload += "\"ip\":\"" + ip + "\",";
  payload += "\"mac\":\"" + WiFi.macAddress() + "\",";
  payload += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  payload += "\"online\":true,";
  payload += "\"streamUrl\":\"http://" + ip + "/stream\",";
  payload += "\"captureUrl\":\"http://" + ip + "/capture\",";
  payload += "\"lastSeen\":{\".sv\":\"timestamp\"}";
  payload += "}";

  int code = https.PATCH(payload);
  Serial.printf("RTDB /%s PATCH -> %d\n", DEVICE_ID, code);
  https.end();
  return code == 200;
}

// ---------- UPLOAD JPEG KE SUPABASE STORAGE ----------
// Return public URL kalau sukses, "" kalau gagal.
String uploadToSupabase(const uint8_t* data, size_t len, const String& filename) {
  if (WiFi.status() != WL_CONNECTED) return "";

  WiFiClientSecure client; client.setInsecure();
  HTTPClient https;
  String url = String("https://") + SUPABASE_HOST +
               "/storage/v1/object/" + SUPABASE_BUCKET + "/" + filename;

  if (!https.begin(client, url)) { Serial.println("Storage begin gagal"); return ""; }
  https.addHeader("apikey", SUPABASE_ANON);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  https.addHeader("Content-Type", "image/jpeg");
  https.addHeader("x-upsert", "true");

  int code = https.POST((uint8_t*)data, len);
  String resp = https.getString();
  https.end();
  Serial.printf("Storage POST %s -> %d\n", url.c_str(), code);

  if (code != 200 && code != 201) {
    Serial.println(resp);
    return "";
  }
  // URL publik (bucket harus Public di dashboard)
  return String("https://") + SUPABASE_HOST +
         "/storage/v1/object/public/" + SUPABASE_BUCKET + "/" + filename;
}

// ---------- INSERT ROW KE TABEL captures ----------
bool insertCaptureRow(const String& publicUrl, const String& path, size_t size) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client; client.setInsecure();
  HTTPClient https;
  String url = String("https://") + SUPABASE_HOST + "/rest/v1/captures";
  if (!https.begin(client, url)) return false;

  https.addHeader("apikey", SUPABASE_ANON);
  https.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON);
  https.addHeader("Content-Type", "application/json");
  https.addHeader("Prefer", "return=minimal");

  String ip = WiFi.localIP().toString();
  String body;
  body.reserve(publicUrl.length() + 256);
  body  = "{\"url\":\"" + publicUrl + "\",";
  body += "\"path\":\"" + path + "\",";
  body += "\"size\":" + String((unsigned)size) + ",";
  body += "\"ip\":\"" + ip + "\",";
  body += "\"device\":\"" + String(DEVICE_ID) + "\",";
  body += "\"source\":\"esp32cam\"}";

  int code = https.POST(body);
  String resp = https.getString();
  https.end();
  Serial.printf("Insert captures row -> %d\n", code);
  if (code != 201 && code != 200) Serial.println(resp);
  return (code == 201 || code == 200);
}

// ---------- FLOW TOMBOL: CAPTURE -> UPLOAD -> INSERT ----------
void handleCaptureButton() {
  // buang 1 frame biar AE/AWB stabil
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();
  if (!fb) { Serial.println("Capture gagal"); blinkFlash(5, 40, 40); return; }

  pictureNumber++;
  EEPROM.write(0, pictureNumber & 0xFF);
  EEPROM.write(1, (pictureNumber >> 8) & 0xFF);
  EEPROM.commit();

  // Nama file unik: Vita-001_<pictureNumber>_<millis>.jpg
  String filename = String(DEVICE_ID) + "_" + String(pictureNumber) +
                    "_" + String(millis()) + ".jpg";

  Serial.printf("Foto #%d, %u bytes -> %s\n",
                pictureNumber, (unsigned)fb->len, filename.c_str());

  String publicUrl = uploadToSupabase(fb->buf, fb->len, filename);
  size_t rawSize = fb->len;
  esp_camera_fb_return(fb);

  if (publicUrl.length() == 0) {
    Serial.println("Upload Storage GAGAL");
    blinkFlash(5, 40, 40);
    return;
  }
  Serial.println("URL: " + publicUrl);

  if (insertCaptureRow(publicUrl, filename, rawSize)) {
    Serial.println("DONE: foto muncul di web.");
    blinkFlash(2, 100, 80);
  } else {
    Serial.println("Insert row GAGAL (foto sudah di Storage tapi tidak muncul di tabel).");
    blinkFlash(4, 60, 80);
  }
}

// ---------- HTTP HANDLERS (stream/capture/info) ----------
static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { httpd_resp_send_500(req); return ESP_FAIL; }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char*)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

#define PART_BOUNDARY "frameboundary"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {
  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  char part[64];
  while (true) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) { res = ESP_FAIL; break; }
    size_t hlen = snprintf(part, sizeof(part), STREAM_PART, fb->len);
    if (httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY)) != ESP_OK) { esp_camera_fb_return(fb); break; }
    if (httpd_resp_send_chunk(req, part, hlen) != ESP_OK) { esp_camera_fb_return(fb); break; }
    if (httpd_resp_send_chunk(req, (const char*)fb->buf, fb->len) != ESP_OK) { esp_camera_fb_return(fb); break; }
    esp_camera_fb_return(fb);
    delay(30);
  }
  return res;
}

static esp_err_t info_handler(httpd_req_t *req) {
  String body = "{\"ip\":\"" + WiFi.localIP().toString() +
                "\",\"mac\":\"" + WiFi.macAddress() +
                "\",\"rssi\":" + String(WiFi.RSSI()) +
                ",\"device\":\"" + String(DEVICE_ID) +
                "\",\"pictures\":" + String(pictureNumber) + "}";
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, body.c_str(), body.length());
}

void startHttpServer() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  httpd_uri_t u_capture = { "/capture", HTTP_GET, capture_handler, NULL };
  httpd_uri_t u_stream  = { "/stream",  HTTP_GET, stream_handler,  NULL };
  httpd_uri_t u_info    = { "/info",    HTTP_GET, info_handler,    NULL };
  if (httpd_start(&http_server, &cfg) == ESP_OK) {
    httpd_register_uri_handler(http_server, &u_capture);
    httpd_register_uri_handler(http_server, &u_stream);
    httpd_register_uri_handler(http_server, &u_info);
    Serial.println("HTTP :80  /stream /capture /info");
  }
}

// ---------- SETUP ----------
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  Serial.begin(115200); delay(200);
  Serial.println("\n=== SteriFlow ESP32-CAM (Supabase) ===");

  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  if (!initCamera()) { while (true) blinkFlash(1, 60, 940); }

  EEPROM.begin(EEPROM_SIZE);
  pictureNumber = EEPROM.read(0) | (EEPROM.read(1) << 8);
  if (pictureNumber < 0 || pictureNumber > 60000) pictureNumber = 0;

  if (connectWifi()) {
    startHttpServer();
    pushDeviceInfo();
    lastHeartbeat = millis();
    blinkFlash(3, 60, 100);
  }
  Serial.println("Siap. Tekan tombol untuk memotret.");
}

// ---------- LOOP ----------
void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi(10000);

  if (WiFi.status() == WL_CONNECTED && (millis() - lastHeartbeat) > HEARTBEAT_MS) {
    pushDeviceInfo();
    lastHeartbeat = millis();
  }

  static uint32_t lastChange = 0;
  static int lastStable = HIGH, lastRead = HIGH;
  int r = digitalRead(BUTTON_PIN);
  if (r != lastRead) { lastRead = r; lastChange = millis(); }
  if ((millis() - lastChange) > DEBOUNCE_MS && r != lastStable) {
    lastStable = r;
    if (lastStable == LOW) {
      Serial.println("Tombol ditekan -> capture + upload Supabase");
      handleCaptureButton();
    }
  }
}
