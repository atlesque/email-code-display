#pragma once
#include <cstddef>
#include <cstdint>

// Model the installed core's loss of its verification callback on stop/failure.
class WiFiClientSecure {
public:
  virtual ~WiFiClientSecure() = default;
  bool bundleAttached = false;
  bool failNext = false;
  const uint8_t *bundle = nullptr;
  size_t bundleSize = 0;
  int32_t connectTimeout = 0;
  void setCACertBundle(const uint8_t *value, size_t size) {
    bundle = value;
    bundleSize = size;
    bundleAttached = value && size;
  }
  void stop() { bundleAttached = false; }
  virtual int connect(const char *, uint16_t) {
    if (!bundleAttached)
      return 0;
    if (failNext) {
      failNext = false;
      stop();
      return 0;
    }
    return 1;
  }
  virtual int connect(const char *host, uint16_t port, int32_t timeout) {
    connectTimeout = timeout;
    return connect(host, port);
  }
};
