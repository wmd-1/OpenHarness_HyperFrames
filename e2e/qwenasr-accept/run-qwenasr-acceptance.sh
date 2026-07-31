#!/usr/bin/env bash
# run-qwenasr-acceptance.sh — 在已有镜像容器内验收 QwenASR 补丁（tasks 8.2/8.4 可行部分）。
# 远端真实服务不可达时 8.1/8.3/8.5 无法执行；本脚本用契约形状 mock 验证客户端 schema
# 与四种 fallback 情形。用法（容器内）：bash /accept/run-qwenasr-acceptance.sh
set -uo pipefail
SK=/opt/oh-skills-builtin
A=$SK/media-use/scripts/transcribe.mjs
TTS=$SK/media-use/audio/scripts/lib/tts.mjs
C=$SK/embedded-captions/scripts/transcribe.cjs
CT=$SK/embedded-captions/scripts/check-timing.cjs
pass=0; fail=0
ok(){ echo "PASS: $1"; pass=$((pass+1)); }
ng(){ echo "FAIL: $1"; fail=$((fail+1)); }

ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 /tmp/sample.wav -loglevel error
node /accept/mock_qwenasr_server.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 0.6

echo "== 8.1(mock) healthz 契约 =="
curl -sf http://127.0.0.1:8092/healthz | grep -q '"ok"' && ok "mock /healthz ok:true" || ng "mock /healthz"

echo "== 8.2 入口 A：mock ok → engine qwenasr + schema =="
outA=$(QWENASR_URL=http://127.0.0.1:8092 node "$A" --input /tmp/sample.wav --out /tmp/a1.json --json 2>/tmp/a1.err); rcA=$?
[ $rcA -eq 0 ] && echo "$outA" | grep -q '"engine":"qwenasr"' && ok "A engine=qwenasr rc=0" || ng "A engine=qwenasr (rc=$rcA out=$outA err=$(cat /tmp/a1.err))"
node -e '
const d=require("/tmp/a1.json"); const w=d.words;
const shape=Array.isArray(w)&&w.length===2&&w.every(x=>typeof x.text==="string"&&Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end<36000);
const mono=w.every((x,i)=>i===0||w[i-1].end<=x.start+1e-9);
process.exit(shape&&mono&&d.text==="hello world"?0:1);' \
  && ok "A 输出 [{text,start,end}] 秒、单调不减" || ng "A schema: $(cat /tmp/a1.json)"

echo "== 8.2 入口 B：transcribeWav → flat [{id,text,start,end}]，不 spawn whisper =="
QWENASR_URL=http://127.0.0.1:8092 node --input-type=module -e "
import { transcribeWav } from \"$TTS\";
const w = await transcribeWav({ wavRel: \"/tmp/sample.wav\", lang: \"en\", hyperframesDir: \"/tmp\" });
const ok = Array.isArray(w)&&w.length===2&&w.every((x,i)=>x.id===i&&typeof x.text===\"string\"&&Number.isFinite(x.start)&&Number.isFinite(x.end));
process.exit(ok?0:1);" 2>/tmp/b1.err && ok "B flat 词数组" || ng "B transcribeWav ($(cat /tmp/b1.err))"

echo "== 8.2 入口 C：TRANSCRIBE_ENGINE=qwenasr → transcript.json + 重读通过 + check-timing --strict =="
rm -rf /tmp/proj && mkdir -p /tmp/proj
ffmpeg -y -f lavfi -i "color=c=black:s=320x240:d=2" -f lavfi -i "sine=frequency=440:duration=2" \
  -shortest -c:v libx264 -preset ultrafast -c:a aac /tmp/proj/source.mp4 -loglevel error
TRANSCRIBE_ENGINE=qwenasr QWENASR_URL=http://127.0.0.1:8092 node "$C" /tmp/proj small en >/tmp/c1.out 2>&1
rcC=$?
node -e '
const d=require("/tmp/proj/transcript.json");
const ok=d&&Array.isArray(d.words)&&d.words.length===2&&d.words.every(w=>w.type==="word"&&typeof w.text==="string"&&Number.isFinite(w.start)&&Number.isFinite(w.end));
process.exit(ok?0:1);' && [ $rcC -eq 0 ] && ok "C transcript.json 词级 schema" || ng "C transcript.json (rc=$rcC $(cat /tmp/c1.out))"
grep -q '"engine": *"qwenasr"\|"engine":"qwenasr"' /tmp/proj/transcript.json && ok "C engine 标识 qwenasr" || ng "C engine 标识 ($(cat /tmp/proj/transcript.json 2>/dev/null | head -c 300))"
# 下游重读：第二次运行应识别 already normalized（schema 被下游解析规则接受）
TRANSCRIBE_ENGINE=qwenasr QWENASR_URL=http://127.0.0.1:8092 node "$C" /tmp/proj small en 2>&1 | grep -q "already normalized" \
  && ok "C 重读 already normalized" || ng "C 重读"
cat > /tmp/proj/plan.json <<'EOF'
{"width":720,"height":1290,"groups":[{"id":"g1","in":0.10,"out":1.10,
"css":"top: 40%; font-size: calc(0.05 * var(--h)); line-height: 1.1;",
"words":[{"text":"hello","start":0.12,"end":0.48},{"text":"world","start":0.55,"end":1.02}]}]}
EOF
node "$CT" /tmp/proj --strict >/tmp/ct.out 2>&1 && ok "check-timing --strict 通过" || ng "check-timing ($(cat /tmp/ct.out))"

echo "== 8.4-1 URL 未设：行为与上游一致（无 qwenasr 痕迹，走本地链）=="
env -u QWENASR_URL node "$A" --input /tmp/sample.wav --out /tmp/a4.json --json >/tmp/a4.out 2>/tmp/a4.err; rc4=$?
grep -qi qwenasr /tmp/a4.err /tmp/a4.out && ng "URL 未设仍有 qwenasr 痕迹" || ok "URL 未设无 qwenasr 痕迹"
[ $rc4 -eq 0 ] && grep -q '"engine":"whisper"' /tmp/a4.out && ok "URL 未设走 whisper 成功" || echo "INFO: URL 未设本地链 rc=$rc4 out=$(cat /tmp/a4.out) err=$(tail -2 /tmp/a4.err)"

echo "== 8.4-2 服务不可达：auto 回退 =="
QWENASR_URL=http://127.0.0.1:9 node "$A" --input /tmp/sample.wav --out /tmp/a5.json --json >/tmp/a5.out 2>/tmp/a5.err; rc5=$?
grep -q "falling back to local engines" /tmp/a5.err && ok "不可达 auto 打印回退日志" || ng "不可达回退日志 ($(cat /tmp/a5.err))"
[ $rc5 -eq 0 ] && grep -q '"engine":"whisper"' /tmp/a5.out && ok "不可达 auto 最终 whisper 成功" || echo "INFO: 回退链 rc=$rc5 $(cat /tmp/a5.out)"

echo "== 8.4-3 words:null：整体丢弃完整回退，无混合输出 =="
QWENASR_URL=http://127.0.0.1:8093 node "$A" --input /tmp/sample.wav --out /tmp/a6.json --json >/tmp/a6.out 2>/tmp/a6.err; rc6=$?
grep -q "no usable word timestamps" /tmp/a6.err && ok "words:null 丢弃日志" || ng "words:null 丢弃日志 ($(cat /tmp/a6.err))"
grep -q "hello world" /tmp/a6.json 2>/dev/null && ng "words:null 出现 mock 文本（混合！）" || ok "无 QwenASR 文本混入回退输出"

echo "== 8.4-4 显式指定失败 fail-fast 非零退出 =="
QWENASR_URL=http://127.0.0.1:8094 node "$A" --input /tmp/sample.wav --engine qwenasr --json >/tmp/a7.out 2>&1
[ $? -ne 0 ] && ok "A --engine qwenasr + 500 → 非零退出" || ng "A 显式 500 未 fail-fast"
env -u QWENASR_URL node "$A" --input /tmp/sample.wav --engine qwenasr >/tmp/a8.out 2>&1
[ $? -ne 0 ] && grep -q 'QWENASR_URL' /tmp/a8.out && ok "A --engine qwenasr 无 URL → 非零退出并指明 \$QWENASR_URL" || ng "A 无 URL fail-fast ($(cat /tmp/a8.out))"
rm -f /tmp/proj/transcript.json
TRANSCRIBE_ENGINE=qwenasr QWENASR_URL=http://127.0.0.1:9 node "$C" /tmp/proj >/tmp/c2.out 2>&1
[ $? -eq 4 ] && ok "C 显式不可达 → exit 4" || ng "C 显式不可达 ($(cat /tmp/c2.out))"
TRANSCRIBE_ENGINE=qwenasr node "$C" /tmp/proj >/tmp/c3.out 2>&1
[ $? -eq 4 ] && ok "C 显式无 URL → exit 4" || ng "C 显式无 URL ($(cat /tmp/c3.out))"

echo
echo "RESULT: pass=$pass fail=$fail"
[ $fail -eq 0 ]
