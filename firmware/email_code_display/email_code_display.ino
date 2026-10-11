#include "power_policy.h"
#include "secrets.h"
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <time.h>

// Retain Wi-Fi association and verified TLS; reconnecting each poll costs
// energy.
extern const uint8_t
    x509_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t x509_crt_bundle_end[] asm("_binary_x509_crt_bundle_end");
Adafruit_ST7789 tft(TFT_CS, TFT_DC, TFT_RST);
WiFiClientSecure tls;
HTTPClient http;
String codeId, code, service, provider, dismissedId, pendingDismissId,
    expiredId;
uint32_t remainingMs = 0, lastTick = 0, lastPoll = 0, lastReconnect = 0,
         screenActivity = 0;
uint32_t pollInterval = POLL_MS, reconnectInterval = 15000;
bool pressed = false, screenSleeping = false, backlightPwm = false;
bool wasConnected = false, wasClockReady = false, pollNow = true;
uint8_t brightness = 0;
int batteryPercent = -1;
uint32_t lastBatteryRead = 0;
const uint16_t BG = 0x0945, MINT = 0xC758, MUTED = 0x6D10;

// Read the onboard MAX17048 without resetting its learned charge state.
bool readBatteryRegister(uint8_t reg, uint16_t &value) {
  Wire.beginTransmission(0x36);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0 ||
      Wire.requestFrom(uint8_t(0x36), uint8_t(2)) != 2)
    return false;
  value = uint16_t(Wire.read()) << 8;
  value |= Wire.read();
  return true;
}
void renderBattery() {
  if (screenSleeping)
    return;
  tft.fillRect(214, 9, 20, 10, BG);
  uint16_t color = batteryPercent >= 0 && batteryPercent <= 20
                       ? ST77XX_RED : MUTED;
  tft.drawRect(215, 10, 16, 8, color);
  tft.fillRect(231, 12, 2, 4, color);
  if (batteryPercent < 0)
    tft.drawFastHLine(220, 14, 6, MUTED);
  else if (batteryPercent > 0)
    tft.fillRect(217, 12, max(1, (batteryPercent * 12 + 50) / 100), 4,
                 batteryPercent <= 20 ? ST77XX_RED : MINT);
}
void updateBattery() {
  lastBatteryRead = millis();
  uint16_t version, voltage, charge;
  int next = -1;
  if (readBatteryRegister(0x08, version) && (version & 0xFFF0) == 0x0010 &&
      readBatteryRegister(0x02, voltage) && voltage >= 25600 &&
      voltage <= 64000 && readBatteryRegister(0x04, charge))
    next = min(100, int((uint32_t(charge) + 128) / 256));
  if (next != batteryPercent) {
    batteryPercent = next;
    renderBattery();
  }
}

// Decode chunked HTTP/1.1 into a bounded sink. Consume the complete response
// before reusing a socket; close it on errors or oversized responses.
class ResponseBuffer : public Stream {
public:
  String value;
  size_t write(uint8_t c) override {
    if (value.length() >= 4096)
      return 0;
    return value.concat(char(c)) ? 1 : 0;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};
String ascii(String value) {
  String clean;
  for (size_t i = 0; i < value.length() && clean.length() < 32; i++)
    if (value[i] >= 32 && value[i] <= 126)
      clean += value[i];
  return clean;
}
void center(String text, int y, int size, uint16_t color) {
  tft.setTextSize(size);
  tft.setTextColor(color);
  tft.setCursor(max(4, (240 - int(text.length()) * 6 * size) / 2), y);
  tft.print(text);
}
void setBrightness(uint8_t level) {
  if (level == brightness)
    return;
  brightness = level;
  if (backlightPwm)
    ledcWrite(TFT_BACKLITE, level);
  else
    digitalWrite(TFT_BACKLITE, level ? HIGH : LOW);
}
void wakeScreen() {
  if (screenSleeping) {
    tft.enableSleep(false);
    delay(120);
    screenSleeping = false;
  }
}
void renderFooter() {
  if (screenSleeping || !code.length())
    return;
  tft.fillRect(0, 110, 240, 25, BG);
  center(ascii(provider) + "  /  " + String(remainingMs / 1000) + "s", 112, 1,
         MUTED);
}
void render() {
  if (screenSleeping)
    return;
  tft.fillScreen(BG);
  center("EMAIL CODE DISPLAY", 10, 1, MUTED);
  renderBattery();
  tft.drawFastHLine(12, 29, 216, MUTED);
  if (code.length()) {
    center(ascii(service), 40, 1, MINT);
    int size = min(5, 216 / int(code.length() * 6));
    center(code, 62, max(1, size), ST77XX_WHITE);
    renderFooter();
  } else {
    center(WiFi.status() == WL_CONNECTED ? "Ready for your next code"
                                         : "Connecting to Wi-Fi",
           58, 1, MINT);
    center(WiFi.status() == WL_CONNECTED ? "Gmail + Outlook" : "Please wait",
           86, 1, MUTED);
  }
}
void clearCode() {
  code = "";
  codeId = "";
  service = "";
  provider = "";
  remainingMs = 0;
  screenActivity = millis();
  render();
}
void tickCode() {
  uint32_t now = millis(), previous = remainingMs / 1000;
  remainingMs = countdown(remainingMs, now - lastTick);
  lastTick = now;
  if (code.length() && !remainingMs) {
    expiredId = codeId;
    clearCode();
  } else if (previous != remainingMs / 1000)
    renderFooter();
}
void updateScreenPower() {
  uint8_t level = screenBrightness(code.length(), millis() - screenActivity);
  setBrightness(level);
  if (!level) {
    if (!screenSleeping) {
      tft.enableSleep(true);
      screenSleeping = true;
    }
  }
}
int request(const String &path, JsonDocument &result, const String &body = "") {
  if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000)
    return -1;
  setCpuFrequencyMhz(240); // Race through TLS/JSON, then idle at 80 MHz.
  int status = -1;
  if (http.begin(tls, String(WORKER_URL) + path)) {
    http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
    if (body.length())
      http.addHeader("Content-Type", "application/json");
    status = body.length() ? http.POST(body) : http.GET();
    if (status == 200) {
      ResponseBuffer buffer;
      if (http.writeToStream(&buffer) < 0 ||
          deserializeJson(result, buffer.value) != DeserializationError::Ok)
        status = -2;
    }
    if (status != 200)
      tls.stop();
    http.end();
  }
  setCpuFrequencyMhz(80);
  tickCode(); // Account for blocking network time.
  return status;
}
bool fetchCode() {
  uint32_t started = millis();
  JsonDocument result;
  if (request("/api/device/code", result) != 200) {
    Serial.println("Service unavailable; retrying");
    return false;
  }
  if (result["code"].isNull()) {
    expiredId = "";
    if (!pendingDismissId.length())
      dismissedId = "";
    if (code.length())
      clearCode();
    return true;
  }
  String nextId = result["id"].as<String>();
  if (nextId == dismissedId || nextId == expiredId)
    return true;
  String nextCode = result["code"].as<String>();
  if (!nextId.length() || nextCode.length() < 4 || nextCode.length() > 12)
    return false;
  for (char c : nextCode)
    if (!isalnum(c) && c != ' ' && c != '-')
      return false;
  uint32_t seconds =
      min(uint32_t(300), result["remainingSeconds"].as<uint32_t>());
  uint32_t duration = countdown(seconds * 1000, millis() - started);
  if (!duration) {
    expiredId = nextId;
    clearCode();
    return true;
  }
  bool changed = nextId != codeId || nextCode != code;
  // Repeated responses must never extend an existing code's local deadline.
  remainingMs = changed ? duration : min(remainingMs, duration);
  codeId = nextId;
  code = nextCode;
  service = result["service"].as<String>();
  provider = result["provider"].as<String>();
  if (changed) {
    screenActivity = millis();
    wakeScreen();
    tickCode();
    updateScreenPower();
    render();
    Serial.println("Code received (value hidden)");
  }
  return true;
}
bool dismissPending() {
  if (!pendingDismissId.length())
    return true;
  JsonDocument payload, response;
  payload["id"] = pendingDismissId;
  String body;
  serializeJson(payload, body);
  if (request("/api/device/dismiss", response, body) != 200)
    return false;
  pendingDismissId = "";
  return true;
}
void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);
  pinMode(NEOPIXEL_POWER, OUTPUT);
  digitalWrite(NEOPIXEL_POWER, LOW);
  pinMode(TFT_BACKLITE, OUTPUT);
  digitalWrite(TFT_BACKLITE, LOW);
  pinMode(TFT_I2C_POWER, OUTPUT);
  digitalWrite(TFT_I2C_POWER, HIGH);
  delay(10);
  tft.init(135, 240);
  tft.setRotation(3);
  tft.setTextWrap(false);
  Wire.begin();
  Wire.setTimeOut(50);
  updateBattery();
  backlightPwm = ledcAttach(TFT_BACKLITE, 5000, 8);
  pinMode(0, INPUT_PULLUP);
  screenActivity = lastTick = millis();
  updateScreenPower();
  render();
  tls.setCACertBundle(x509_crt_bundle_start,
                      x509_crt_bundle_end - x509_crt_bundle_start);
  tls.setTimeout(5);
  tls.setHandshakeTimeout(5);
  http.useHTTP10(false);
  http.setReuse(true);
  http.setTimeout(5000);
  http.setConnectTimeout(5000);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);          // Minimum modem sleep, retaining DTIM delivery.
  WiFi.setAutoReconnect(false); // Single owner for the bounded retry schedule.
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  setCpuFrequencyMhz(80);
}
void loop() {
  tickCode();
  if (millis() - lastBatteryRead >= 30000)
    updateBattery();
  bool down = digitalRead(0) == LOW;
  if (down && !pressed) {
    screenActivity = millis();
    if (code.length()) {
      dismissedId = pendingDismissId = codeId;
      clearCode();
    } else {
      wakeScreen();
      render();
    }
    pollNow = true;
  }
  pressed = down;
  bool connected = WiFi.status() == WL_CONNECTED,
       clockReady = time(nullptr) >= 1700000000;
  if (connected != wasConnected) {
    tls.stop();
    if (connected) {
      pollInterval = POLL_MS;
      reconnectInterval = 15000;
      pollNow = true;
    } else
      lastReconnect = millis();
    if (!code.length())
      render();
    wasConnected = connected;
  }
  if (clockReady && !wasClockReady)
    pollNow = true;
  wasClockReady = clockReady;
  uint32_t now = millis();
  if (!connected && now - lastReconnect >= reconnectInterval) {
    lastReconnect = now;
    WiFi.reconnect();
    reconnectInterval = retryInterval(reconnectInterval, 120000);
  }
  if (connected && clockReady && (pollNow || now - lastPoll >= pollInterval)) {
    pollNow = false;
    bool dismissed = dismissPending(), fetched = fetchCode();
    pollInterval =
        dismissed && fetched ? POLL_MS : retryInterval(pollInterval, 60000);
    lastPoll = millis(); // Schedule from completion, including slow or failed
                         // requests.
  }
  tickCode();
  updateScreenPower();
  delay(50); // Yield to radio/RTOS; buttons stay responsive.
}
