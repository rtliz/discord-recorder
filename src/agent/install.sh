#!/bin/sh
# Discord Recorder agent installer for macOS / Linux, served by the bot at /agent/install.sh (public, generic, no secrets).
#   curl -fsSL <PUBLIC_URL>/agent/install.sh | DRA_TOKEN=<pairing token> sh
#   (an old command with the token as the first argument still works, but shows it in the process list)
# Installs its OWN pinned Node and ffmpeg (SHA-256 from the manifest, checked before anything is extracted) and the agent
# files into ~/.discord-recorder-agent. The system node/ffmpeg are never used. Running it again updates everything; a spent
# or missing token keeps the existing pairing. The bot fills in the quoted server placeholder below.
# Test hooks: DRA_HOME (install dir), DRA_NO_START=1 (install only), DRA_AUTOSTART=1|0 (skip the question), DRA_LAUNCHCTL,
# DRA_CONSENT=y|n (answers the consent question; an existing config.json means the owner already agreed).
set -eu

SERVER='__SERVER__'
TOKEN="${DRA_TOKEN:-${1:-}}"
unset DRA_TOKEN # only the pair call below gets it
DIR="${DRA_HOME:-$HOME/.discord-recorder-agent}"
TMP="$DIR/tmp"
LAUNCHCTL="${DRA_LAUNCHCTL:-launchctl}"
PLIST_LABEL='com.discord-recorder.agent'

say() { printf '%s\n' "$*"; }
die() { say "❌ $*" >&2; exit 1; }

# a pairing token is base64url: refuse anything else before it gets near a command line
case "$TOKEN" in
  *[!A-Za-z0-9_-]*) die "โทเคนไม่ถูกต้อง คัดลอกคำสั่งจาก /agent ใน Discord มาใหม่ทั้งบรรทัด" ;;
esac

# --- platform -----------------------------------------------------------------
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Darwin)
    # a Rosetta shell on Apple Silicon reports x86_64
    if [ "$ARCH" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi
    case "$ARCH" in arm64) TARGET=darwin-arm64 ;; x86_64) TARGET=darwin-x64 ;; *) die "ไม่รองรับ CPU แบบ $ARCH" ;; esac ;;
  Linux)
    case "$ARCH" in x86_64) TARGET=linux-x64 ;; *) die "ไม่รองรับ CPU แบบ $ARCH (รองรับเฉพาะ x86_64)" ;; esac ;;
  *) die "ไม่รองรับระบบ $OS (Windows ใช้คำสั่ง PowerShell จาก /agent)" ;;
esac

command -v curl >/dev/null 2>&1 || die "ไม่พบ curl"
command -v tar >/dev/null 2>&1 || die "ไม่พบ tar"
command -v unzip >/dev/null 2>&1 || die "ไม่พบ unzip (Linux: ติดตั้งด้วย sudo apt install unzip)"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die "ไม่พบ shasum หรือ sha256sum สำหรับตรวจไฟล์"; fi
}

# verify FILE EXPECTED_SHA LABEL: aborts before anything is extracted or replaced
verify() {
  got=$(sha256_of "$1")
  [ "$got" = "$2" ] || die "ไฟล์ $3 ไม่ตรงกับค่า SHA-256 ที่กำหนด (ถูกแก้ไขหรือโหลดมาไม่ครบ) ยกเลิกการติดตั้ง ของเดิมไม่ถูกแตะ"
}

# --- consent (once, before anything is downloaded or paired) ---------------------------------------------------
# the bot never asks again at recording time; an install that already has a config agreed before (or is an update)
if [ ! -f "$DIR/config.json" ]; then
  say "ℹ️  ตัวอัดจะให้บอทอัดทั้งจอที่เลือกของเครื่องนี้ได้ทุกครั้งที่มีคนกดอัดหรือเปิดอัดอัตโนมัติ โดยไม่ถามอีก กด s ที่ตัวอัดเพื่อหยุดได้ทุกเมื่อ"
  ans="${DRA_CONSENT:-}"
  if [ -z "$ans" ]; then
    if ! { : </dev/tty; } 2>/dev/null; then
      say "ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร (ต้องรันคำสั่งนี้ในหน้าต่าง Terminal เพื่อตอบคำถาม)"
      exit 0
    fi
    printf '%s' "ให้บอทอัดจอเครื่องนี้ไหม? (y/N) "
    { read -r ans </dev/tty; } 2>/dev/null || ans=""
  fi
  case "$(printf %s "$ans" | tr '[:upper:]' '[:lower:]')" in y|yes) ;; *) say "ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร"; exit 0 ;; esac
fi

# --- manifest -----------------------------------------------------------------
mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "⬇️  กำลังดึงรายการไฟล์จากบอท..."
MANIFEST="$TMP/manifest.json"
curl -fsSL --retry 2 -o "$MANIFEST" "$SERVER/agent/manifest.json" || die "ดึง $SERVER/agent/manifest.json ไม่ได้ ตรวจอินเทอร์เน็ตหรือให้แอดมินเช็ค PUBLIC_URL"

# the manifest is pretty-printed JSON written by the bot (2-space indent): read it with awk, no jq/node needed yet.
# pin SECTION TARGET FIELD -> value (section = node | ffmpeg)
pin() {
  awk -v sec="$1" -v tgt="$2" -v fld="$3" '
    /^  "[^"]*": [\[{]/ { s = $0; sub(/^  "/, "", s); sub(/".*/, "", s); cs = s; ct = ""; next }
    /^    "[^"]*": \{/ { t = $0; sub(/^    "/, "", t); sub(/".*/, "", t); ct = t; next }
    cs == sec && ct == tgt && index($0, "      \"" fld "\": \"") == 1 { v = $0; sub(/^[^:]*: "/, "", v); sub(/".*/, "", v); print v; exit }
  ' "$MANIFEST"
}
# files -> "name sha256" per agent JS file
agent_files() {
  awk '
    /^  "[^"]*": [\[{]/ { s = $0; sub(/^  "/, "", s); sub(/".*/, "", s); cs = s; n = ""; next }
    cs == "files" && /^      "name": "/ { n = $0; sub(/^      "name": "/, "", n); sub(/".*/, "", n) }
    cs == "files" && n != "" && /^      "sha256": "/ { h = $0; sub(/^      "sha256": "/, "", h); sub(/".*/, "", h); print n " " h; n = "" }
  ' "$MANIFEST"
}

NODE_URL=$(pin node "$TARGET" url); NODE_SHA=$(pin node "$TARGET" sha256)
FF_URL=$(pin ffmpeg "$TARGET" url); FF_SHA=$(pin ffmpeg "$TARGET" sha256)
[ -n "$NODE_URL" ] && [ -n "$NODE_SHA" ] && [ -n "$FF_URL" ] && [ -n "$FF_SHA" ] || die "บอทยังไม่มีข้อมูล Node/ffmpeg สำหรับเครื่องนี้ ($TARGET) แจ้งแอดมินให้รัน npm run build:agent"
for u in "$NODE_URL" "$FF_URL"; do
  # https only (plain http just for a localhost bot, like the agent itself)
  case "$u" in https://*|http://localhost:*|http://127.0.0.1:*) ;; *) die "ลิงก์ดาวน์โหลดในรายการไม่ใช่ https ยกเลิก" ;; esac
done
FILES=$(agent_files)
[ -n "$FILES" ] || die "รายการไฟล์ตัวอัดจากบอทว่างเปล่า"

download() { # URL OUT LABEL
  say "⬇️  กำลังโหลด $3 ..."
  curl -fL --retry 2 --progress-bar -o "$2" "$1" || die "โหลด $3 ไม่สำเร็จ"
}

# --- Node (own copy, replaced as a whole) ---------------------------------------
if [ -x "$DIR/node/bin/node" ] && [ "$(cat "$DIR/node/.sha256" 2>/dev/null || true)" = "$NODE_SHA" ]; then
  say "✅ Node เป็นเวอร์ชันล่าสุดแล้ว"
else
  download "$NODE_URL" "$TMP/node.tgz" "Node"
  verify "$TMP/node.tgz" "$NODE_SHA" "Node"
  mkdir -p "$TMP/node-new"
  tar -xzf "$TMP/node.tgz" -C "$TMP/node-new" --strip-components=1 || die "แตกไฟล์ Node ไม่สำเร็จ"
  [ -x "$TMP/node-new/bin/node" ] || die "ไฟล์ Node ที่โหลดมาไม่มี bin/node"
  printf '%s\n' "$NODE_SHA" > "$TMP/node-new/.sha256"
  rm -rf "$DIR/node.old"
  if [ -d "$DIR/node" ]; then mv "$DIR/node" "$DIR/node.old"; fi
  mv "$TMP/node-new" "$DIR/node"
  rm -rf "$DIR/node.old"
  say "✅ ติดตั้ง Node แล้ว"
fi

# --- ffmpeg (own copy in <home>/bin, where the agent looks first) -----------------
if [ -x "$DIR/bin/ffmpeg" ] && [ "$(cat "$DIR/bin/.ffmpeg.sha256" 2>/dev/null || true)" = "$FF_SHA" ]; then
  say "✅ ffmpeg เป็นเวอร์ชันล่าสุดแล้ว"
else
  download "$FF_URL" "$TMP/ffmpeg.zip" "ffmpeg"
  verify "$TMP/ffmpeg.zip" "$FF_SHA" "ffmpeg"
  mkdir -p "$TMP/ffmpeg-new"
  unzip -q -o "$TMP/ffmpeg.zip" -d "$TMP/ffmpeg-new" || die "แตกไฟล์ ffmpeg ไม่สำเร็จ"
  [ -f "$TMP/ffmpeg-new/ffmpeg" ] || die "ไฟล์ ffmpeg ที่โหลดมาไม่มีตัว ffmpeg"
  chmod +x "$TMP/ffmpeg-new/ffmpeg"
  mkdir -p "$DIR/bin"
  mv -f "$TMP/ffmpeg-new/ffmpeg" "$DIR/bin/ffmpeg"
  printf '%s\n' "$FF_SHA" > "$DIR/bin/.ffmpeg.sha256"
  say "✅ ติดตั้ง ffmpeg แล้ว"
fi

# macOS refuses unsigned arm64 binaries: sign ad hoc only when the signature check fails (never fatal)
if [ "$OS" = Darwin ] && command -v codesign >/dev/null 2>&1; then
  for b in "$DIR/node/bin/node" "$DIR/bin/ffmpeg"; do
    codesign -v "$b" >/dev/null 2>&1 || codesign -s - --force "$b" >/dev/null 2>&1 || true
  done
fi

# --- agent files ----------------------------------------------------------------
mkdir -p "$TMP/app-new"
# (here-document, not a pipe: die must exit this shell, not a subshell)
while read -r name sha; do
  case "$name" in
    [a-z]*.js) ;;
    *) die "ชื่อไฟล์ในรายการไม่ถูกต้อง ยกเลิก" ;;
  esac
  case "$name" in *[!a-z0-9.-]*) die "ชื่อไฟล์ในรายการไม่ถูกต้อง ยกเลิก" ;; esac
  curl -fsSL --retry 2 -o "$TMP/app-new/$name" "$SERVER/agent/files/$name" || die "โหลดไฟล์ตัวอัด $name ไม่สำเร็จ"
  verify "$TMP/app-new/$name" "$sha" "$name"
done <<LIST
$FILES
LIST
[ -f "$TMP/app-new/main.js" ] || die "ไม่พบ main.js ในรายการไฟล์ตัวอัด"
# the agent is ESM; without this a bare folder of .js files is read as CommonJS
printf '{"type":"module"}\n' > "$TMP/app-new/package.json"
rm -rf "$DIR/app.old"
if [ -d "$DIR/app" ]; then mv "$DIR/app" "$DIR/app.old"; fi
mv "$TMP/app-new" "$DIR/app"
rm -rf "$DIR/app.old"
say "✅ อัปเดตไฟล์ตัวอัดแล้ว"

# launcher used by double click and by autostart; it finds its own folder, nothing is baked in
cat > "$DIR/start.command" <<'LAUNCHER'
#!/bin/sh
D=$(cd "$(dirname "$0")" && pwd)
export DRA_HOME="$D"
cd "$D"
exec "$D/node/bin/node" "$D/app/main.js"
LAUNCHER
chmod +x "$DIR/start.command"

# uninstaller: autostart off, then this whole folder (backup recordings included). The bot's side of the pairing goes
# with 🗑️ in /agent (or is pruned after 90 days unseen)
cat > "$DIR/uninstall.command" <<'UNINSTALLER'
#!/bin/sh
D=$(cd "$(dirname "$0")" && pwd)
[ -f "$D/app/main.js" ] || { echo "❌ ไม่ใช่โฟลเดอร์ตัวอัด: $D"; exit 1; }
ans="${DRA_UNINSTALL:-}"
if [ -z "$ans" ]; then
  printf '%s' "ลบตัวอัดและไฟล์สำรองใน $D ทั้งหมดไหม? (ปิดตัวอัดก่อนด้วย q) (y/N) "
  { read -r ans </dev/tty; } 2>/dev/null || ans=""
fi
case "$(printf %s "$ans" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in y|yes) ;; *) echo "ยกเลิก ไม่ได้ลบอะไร"; exit 0 ;; esac
P="$HOME/Library/LaunchAgents/com.discord-recorder.agent.plist"
if [ -f "$P" ]; then "${DRA_LAUNCHCTL:-launchctl}" bootout "gui/$(id -u)" "$P" >/dev/null 2>&1; rm -f "$P"; fi
cd / && rm -rf "$D"
echo "✅ ลบตัวอัดแล้ว อย่าลืมกด 🗑️ ยกเลิกเครื่องนี้ใน /agent ใน Discord"
UNINSTALLER
chmod +x "$DIR/uninstall.command"

NODE="$DIR/node/bin/node"
MAIN="$DIR/app/main.js"
HAS_CRED=0
grep -q '"secret"' "$DIR/config.json" 2>/dev/null && HAS_CRED=1

# --- pairing ---------------------------------------------------------------------
if [ -n "$TOKEN" ]; then
  say "🔗 กำลังเชื่อมกับบัญชี Discord ของคุณ..."
  # the token goes in the environment of this one command, not argv (other users can read argv with ps)
  if DRA_HOME="$DIR" DRA_TOKEN="$TOKEN" "$NODE" "$MAIN" --server "$SERVER" --pair-only --consent; then
    HAS_CRED=1
  elif [ "$HAS_CRED" = 1 ]; then
    say "ℹ️  โทเคนนี้ใช้ไปแล้ว ใช้การเชื่อมต่อเดิมที่ตั้งไว้ (ถ้าต้องการเปลี่ยนบัญชี ให้ขอคำสั่งใหม่จาก /agent)"
  else
    die "เชื่อมกับบอทไม่สำเร็จ ขอคำสั่งใหม่จาก /agent ใน Discord แล้วลองอีกครั้ง"
  fi
elif [ "$HAS_CRED" = 0 ]; then
  die "ยังไม่ได้เชื่อมกับบอท พิมพ์ /agent ใน Discord แล้วคัดลอกคำสั่งทั้งบรรทัดมาวาง"
fi

say ""
say "ติดตั้งเสร็จแล้ว อยู่ที่ $DIR"
if [ "$OS" = Darwin ]; then
  say ""
  say "⚠️  macOS: ครั้งแรกที่อัดจอ macOS จะถามสิทธิ์ Screen Recording ให้แอป Terminal (หรือ iTerm ถ้ารันจากนั้น)"
  say "   ไม่ได้ให้กับตัวอัดโดยตรง ถ้าไม่มีหน้าต่างถาม ให้เปิดเอง:"
  say "   System Settings → Privacy & Security → Screen & System Audio Recording → เปิดสวิตช์ Terminal"
  say "   แล้วปิด Terminal แล้วเปิดใหม่ (ถ้าเพิ่งอนุญาต)"
  say "ℹ️  ไฟล์ที่โหลดด้วย curl ไม่ติด Gatekeeper ไม่ต้อง right-click → Open"
fi
say "ℹ️  ตัวอัดจะอัดเฉพาะตอนที่บอทสั่ง (มีคนกดอัด หรือ server เปิดอัดอัตโนมัติ) กด s ที่ตัวอัดเพื่อหยุดได้ทุกเมื่อ"

# --- optional autostart (macOS only, opt-in) ----------------------------------------
# ask on the real terminal: stdin of this script is the curl pipe
ask_yn() {
  ans="${DRA_AUTOSTART:-}"
  if [ -z "$ans" ] && [ -t 1 ]; then
    printf '%s' "$1 (y/N) "
    { read -r ans </dev/tty; } 2>/dev/null || ans=""
  fi
  case "$(printf %s "$ans" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in y|yes|1) return 0 ;; *) return 1 ;; esac
}

AUTOSTARTED=0
if [ "$OS" = Darwin ]; then
  if ask_yn "เปิดตัวอัดอัตโนมัติทุกครั้งที่เข้าเครื่องไหม?"; then
    PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    # launchd opens Terminal.app on the launcher, so the Screen Recording permission stays with Terminal
    xmlpath=$(printf '%s' "$DIR/start.command" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/open</string><string>-a</string><string>Terminal</string><string>$xmlpath</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLISTEOF
    "$LAUNCHCTL" bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    if "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"; then
      AUTOSTARTED=1
      say "✅ เปิดอัตโนมัติแล้ว (ตอนนี้เปิดหน้าต่าง Terminal ของตัวอัดให้แล้ว) ยกเลิกได้ด้วย: launchctl bootout gui/\$(id -u) \"$PLIST\" && rm \"$PLIST\""
    else
      say "⚠️  ตั้งเปิดอัตโนมัติไม่สำเร็จ (ใช้ตัวอัดต่อได้ตามปกติ)"
    fi
  else
    say "ℹ️  ไม่ได้ตั้งเปิดอัตโนมัติ"
  fi
fi

say ""
say "📌 คำสั่งที่ใช้ภายหลัง (วางใน Terminal)"
say "   เปิดตัวอัด:  \"$DIR/start.command\""
say "   ลบตัวอัด:    \"$DIR/uninstall.command\""
say "   อัปเดต:      ขอคำสั่งใหม่จาก /agent ใน Discord แล้ววางอีกครั้ง"

# --- run -------------------------------------------------------------------------
[ "${DRA_NO_START:-0}" = 1 ] && exit 0
[ "$AUTOSTARTED" = 1 ] && exit 0
say ""
say "▶️  เริ่มตัวอัด (กด q เพื่อออก)"
rm -rf "$TMP"
trap - EXIT INT TERM
export DRA_HOME="$DIR"
# keys (s / d / r / q) are read from the terminal, not from the curl pipe
if [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then exec "$NODE" "$MAIN" </dev/tty; fi
exec "$NODE" "$MAIN"
