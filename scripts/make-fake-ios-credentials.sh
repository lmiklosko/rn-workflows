#!/usr/bin/env bash
# Creates a self-signed code signing certificate (.p12) and a provisioning
# profile that references it, for tests. Apple did not issue either, so they
# exercise parsing, keychain import and project patching, but cannot sign a
# real build.
#
#   make-fake-ios-credentials.sh <output-dir> [bundle-id]
#
# Writes certificate.p12 (password: fake-password) and profile.mobileprovision.
set -euo pipefail

OUT="$1"
BUNDLE_ID="${2:-dev.rnworkflows.example}"
TEAM_ID="FAKETEAM01"
mkdir -p "$OUT"
cd "$OUT"

cat > openssl.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Apple Distribution: rn-workflows Fake ($TEAM_ID)
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:FALSE
CNF

openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -config openssl.cnf 2>/dev/null

# The 3DES/SHA-1 form is the one macOS `security import` accepts.
openssl pkcs12 -export -inkey key.pem -in cert.pem -name "rn-workflows fake" \
  -out certificate.p12 -passout pass:fake-password \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1

CERT_B64=$(openssl x509 -in cert.pem -outform der | base64 | tr -d '\n')
NOW=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')
EXPIRES=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=364)).strftime("%Y-%m-%dT%H:%M:%SZ"))')

cat > profile.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>rn-workflows fake</string>
  <key>ApplicationIdentifierPrefix</key><array><string>$TEAM_ID</string></array>
  <key>CreationDate</key><date>$NOW</date>
  <key>DeveloperCertificates</key><array><data>$CERT_B64</data></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>$TEAM_ID.$BUNDLE_ID</string>
    <key>com.apple.developer.team-identifier</key><string>$TEAM_ID</string>
    <key>get-task-allow</key><false/>
    <key>keychain-access-groups</key><array><string>$TEAM_ID.*</string></array>
  </dict>
  <key>ExpirationDate</key><date>$EXPIRES</date>
  <key>Name</key><string>rn-workflows Fake Ad Hoc</string>
  <key>Platform</key><array><string>iOS</string></array>
  <key>ProvisionedDevices</key><array><string>00008030-000000000000002E</string></array>
  <key>TeamIdentifier</key><array><string>$TEAM_ID</string></array>
  <key>TeamName</key><string>rn-workflows Fake</string>
  <key>TimeToLive</key><integer>364</integer>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
  <key>Version</key><integer>1</integer>
</dict>
</plist>
PLIST

# A real profile is this plist inside a CMS signature; mirror that.
openssl smime -sign -binary -nodetach -outform der \
  -in profile.plist -signer cert.pem -inkey key.pem -out profile.mobileprovision 2>/dev/null

rm -f openssl.cnf key.pem profile.plist
# cert.pem is kept: tests compare against it.
