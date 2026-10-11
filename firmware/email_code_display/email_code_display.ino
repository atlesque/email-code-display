#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>
#include <time.h>
#include "secrets.h"
// ESP32 certificate bundle verifies the server and follows public root CA changes.
extern const uint8_t x509_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t x509_crt_bundle_end[] asm("_binary_x509_crt_bundle_end");
Adafruit_ST7789 tft(TFT_CS, TFT_DC, TFT_RST);
String codeId, code, service, provider, dismissedId;
uint32_t remainingMs=0, lastTick=0, lastPoll=0, lastReconnect=0;
bool pressed=false;
const uint16_t BG=0x0945, MINT=0xC758, MUTED=0x6D10;
String ascii(String value) {String clean;for(size_t i=0;i<value.length()&&clean.length()<32;i++)if(value[i]>=32&&value[i]<=126)clean+=value[i];return clean;}
void center(String text,int y,int size,uint16_t color){tft.setTextSize(size);tft.setTextColor(color);tft.setCursor(max(4,(240-int(text.length())*6*size)/2),y);tft.print(text);}
void render(){tft.fillScreen(BG);center("EMAIL CODE DISPLAY",10,1,MUTED);tft.drawFastHLine(12,29,216,MUTED);
 if(code.length()){center(ascii(service),40,1,MINT);int size=min(5,216/int(code.length()*6));center(code,62,max(1,size),ST77XX_WHITE);center(provider+"  /  "+String(remainingMs/1000)+"s",112,1,MUTED);}
 else {center(WiFi.status()==WL_CONNECTED?"Ready for your next code":"Connecting to Wi-Fi",58,1,MINT);center(WiFi.status()==WL_CONNECTED?"Gmail + Outlook":"Please wait",86,1,MUTED);}}
void clearCode(){code="";codeId="";service="";provider="";remainingMs=0;render();}
int request(const String& path,JsonDocument& result,const String& body=""){
 if(WiFi.status()!=WL_CONNECTED||time(nullptr)<1700000000)return -1;
 WiFiClientSecure tls;tls.setCACertBundle(x509_crt_bundle_start, x509_crt_bundle_end-x509_crt_bundle_start);tls.setTimeout(5);HTTPClient http;
 http.useHTTP10(true);http.setTimeout(5000);http.setConnectTimeout(5000);if(!http.begin(tls,String(WORKER_URL)+path))return -1;
 http.addHeader("Authorization",String("Bearer ")+DEVICE_TOKEN);http.addHeader("Content-Type","application/json");
 int status=body.length()?http.POST(body):http.GET();if(status==200){if(deserializeJson(result,http.getStream())!=DeserializationError::Ok)status=-2;}http.end();return status;
}
void fetchCode(){uint32_t started=millis();JsonDocument result;if(request("/api/device/code",result)!=200){Serial.println("Service unavailable; retrying");return;}
 if(result["code"].isNull()){dismissedId="";if(code.length())clearCode();return;}
 String nextId=result["id"].as<String>();if(nextId==dismissedId)return;
 String nextCode=result["code"].as<String>();if(nextCode.length()<4||nextCode.length()>12)return;
 for(char c:nextCode)if(!isalnum(c)&&c!=' '&&c!='-')return;
 uint32_t seconds=min(uint32_t(300),result["remainingSeconds"].as<uint32_t>());if(!seconds){clearCode();return;}
 codeId=nextId;code=nextCode;service=result["service"].as<String>();provider=result["provider"].as<String>();remainingMs=seconds*1000;uint32_t spent=millis()-started;remainingMs=spent>=remainingMs?0:remainingMs-spent;if(!remainingMs){clearCode();return;}
 // Subtract the blocking network duration from the new countdown too.
 lastTick=millis();render();Serial.println("Code received (value hidden)");}
void setup(){Serial.begin(115200);pinMode(TFT_BACKLITE,OUTPUT);digitalWrite(TFT_BACKLITE,HIGH);pinMode(TFT_I2C_POWER,OUTPUT);digitalWrite(TFT_I2C_POWER,HIGH);delay(10);
 tft.init(135,240);tft.setRotation(3);tft.setTextWrap(false);pinMode(0,INPUT_PULLUP);render();WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(true);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);configTime(0,0,"pool.ntp.org","time.google.com");lastTick=millis();}
void loop(){uint32_t now=millis(),elapsed=now-lastTick;lastTick=now;
 if(remainingMs){uint32_t previous=remainingMs/1000;remainingMs=elapsed>=remainingMs?0:remainingMs-elapsed;if(!remainingMs)clearCode();else if(previous!=remainingMs/1000)render();}
 bool down=digitalRead(0)==LOW;if(down&&!pressed&&code.length()){dismissedId=codeId;JsonDocument payload;payload["id"]=codeId;String body;serializeJson(payload,body);clearCode();JsonDocument response;request("/api/device/dismiss",response,body);}pressed=down;
 if(WiFi.status()!=WL_CONNECTED&&now-lastReconnect>=15000){lastReconnect=now;WiFi.reconnect();if(!code.length())render();}
 if(now-lastPoll>=5000){lastPoll=now;fetchCode();}
 delay(10);}
