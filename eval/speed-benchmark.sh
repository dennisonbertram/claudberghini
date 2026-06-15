#!/bin/zsh
# Speed benchmark: measure Claudberghini's end-to-end agentic speed on real coding tasks.
# Reports per-task wall-clock, model-time (duration_api_ms), and turns; plus raw decode rate.
CJ=/Users/dennison/develop/claudberghini/claudberghini
WS=/tmp/cj-bench; rm -rf "$WS"; mkdir -p "$WS"; cd "$WS"; git init -q 2>/dev/null

echo "=== RAW Claudberghini decode speed (3 samples) ==="
for p in "Write a haiku about code" "List 5 prime numbers" "Define recursion in one line"; do
  curl -s -X POST https://chatjimmy.ai/api/chat -H "Content-Type: application/json" \
    -d "$(python3 -c "import json,sys; print(json.dumps({'messages':[{'role':'user','content':sys.argv[1]}],'chatOptions':{'selectedModel':'llama3.1-8B','systemPrompt':'','topK':8},'attachment':None}))" "$p")" \
  | python3 -c "import sys,re,json; m=re.search(r'<\|stats\|>(.*?)<\|/stats\|>',sys.stdin.read(),re.S); s=json.loads(m.group(1)) if m else {}; print(f\"  decode={s.get('decode_rate',0):.0f} tok/s  ttft={s.get('ttft',0)*1000:.1f}ms  tokens={s.get('decode_tokens')}  time={s.get('total_time',0)*1000:.1f}ms\")"
done

echo ""
echo "=== END-TO-END agentic tasks (wall-clock + model time) ==="
declare -a TASKS=(
  "Read config.txt and tell me what PORT equals."
  "Create a file hello.py that prints Hello World."
  "In version.txt change 1.0.0 to 2.0.0."
  "Count how many lines in log.txt contain WARN; give the number."
)
printf 'PORT=8080\n' > config.txt
printf 'version: 1.0.0\n' > version.txt
printf 'INFO a\nWARN b\nWARN c\nINFO d\n' > log.txt

total_wall=0; total_model=0; total_turns=0; n=0
for t in "${TASKS[@]}"; do
  s=$(python3 -c "import time;print(time.time())")
  out=$("$CJ" --output-format json -p "$t" < /dev/null 2>/dev/null)
  e=$(python3 -c "import time;print(time.time())")
  echo "$out" | python3 -c "
import sys,json
d=json.load(sys.stdin); w=$e-$s
print(f'  [{w:4.1f}s wall | {d.get(\"duration_api_ms\",0):5}ms model | {d.get(\"num_turns\"):>2} turns] {repr((d.get(\"result\") or \"\")[:45])}')
with open('/tmp/bench_acc','a') as f: f.write(f'{w} {d.get(\"duration_api_ms\",0)} {d.get(\"num_turns\",0)}\n')
"
done
echo ""
echo "=== AVERAGES ==="
python3 -c "
rows=[l.split() for l in open('/tmp/bench_acc')]
import os; os.remove('/tmp/bench_acc')
w=[float(r[0]) for r in rows]; m=[float(r[1]) for r in rows]; t=[float(r[2]) for r in rows]
print(f'  avg wall-clock: {sum(w)/len(w):.1f}s')
print(f'  avg model time: {sum(m)/len(m):.0f}ms  ({sum(m)/sum(t):.0f}ms per turn)')
print(f'  avg turns: {sum(t)/len(t):.1f}')
"
