#include "../firmware/email_code_display/power_policy.h"
#include <cassert>
#include <cstdio>

int main() {
  // Idle can sleep, but a code always remains legible until expiry. Polling
  // itself does not change the elapsed time since a new code arrived.
  assert(screenBrightness(false, 0) == 12);
  assert(screenBrightness(false, 14999) == 12);
  assert(screenBrightness(false, 15000) == 0);
  assert(screenBrightness(false, 300000) == 0);
  assert(screenBrightness(true, 0) == 160);
  assert(screenBrightness(true, 29999) == 160);
  assert(screenBrightness(true, 30000) == 64);
  assert(screenBrightness(true, 299999) == 64);

  // Five minutes offline, including a request that crosses expiry, must clear
  // the code rather than underflowing into a multi-day countdown.
  uint32_t remaining = 300000;
  for (int i = 0; i < 59; ++i)
    remaining = countdown(remaining, 5000);
  assert(remaining == 5000);
  assert(countdown(remaining, 6000) == 0);
  assert(countdown(remaining, 5000) == 0);
  assert(countdown(0, 50) == 0);

  // millis wraps after ~49 days; unsigned elapsed time still expires codes.
  uint32_t before = UINT32_MAX - 999;
  uint32_t after = 1000;
  assert(countdown(3000, after - before) == 1000);
  assert(countdown(1000, after - before) == 0);

  // A slow fetch must consume, rather than add, display lifetime.
  assert(countdown(3000, 4000) == 0);
  assert(countdown(300000, 5000) == 295000);

  // A sustained service outage reduces request frequency to once a minute.
  uint32_t interval = POLL_MS;
  const uint32_t expected[] = {10000, 20000, 40000, 60000, 60000};
  for (auto next : expected) {
    interval = retryInterval(interval, 60000);
    assert(interval == next);
  }
  // Wi-Fi association retries have a separate two-minute ceiling.
  interval = 15000;
  for (int i = 0; i < 20; ++i)
    interval = retryInterval(interval, 120000);
  assert(interval == 120000);
  assert(POLL_MS == 5000);
  puts("Firmware power/timing scenarios passed");
}
