import asyncio
import os
import sys
from datetime import datetime

async def main():
    log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    os.makedirs(log_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = os.path.join(log_dir, f"generate_video_{timestamp}.log")

    log_file = open(log_path, "a", encoding="utf-8")

    def log(msg):
        line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line)
        log_file.write(line + "\n")
        log_file.flush()

    log(f"Log file: {log_path}")

    # 丰富后的结构化 Prompt，完美适配 HTML 渲染与 1.0 倍速 TTS
    full_prompt = (
        '基于/app/test.pptx这个文件，帮我用hyperframes这个skill，做一个10s的宣传视频，'
        '强制要求：1.先使用pptx-to-html skill将PPTX转换为HTML，再基于转换后的HTML文件使用hyperframes skill渲染视频；'
        '2.每一帧内容必须视觉丰富，核心元素占据页面比例 70% 以上，避免留白；'
        '3.chrome 路径已由运行环境预配置（PRODUCER_HEADLESS_SHELL_PATH），直接 render 即可，无需手动设置；'
        '4.不要加配音。'
        '同时我已同意你的任何操作，无需询问'
    )
    log(f"Prompt: {full_prompt}")

    proc = await asyncio.create_subprocess_exec(
        "oh", "-p", full_prompt,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            **os.environ,
            "PYTHONUNBUFFERED": "1",
        },
    )
    log(f"Process started, pid={proc.pid}")

    async def read_stream(stream, label):
        while True:
            line = await stream.readline()
            if not line:
                break
            log(f"[{label}] {line.decode('utf-8', errors='replace').rstrip()}")

    await asyncio.gather(
        read_stream(proc.stdout, "stdout"),
        read_stream(proc.stderr, "stderr"),
    )

    returncode = await proc.wait()
    log(f"Process exited with code: {returncode}")
    log_file.close()
    sys.exit(returncode)

if __name__ == "__main__":
    asyncio.run(main())