#!/usr/bin/env bash
# 将多层镜像压平为 1 层，规避目标机器 overlay2 的 125 层上限（max depth exceeded）。
# 用法: ./flatten-oh-image.sh [源镜像] [输出tar路径]
set -euo pipefail

SRC_IMAGE="${1:-openharness_hyperframes_qwen-tts_pptx:v0.1.9_v0.7.42_v1.4_v2.1}"
FLAT_IMAGE="${SRC_IMAGE}-flat"
OUT_TAR="${2:-/root/data/$(echo "${SRC_IMAGE}" | tr ':' '-')-flat.tar}"
TMP_CTR="oh-flatten-tmp"

echo "==> 源镜像: ${SRC_IMAGE} ($(docker image inspect "${SRC_IMAGE}" --format '{{len .RootFS.Layers}}') 层)"

# 1. 从源镜像 Config 自动生成 --change 参数，保证配置不丢
CHANGES=()
while IFS= read -r env; do
  [ -n "${env}" ] && CHANGES+=(--change "ENV ${env}")
done < <(docker image inspect "${SRC_IMAGE}" --format '{{range .Config.Env}}{{println .}}{{end}}')

ENTRYPOINT_JSON=$(docker image inspect "${SRC_IMAGE}" --format '{{json .Config.Entrypoint}}')
CMD_JSON=$(docker image inspect "${SRC_IMAGE}" --format '{{json .Config.Cmd}}')
WORKDIR=$(docker image inspect "${SRC_IMAGE}" --format '{{.Config.WorkingDir}}')
[ "${ENTRYPOINT_JSON}" != "null" ] && CHANGES+=(--change "ENTRYPOINT ${ENTRYPOINT_JSON}")
[ "${CMD_JSON}" != "null" ] && CHANGES+=(--change "CMD ${CMD_JSON}")
[ -n "${WORKDIR}" ] && CHANGES+=(--change "WORKDIR ${WORKDIR}")
while IFS= read -r port; do
  [ -n "${port}" ] && CHANGES+=(--change "EXPOSE ${port}")
done < <(docker image inspect "${SRC_IMAGE}" --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}')

echo "==> 共 ${#CHANGES[@]} 个 --change 片段"

# 2. export 文件系统（1 层）并 import 回带配置的镜像
docker rm -f "${TMP_CTR}" >/dev/null 2>&1 || true
docker create --name "${TMP_CTR}" "${SRC_IMAGE}" >/dev/null
echo "==> docker export | docker import 中（约 4GB，需几分钟）..."
docker export "${TMP_CTR}" | docker import "${CHANGES[@]}" - "${FLAT_IMAGE}"
docker rm "${TMP_CTR}" >/dev/null

# 3. 校验
echo "==> 压平后: ${FLAT_IMAGE} ($(docker image inspect "${FLAT_IMAGE}" --format '{{len .RootFS.Layers}}') 层)"
docker image inspect "${FLAT_IMAGE}" --format 'Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}} WorkDir={{.Config.WorkingDir}} Ports={{json .Config.ExposedPorts}}'

# 4. 导出 tar
echo "==> docker save -> ${OUT_TAR}"
docker save -o "${OUT_TAR}" "${FLAT_IMAGE}"
ls -lh "${OUT_TAR}"
echo "==> 完成。目标机器: docker load -i $(basename "${OUT_TAR}") && docker tag ${FLAT_IMAGE} ${SRC_IMAGE}"
