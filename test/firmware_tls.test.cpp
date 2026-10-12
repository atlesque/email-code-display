#include "../firmware/email_code_display/certificate_bundle_client.h"
#include <cassert>
#include <cstdio>

int main() {
  const uint8_t bundle[] = {1, 2, 3};
  // Reproduce the original setup -> Wi-Fi connected -> stop -> first poll bug.
  WiFiClientSecure original;
  original.setCACertBundle(bundle, sizeof(bundle));
  original.stop();
  assert(original.connect("example.com", 443, 5000) == 0);
  CertificateBundleClient client(bundle, sizeof(bundle));
  WiFiClientSecure &httpClient = client;
  // HTTPClient uses the three-argument virtual overload through a base pointer.
  assert(httpClient.connect("example.com", 443, 5000) == 1);
  assert(client.bundle == bundle && client.bundleSize == sizeof(bundle));
  assert(client.connectTimeout == 5000);
  client.stop(); // Wi-Fi event, server close, or HTTP error.
  assert(!client.bundleAttached);
  assert(httpClient.connect("example.com", 443, 5000) == 1);
  // A failed handshake also clears the callback; the next attempt restores it.
  client.failNext = true;
  assert(httpClient.connect("example.com", 443, 5000) == 0);
  assert(!client.bundleAttached);
  assert(httpClient.connect("example.com", 443, 5000) == 1);
  client.stop();
  assert(httpClient.connect("example.com", 443) == 1);
  // An absent bundle never grants an unverified connection.
  CertificateBundleClient missing(nullptr, 0);
  assert(missing.connect("example.com", 443, 5000) == 0);
  puts("Certificate bundle reconnect scenarios passed");
}
