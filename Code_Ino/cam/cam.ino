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
httpd_handle_t camera_httpd = NULL;

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
  const char* html =
    "<html><head><title>SteriFlow ESP32-CAM</title></head><body>"
    "<h2>SteriFlow ESP32-CAM</h2>"
    "<p><a href=\"/stream\">/stream</a> &middot; <a href=\"/capture\">/capture</a></p>"
    "<img src=\"/stream\" style=\"max-width:100%;border:1px solid #ccc\"/>"
    "</body></html>";
  return httpd_resp_send(req, html, strlen(html));
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

// ==================== START HTTP SERVER ====================
void startCameraServer() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port      = 80;
  cfg.ctrl_port        = 32768;
  cfg.max_uri_handlers = 8;
  cfg.stack_size       = 8192;

  httpd_uri_t u_index    = { .uri = "/",        .method = HTTP_GET,     .handler = index_handler,   .user_ctx = NULL };
  httpd_uri_t u_capture  = { .uri = "/capture", .method = HTTP_GET,     .handler = capture_handler, .user_ctx = NULL };
  httpd_uri_t u_stream   = { .uri = "/stream",  .method = HTTP_GET,     .handler = stream_handler,  .user_ctx = NULL };
  httpd_uri_t u_opt_cap  = { .uri = "/capture", .method = HTTP_OPTIONS, .handler = options_handler, .user_ctx = NULL };
  httpd_uri_t u_opt_strm = { .uri = "/stream",  .method = HTTP_OPTIONS, .handler = options_handler, .user_ctx = NULL };

  if (httpd_start(&camera_httpd, &cfg) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &u_index);
    httpd_register_uri_handler(camera_httpd, &u_capture);
    httpd_register_uri_handler(camera_httpd, &u_stream);
    httpd_register_uri_handler(camera_httpd, &u_opt_cap);
    httpd_register_uri_handler(camera_httpd, &u_opt_strm);
    Serial.println("[HTTP] server running on port 80");
  } else {
    Serial.println("[HTTP] server start failed");
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
  String streamUrl  = "http://" + ip + "/stream";
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
  Serial.printf("  http://%s/\n",        WiFi.localIP().toString().c_str());
  Serial.printf("  http://%s/stream\n",  WiFi.localIP().toString().c_str());
  Serial.printf("  http://%s/capture\n", WiFi.localIP().toString().c_str());
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
  delay(50);
}
