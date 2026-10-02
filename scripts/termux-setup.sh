#!/data/data/com.termux/files/usr/bin/bash
# Termux setup for golemlink. Safe to re-run.
set -e

cd "$(dirname "$0")/.."

echo "== installing packages (nodejs-lts, termux-api) =="
pkg install -y nodejs-lts termux-api

echo "== installing npm dependencies =="
npm ci

echo "== native dependency check =="
node scripts/check-no-native.mjs

echo
echo "golemlink can prune unused Bedrock data from minecraft-data, cutting"
echo "the install from ~471 MB to ~138 MB. It must be re-run after every npm ci."
printf "Prune now? [y/N] "
read -r answer
case "$answer" in
  [yY]*) node scripts/prune-data.mjs ;;
  *) echo "skipped" ;;
esac

echo
echo "== manual steps =="
cat <<'EOF'

1. Install Termux and Termux:API from the SAME source (both from F-Droid, or
   both from GitHub). Mixing the Play Store Termux:API with F-Droid Termux
   breaks termux-notification and termux-wake-lock.

2. Turn off battery optimization for Termux:
   Android Settings -> Apps -> Termux -> Battery -> Unrestricted.

3. Android 12L and later: allow Termux to run phantom processes:
     adb shell "settings put global settings_enable_monitor_phantom_procs false"
   You can run this from Termux itself over wireless debugging.

4. Android 12 (not 12L):
     adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent;
                 /system/bin/device_config put activity_manager max_phantom_processes 2147483647"
   This only lifts the 32-process limit. Android 12 cannot turn off the
   high-CPU kill, so the daemon may still be killed in the background.

5. Android 14+: additionally enable Developer options -> "Disable child
   process restrictions".

Then start the daemon:
   node src/main.js --open
or use the restart wrapper:
   scripts/start.sh --open
EOF
