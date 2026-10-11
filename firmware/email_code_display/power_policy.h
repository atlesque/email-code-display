#pragma once
#include <stdint.h>

constexpr uint32_t POLL_MS = 5000;
constexpr uint32_t IDLE_SCREEN_MS = 15000;
constexpr uint32_t CODE_BRIGHT_MS = 30000;

inline uint8_t screenBrightness(bool hasCode, uint32_t elapsed) {
  if (hasCode)
    return elapsed < CODE_BRIGHT_MS ? 160 : 64;
  return elapsed < IDLE_SCREEN_MS ? 12 : 0;
}

inline uint32_t countdown(uint32_t remaining, uint32_t elapsed) {
  return elapsed >= remaining ? 0 : remaining - elapsed;
}
inline uint32_t retryInterval(uint32_t current, uint32_t maximum) {
  return current >= maximum / 2 ? maximum : current * 2;
}
