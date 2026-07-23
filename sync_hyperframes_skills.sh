#!/usr/bin/env bash
set -euo pipefail

# ============ 配置区 ============
REPO="heygen-com/hyperframes"   # GitHub 仓库 owner/name
BRANCH="main"                   # 默认分支
# 代理设置：本机沙箱/内网环境通过 127.0.0.1:10808 出网；
#          如果在能直连 GitHub 的机器上运行，请把下面留空 ""
PROXY="http://127.0.0.1:10808"
# ================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# monorepo 后基线目录在仓库根（与 docs/hyperframes-skill-openharness-patches.md §1 表格一致），
# 不在 OpenHarness/ 子目录下。
DEST_DIR="$SCRIPT_DIR/hyperframes_github_skills_latest"

# 注意：Git Bash 下 mktemp 可能返回 Windows 风格路径(C:\...)，
# 而 tar -f "C:\..." 会把 "C:" 误判为远程主机导致失败。
# 因此临时目录统一放在脚本所在目录（纯 POSIX 路径，无冒号）。
TMP_DIR="$SCRIPT_DIR/.hf_sync_tmp"
TARBALL="$TMP_DIR/repo.tar.gz"
EXTRACT_DIR="$TMP_DIR/extracted"

CURL_OPTS=(-sL --retry 2 --fail --connect-timeout 30 -m 300)
if [ -n "$PROXY" ]; then
  CURL_OPTS+=(-x "$PROXY")
fi

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "==> 工作目录: $SCRIPT_DIR"

# ---------- 第 1 步：下载最新代码 tar 包（带校验与重试） ----------
# 优先用 codeload.github.com 直链（更稳定，避免 github.com/archive 的 302 跳转）
URLS=(
  "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
  "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
)
echo "==> [1/2] 下载最新代码: $REPO@$BRANCH"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$EXTRACT_DIR"

MAX_TRIES=8
RETRY_DELAY=30   # 两次尝试之间的退避秒数（应对代理冷却/限流）
OK=0
for i in $(seq 1 $MAX_TRIES); do
  # 在多个源之间轮换，并加随机查询参数打穿代理缓存
  BASE_URL="${URLS[$(( (i-1) % ${#URLS[@]} ))]}"
  URL="${BASE_URL}?cb=${RANDOM}"
  curl "${CURL_OPTS[@]}" -o "$TARBALL" \
    -w "    第 $i 次(${BASE_URL%%/*}): http_code=%{http_code} size=%{size_download} bytes\n" \
    "$URL" || true
  # 校验：文件非空且是合法的 gzip 包
  if [ -s "$TARBALL" ] && gzip -tq "$TARBALL" 2>/dev/null; then
    OK=1
    break
  fi
  rm -f "$TARBALL"
  if [ "$i" -lt "$MAX_TRIES" ]; then
    echo "    ⚠ 下载内容无效（空响应或代理冷却/限流），${RETRY_DELAY}s 后重试 ($i/$MAX_TRIES)..."
    sleep "$RETRY_DELAY"
  fi
done
if [ "$OK" -ne 1 ]; then
  echo "ERROR: 经过 $MAX_TRIES 次尝试仍无法下载有效的 tar 包。" >&2
  exit 1
fi

# ---------- 第 2 步：仅解压 skills/ 并复制到目标目录 ----------
echo "==> [2/2] 解压 skills/ 并复制到: $DEST_DIR"
# GitHub 归档顶层目录名为 <repo>-<branch>/，用 --strip-components=1 去掉该层
tar -xzf "$TARBALL" -C "$EXTRACT_DIR" --strip-components=1 "${REPO##*/}-$BRANCH/skills"

SKILLS_SRC="$EXTRACT_DIR/skills"
if [ ! -d "$SKILLS_SRC" ]; then
  echo "ERROR: tar 包中未找到 skills 目录（请检查 BRANCH 是否正确）" >&2
  exit 1
fi

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -a "$SKILLS_SRC/." "$DEST_DIR/"

echo "==> 完成 ✅ 已同步到: $DEST_DIR"
echo "    内容预览: $(ls -1 "$DEST_DIR" | wc -l) 个顶层条目"
