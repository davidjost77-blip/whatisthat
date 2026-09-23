#!/bin/bash
# Doppelklick im Finder startet die Finanzen-App und öffnet das Dashboard im Browser.
# Beenden: dieses Terminal-Fenster schließen oder Ctrl+C drücken.
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  echo "Python 3.9 oder neuer wird benötigt."
  echo "Installation: https://www.python.org/downloads/macos/  (oder: brew install python)"
  read -r -p "Enter zum Schließen …"
  exit 1
fi

python3 -m finanzen --open "$@"
