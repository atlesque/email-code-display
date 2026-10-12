#pragma once
#include <WiFiClientSecure.h>

// Arduino-ESP32 3.3.2 clears the bundle callback in stop_ssl_socket().
// Restore it at connection time, including after peer closes and Wi-Fi changes.
class CertificateBundleClient : public WiFiClientSecure {
public:
  CertificateBundleClient(const uint8_t *bundle, size_t size)
      : bundle_(bundle), size_(size) {}
  using WiFiClientSecure::connect;
  int connect(const char *host, uint16_t port) override {
    setCACertBundle(bundle_, size_);
    return WiFiClientSecure::connect(host, port);
  }
  int connect(const char *host, uint16_t port, int32_t timeout) override {
    setCACertBundle(bundle_, size_);
    return WiFiClientSecure::connect(host, port, timeout);
  }

private:
  const uint8_t *bundle_;
  size_t size_;
};
