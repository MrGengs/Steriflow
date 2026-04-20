// ============================================================
//   SteriFlow — ESP32-CAM Streamer
//   - WiFi + Firebase RTDB (register IP ke /{DEVICE_ID}/camera)
//   - HTTP MJPEG stream  : http://<ip>/stream
//   - HTTP single JPEG   : http://<ip>/capture
//   Board: AI-Thinker ESP32-CAM
// ============================================================

#include <WiFi.h>
#include <FirebaseESP32.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "esp_timer.h"
#include "img_converters.h"
#include <mbedtls/base64.h>

// ==================== KONFIGURASI ====================
#define WIFI_SSID       "Steriflow Station"
#define WIFI_PASSWORD   "steriflow331"

#define FIREBASE_HOST   "steriflow-id-default-rtdb.asia-southeast1.firebasedatabase.app"
#define FIREBASE_AUTH   "Aj1KCC0TwMdyxOj21FS0DX5V2wCqXl3xp3jt0JMH"

// Harus sama dengan DEVICE_ID yang dibaca web app (steriflow-001, steriflow-002, dst)
#define DEVICE_ID       "steriflow-001"

#define HEARTBEAT_MS    15000   // update lastSeen tiap 15 detik

// ==================== PIN KAMERA (AI-THINKER) ====================
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

// ==================== OBJEK FIREBASE ====================
FirebaseData     fbdo;
FirebaseAuth     fbAuth;
FirebaseConfig   fbConfig;

// ==================== HTTP SERVER ====================
// Dua instance httpd: (1) port 80 = / + /capture (cepat & singkat),
// (2) port 81 = /stream (long-running MJPEG di thread sendiri).
// Tujuan: handler /stream yang berputar di while(true) tidak pernah
// menggantung thread /capture.
httpd_handle_t camera_httpd = NULL;
httpd_handle_t stream_httpd = NULL;

#define PART_BOUNDARY "steriflowframe"
static const char* STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char* STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// ==================== CORS HELPER ====================
static void set_cors(httpd_req_t *req) {
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin",  "*");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, OPTIONS");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "*");
}

static esp_err_t options_handler(httpd_req_t *req) {
  set_cors(req);
  httpd_resp_set_status(req, "204 No Content");
  httpd_resp_send(req, NULL, 0);
  return ESP_OK;
}

// ==================== HANDLER: /  (halaman info) ====================
static esp_err_t index_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  set_cors(req);
  String ip = WiFi.localIP().toString();
  String body =
    String("<html><head><title>SteriFlow ESP32-CAM</title></head><body>"
           "<h2>SteriFlow ESP32-CAM</h2>"
           "<p><a href=\"http://") + ip + ":81/stream\">stream (:81)</a> &middot; "
           "<a href=\"/capture\">/capture</a></p>"
           "<img src=\"http://" + ip + ":81/stream\" style=\"max-width:100%;border:1px solid #ccc\"/>"
           "</body></html>";
  return httpd_resp_send(req, body.c_str(), body.length());
}

// ==================== HANDLER: /capture  (JPEG tunggal) ====================
static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAM] capture fail");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  set_cors(req);

  esp_err_t res = ESP_OK;
  if (fb->format == PIXFORMAT_JPEG) {
    res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  } else {
    uint8_t *jpg = NULL;
    size_t   jpg_len = 0;
    bool ok = frame2jpg(fb, 80, &jpg, &jpg_len);
    if (ok) {
      res = httpd_resp_send(req, (const char *)jpg, jpg_len);
      free(jpg);
    } else {
      res = ESP_FAIL;
    }
  }
  esp_camera_fb_return(fb);
  return res;
}

// ==================== HANDLER: /stream  (MJPEG) ====================
static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t *fb = NULL;
  char part_buf[64];

  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  set_cors(req);
  httpd_resp_set_hdr(req, "X-Framerate", "30");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) { res = ESP_FAIL; break; }

    uint8_t *jpg_buf = NULL;
    size_t   jpg_len = 0;
    bool     allocated_jpg = false;

    if (fb->format != PIXFORMAT_JPEG) {
      if (!frame2jpg(fb, 80, &jpg_buf, &jpg_len)) {
        esp_camera_fb_return(fb);
        res = ESP_FAIL;
        break;
      }
      allocated_jpg = true;
    } else {
      jpg_buf = fb->buf;
      jpg_len = fb->len;
    }

    size_t hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART, (unsigned)jpg_len);
    if (httpd_resp_send_chunk(req, part_buf, hlen) != ESP_OK) { res = ESP_FAIL; }
    if (res == ESP_OK && httpd_resp_send_chunk(req, (const char *)jpg_buf, jpg_len) != ESP_OK) { res = ESP_FAIL; }
    if (res == ESP_OK && httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY)) != ESP_OK) { res = ESP_FAIL; }

    if (allocated_jpg) free(jpg_buf);
    esp_camera_fb_return(fb);
    if (res != ESP_OK) break;
  }
  return res;
}

// ==================== START HTTP SERVERS ====================
void startCameraServer() {
  // --- Port 80: index + capture (handlers singkat, tidak blocking) ---
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port      = 80;
  cfg.ctrl_port        = 32768;
  cfg.max_uri_handlers = 4;
  cfg.stack_size       = 8192;

  httpd_uri_t u_index    = { .uri = "/",        .method = HTTP_GET,     .handler = index_handler,   .user_ctx = NULL };
  httpd_uri_t u_capture  = { .uri = "/capture", .method = HTTP_GET,     .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t u_opt_cap  = { .uri = "/capture", .method = HTTP_OPTIONS, .handler = options_handler, .user_ctx = NULL };

  if (httpd_start(&camera_httpd, &cfg) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &u_index);
    httpd_register_uri_handler(camera_httpd, &u_capture);
    httpd_register_uri_handler(camera_httpd, &u_opt_cap);
    Serial.println("[HTTP] main httpd OK :80 → / , /capture");
  } else {
    Serial.println("[HTTP] main httpd start FAIL");
  }

  // --- Port 81: /stream (long-running MJPEG di thread terpisah) ---
  httpd_config_t scfg = HTTPD_DEFAULT_CONFIG();
  scfg.server_port      = 81;
  scfg.ctrl_port        = 32769;
  scfg.max_uri_handlers = 2;
  scfg.stack_size       = 8192;

  httpd_uri_t u_stream   = { .uri = "/stream", .method = HTTP_GET,     .handler = stream_handler,  .user_ctx = NULL };
  httpd_uri_t u_opt_strm = { .uri = "/stream", .method = HTTP_OPTIONS, .handler = options_handler, .user_ctx = NULL };

  if (httpd_start(&stream_httpd, &scfg) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &u_stream);
    httpd_register_uri_handler(stream_httpd, &u_opt_strm);
    Serial.println("[HTTP] stream httpd OK :81 → /stream");
  } else {
    Serial.println("[HTTP] stream httpd start FAIL");
  }
}

// ==================== KAMERA INIT ====================
bool initCamera() {
  camera_config_t c;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0       = Y2_GPIO_NUM;
  c.pin_d1       = Y3_GPIO_NUM;
  c.pin_d2       = Y4_GPIO_NUM;
  c.pin_d3       = Y5_GPIO_NUM;
  c.pin_d4       = Y6_GPIO_NUM;
  c.pin_d5       = Y7_GPIO_NUM;
  c.pin_d6       = Y8_GPIO_NUM;
  c.pin_d7       = Y9_GPIO_NUM;
  c.pin_xclk     = XCLK_GPIO_NUM;
  c.pin_pclk     = PCLK_GPIO_NUM;
  c.pin_vsync    = VSYNC_GPIO_NUM;
  c.pin_href     = HREF_GPIO_NUM;
  c.pin_sscb_sda = SIOD_GPIO_NUM;
  c.pin_sscb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn     = PWDN_GPIO_NUM;
  c.pin_reset    = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    c.frame_size   = FRAMESIZE_VGA;   // 640x480 — cukup untuk AI + ringan
    c.jpeg_quality = 10;              // 0 (best) – 63 (worst)
    c.fb_count     = 2;
    c.grab_mode    = CAMERA_GRAB_LATEST;
    c.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    c.frame_size   = FRAMESIZE_QVGA;  // 320x240 (no PSRAM)
    c.jpeg_quality = 12;
    c.fb_count     = 1;
    c.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
    c.fb_location  = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("[CAM] init gagal: 0x%x\n", err);
    return false;
  }

  // Tweak sensor — flip & warna wajar
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    // Rotate 180° (vflip + hmirror keduanya aktif)
    s->set_vflip(s, 1);
    s->set_hmirror(s, 1);
    s->set_brightness(s, 0);
    s->set_saturation(s, 0);
  }
  Serial.println("[CAM] init OK");
  return true;
}

// ==================== WIFI ====================
void connectWiFi() {
  Serial.printf("[WIFI] connect ke %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // penting untuk stream lancar
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500);
    Serial.print(".");
    tries++;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[WIFI] gagal konek, restart...");
    ESP.restart();
  }
  Serial.printf("\n[WIFI] OK — IP: %s\n", WiFi.localIP().toString().c_str());
}

// ==================== FIREBASE ====================
void connectFirebase() {
  fbConfig.host = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;
  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(2048);
  Serial.println("[FB] ready");
}

void publishCameraInfo() {
  String ip         = WiFi.localIP().toString();
  // /stream pindah ke port 81 supaya tidak mengunci thread /capture di port 80.
  String streamUrl  = "http://" + ip + ":81/stream";
  String captureUrl = "http://" + ip + "/capture";
  String base       = String("/") + DEVICE_ID + "/camera";

  FirebaseJson json;
  json.set("ip",         ip);
  json.set("streamUrl",  streamUrl);
  json.set("captureUrl", captureUrl);
  json.set("online",     true);
  json.set("lastSeen",   (int)(millis() / 1000));
  json.set("rssi",       WiFi.RSSI());

  if (Firebase.setJSON(fbdo, base, json)) {
    Serial.println("[FB] camera info terkirim:");
    Serial.println("     " + streamUrl);
    Serial.println("     " + captureUrl);
  } else {
    Serial.println("[FB] setJSON error: " + fbdo.errorReason());
  }
}

void heartbeat() {
  String base = String("/") + DEVICE_ID + "/camera";
  Firebase.setBool(fbdo, base + "/online",   true);
  Firebase.setInt (fbdo, base + "/lastSeen", (int)(millis() / 1000));
  Firebase.setInt (fbdo, base + "/rssi",     WiFi.RSSI());
}

// ==================== HTTPS CAPTURE BRIDGE ====================
// Web app di HTTPS tidak bisa fetch langsung ke /capture HTTP.
// Jadi web menulis nilai ke /{DEVICE_ID}/camera/captureRequest (int detik),
// dan ESP menulis JPEG hasil capture (base64) ke /{DEVICE_ID}/camera/lastCapture.

int  lastCaptureRequestTs   = 0;
unsigned long lastCapCheckMs = 0;
#define CAPTURE_POLL_MS       700

bool processCaptureRequest(int ts) {
  Serial.printf("[CAP] request ts=%d — capturing JPEG...\n", ts);
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAP] esp_camera_fb_get() gagal");
    return false;
  }

  uint8_t* jpg = nullptr;
  size_t   jpgLen = 0;
  bool allocatedJpg = false;
  if (fb->format == PIXFORMAT_JPEG) {
    jpg = fb->buf;
    jpgLen = fb->len;
  } else {
    allocatedJpg = frame2jpg(fb, 80, &jpg, &jpgLen);
    if (!allocatedJpg) {
      Serial.println("[CAP] frame2jpg gagal");
      esp_camera_fb_return(fb);
      return false;
    }
  }

  // Encode base64 (mbedtls)
  size_t outLen = 0;
  mbedtls_base64_encode(nullptr, 0, &outLen, jpg, jpgLen);
  char* b64 = (char*)malloc(outLen + 1);
  if (!b64) {
    Serial.println("[CAP] malloc b64 gagal");
    if (allocatedJpg) free(jpg);
    esp_camera_fb_return(fb);
    return false;
  }
  size_t actualLen = 0;
  int rc = mbedtls_base64_encode((unsigned char*)b64, outLen, &actualLen, jpg, jpgLen);
  if (rc != 0) {
    Serial.printf("[CAP] base64 encode rc=%d\n", rc);
    free(b64);
    if (allocatedJpg) free(jpg);
    esp_camera_fb_return(fb);
    return false;
  }
  b64[actualLen] = 0;

  String base = String("/") + DEVICE_ID + "/camera/lastCapture";
  FirebaseJson json;
  json.set("timestamp", ts);
  json.set("width",     (int)fb->width);
  json.set("height",    (int)fb->height);
  json.set("size",      (int)jpgLen);
  json.set("data",      b64);

  unsigned long t0 = millis();
  bool ok = Firebase.setJSON(fbdo, base, json);
  unsigned long dt = millis() - t0;
  Serial.printf("[CAP] upload %s dalam %lums (jpg=%u, b64=%u bytes)\n",
                ok ? "OK" : "FAIL", dt, (unsigned)jpgLen, (unsigned)actualLen);
  if (!ok) Serial.println("[CAP] Firebase: " + fbdo.errorReason());

  free(b64);
  if (allocatedJpg) free(jpg);
  esp_camera_fb_return(fb);
  return ok;
}

void pollCaptureRequest() {
  if (millis() - lastCapCheckMs < CAPTURE_POLL_MS) return;
  lastCapCheckMs = millis();

  String path = String("/") + DEVICE_ID + "/camera/captureRequest";
  if (!Firebase.getInt(fbdo, path)) return;   // path kosong / gagal → diam
  int ts = fbdo.intData();
  if (ts <= 0 || ts == lastCaptureRequestTs) return;
  lastCaptureRequestTs = ts;
  processCaptureRequest(ts);
}

// ==================== LIVE STREAM via RTDB PUSH ====================
// Web HTTPS tidak bisa load MJPEG HTTP. Maka ESP "push" frame ke
// /{DEVICE_ID}/camera/livePreview setiap STREAM_FRAME_MS selama
// /{DEVICE_ID}/camera/streamRequest diperbarui (keep-alive timestamp).
// Web subscribe onValue(livePreview) → cameraImg.src update otomatis.

#define STREAM_CHECK_MS         400    // cek streamRequest tiap 400ms
#define STREAM_FRAME_MS         700    // target ~1.4 fps
#define STREAM_STALE_TIMEOUT_MS 8000   // streamRequest "basi" jika tidak update 8s → stop

int          streamReqLastTs       = 0;
unsigned long streamReqChangedAt   = 0;
unsigned long lastStreamCheckMs    = 0;
unsigned long lastStreamFrameMs    = 0;

bool publishStreamFrame() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) return false;

  uint8_t *jpg = nullptr;
  size_t   jpgLen = 0;
  bool allocatedJpg = false;
  if (fb->format == PIXFORMAT_JPEG) {
    jpg = fb->buf;
    jpgLen = fb->len;
  } else {
    allocatedJpg = frame2jpg(fb, 80, &jpg, &jpgLen);
    if (!allocatedJpg) { esp_camera_fb_return(fb); return false; }
  }

  size_t outLen = 0;
  mbedtls_base64_encode(nullptr, 0, &outLen, jpg, jpgLen);
  char* b64 = (char*)malloc(outLen + 1);
  if (!b64) { if (allocatedJpg) free(jpg); esp_camera_fb_return(fb); return false; }
  size_t actualLen = 0;
  if (mbedtls_base64_encode((unsigned char*)b64, outLen, &actualLen, jpg, jpgLen) != 0) {
    free(b64); if (allocatedJpg) free(jpg); esp_camera_fb_return(fb); return false;
  }
  b64[actualLen] = 0;

  String base = String("/") + DEVICE_ID + "/camera/livePreview";
  FirebaseJson json;
  json.set("timestamp", (int)(millis() / 1000));
  json.set("width",     (int)fb->width);
  json.set("height",    (int)fb->height);
  json.set("size",      (int)jpgLen);
  json.set("data",      b64);
  bool ok = Firebase.setJSON(fbdo, base, json);

  free(b64);
  if (allocatedJpg) free(jpg);
  esp_camera_fb_return(fb);
  return ok;
}

void pollLiveStream() {
  // Cek streamRequest berkala. Tiap perubahan dicatat waktu (web ping
  // tiap beberapa detik) sehingga kita tahu web masih aktif.
  if (millis() - lastStreamCheckMs >= STREAM_CHECK_MS) {
    lastStreamCheckMs = millis();
    String path = String("/") + DEVICE_ID + "/camera/streamRequest";
    if (Firebase.getInt(fbdo, path)) {
      int v = fbdo.intData();
      if (v != streamReqLastTs) {
        streamReqLastTs = v;
        streamReqChangedAt = millis();
        Serial.printf("[STREAM] request ts=%d\n", v);
      }
    }
  }

  bool streaming = (streamReqLastTs > 0)
                   && (millis() - streamReqChangedAt < STREAM_STALE_TIMEOUT_MS);
  if (!streaming) return;

  if (millis() - lastStreamFrameMs >= STREAM_FRAME_MS) {
    lastStreamFrameMs = millis();
    unsigned long t0 = millis();
    bool ok = publishStreamFrame();
    unsigned long dt = millis() - t0;
    Serial.printf("[STREAM] frame %s dalam %lums\n", ok ? "OK" : "FAIL", dt);
  }
}

// ==================== SETUP / LOOP ====================
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(false);
  delay(300);
  Serial.println("\n=== SteriFlow ESP32-CAM ===");

  if (!initCamera()) {
    delay(3000);
    ESP.restart();
  }

  connectWiFi();
  connectFirebase();
  publishCameraInfo();
  startCameraServer();

  Serial.println("\nSiap! Buka di browser:");
  Serial.printf("  http://%s/          (index)\n",     WiFi.localIP().toString().c_str());
  Serial.printf("  http://%s/capture   (JPEG snapshot, port 80)\n", WiFi.localIP().toString().c_str());
  Serial.printf("  http://%s:81/stream (MJPEG, port 81 terpisah)\n", WiFi.localIP().toString().c_str());
}

void loop() {
  static unsigned long lastBeat = 0;

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] putus, reconnect...");
    connectWiFi();
    publishCameraInfo();
  }

  unsigned long now = millis();
  if (now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    heartbeat();
  }

  // Poll permintaan capture dari web (scan single-shot, HTTPS bridge).
  pollCaptureRequest();
  // Push frame live ke RTDB selama ada keep-alive dari web.
  pollLiveStream();

  delay(50);
}
