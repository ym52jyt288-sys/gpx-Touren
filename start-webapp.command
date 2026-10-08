#!/bin/sh
# GPX-Tourenverwaltung - lokalen Server starten und im Browser oeffnen.
# Doppelklick im Finder, oder:  sh start-webapp.command
# Beenden: dieses Fenster schliessen oder Strg-C druecken.

cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 wurde nicht gefunden. Bitte Command Line Tools installieren:"
  echo "  xcode-select --install"
  echo ""
  echo "Zum Schliessen Enter druecken."
  read _
  exit 1
fi

port_free() {
  python3 -c "import socket,sys; s=socket.socket();
sys.exit(1 if s.connect_ex(('127.0.0.1', $1)) == 0 else 0)" 2>/dev/null
}

PORT=8000
for p in 8000 8010 8020 8080 4173; do
  if port_free "$p"; then PORT="$p"; break; fi
done

URL="http://localhost:$PORT"
echo "GPX-Tourenverwaltung"
echo "Server laeuft auf: $URL"
echo "Dieses Fenster offen lassen. Beenden mit Strg-C."
echo ""

( sleep 1
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "$URL"
  else
    echo ">> Bitte $URL in Google Chrome oeffnen (fuer den Ordnerzugriff noetig)."
    open "$URL"
  fi ) &

exec python3 -m http.server "$PORT"
