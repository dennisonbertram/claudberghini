#!/bin/zsh
# Real-path eval: run claudberghini (full Claude Code harness via Claudberghini) on the 4
# target tasks N times each, in a sandboxed workspace, and report pass rates.
# Usage: real-path-eval.sh [N]   (default N=5)
N="${1:-5}"
CJ=/Users/dennison/develop/claudberghini/claudberghini
WS=/tmp/cj-rpe
rm -rf "$WS"; mkdir -p "$WS"; cd "$WS"; git init -q 2>/dev/null

run() {
  "$CJ" --output-format json -p "$1" < /dev/null 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin); print((d.get('result') or '').replace(chr(10),' '))
except: print('__ERR__')"
}

pr=0; pe=0; pc=0; pg=0
for i in $(seq "$N"); do
  # READ
  printf 'APP_NAME=demo\nSECRET_VALUE=banana42\nDEBUG=true\n' > config.txt
  o=$(run "Read config.txt and tell me what SECRET_VALUE equals.")
  echo "$o" | grep -q "banana42" && pr=$((pr+1))

  # EDIT
  printf 'name: myapp\nversion: 1.0.0\n' > version.txt
  run "In version.txt change the version from 1.0.0 to 2.0.0." >/dev/null
  grep -q "2.0.0" version.txt && ! grep -q "1.0.0" version.txt && pe=$((pe+1))

  # CREATE
  rm -f greeting.txt
  run "Create a file named greeting.txt containing exactly: Hello World" >/dev/null
  [ "$(cat greeting.txt 2>/dev/null)" = "Hello World" ] && pc=$((pc+1))

  # GREP
  printf 'alpha\n' > a.txt; printf 'gamma\nNEEDLE_TOKEN\ndelta\n' > b.txt; printf 'eps\n' > c.txt
  o=$(run "Exactly one file here contains NEEDLE_TOKEN. Find it and tell me the filename.")
  echo "$o" | grep -q "b.txt" && pg=$((pg+1))
done

echo "RESULTS (N=$N): read $pr/$N | edit $pe/$N | create $pc/$N | grep $pg/$N"
echo "TOTAL: $((pr+pe+pc+pg))/$((4*N))"
