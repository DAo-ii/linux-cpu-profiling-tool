#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collector.py - 7x24 Linux 持续 CPU Profiling 采集器（生产可用）

核心思路：
  - 常驻后台无限循环，每 60 秒抓取一次全局 CPU profile：
      perf record -F 99 -a -g -o data/perf_YYYYMMDD_HHMMSS.data -- sleep 60
  - 启动时自动创建 data/ 目录
  - 每轮结束后做“磁盘防打满”：自动删除 data/ 下超过 3 天的 .data 过期文件
  - 优雅退出：捕获 SIGINT/SIGTERM，默认“慢退出”（等本轮 perf 采集结束再退出）
      若在退出过程中再次收到信号，则会尝试中断正在运行的 perf 进程（快速退出兜底）

运行建议（生产）：
  - 使用 systemd 管理（Restart=always），并限制 data/ 所在磁盘配额/独立分区
  - perf 通常需要 root 或具备 perf_event_paranoid 配置权限
"""

from __future__ import annotations

import datetime as _dt
import os
import signal
import subprocess
import time
from pathlib import Path


DATA_DIR = Path("data")
SAMPLE_FREQ_HZ = 99
INTERVAL_SECONDS = 60
RETENTION_DAYS = 3

# 退出控制：第一次信号 -> 慢退出；第二次信号 -> 尝试打断 perf
_stop_requested = False
_force_stop_requested = False
_running_proc: subprocess.Popen[bytes] | None = None


def _ts_now() -> str:
    return _dt.datetime.now().strftime("%Y%m%d_%H%M%S")


def _log(msg: str) -> None:
    # “语音式”日志：对运维同学友好，直接看终端就知道在做什么
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] {msg}", flush=True)


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _cleanup_old_data_files(retention_days: int) -> None:
    """
    清理 data/ 下过期的 perf_*.data 文件，避免磁盘被长期 7x24 采集打满。
    这里用 mtime 作为判定标准：更贴近“文件占用磁盘时间”的现实。
    """
    cutoff = time.time() - retention_days * 24 * 3600
    removed = 0
    failed = 0

    patterns = ("perf_*.data", "perf_*.data.tmp", "perf_*.data.old")
    files_to_check = []
    for pattern in patterns:
        files_to_check.extend(DATA_DIR.glob(pattern))

    for p in files_to_check:
        try:
            st = p.stat()
        except FileNotFoundError:
            continue

        if st.st_mtime < cutoff:
            try:
                p.unlink()
                removed += 1
            except Exception:
                failed += 1

    if removed or failed:
        extra = []
        if removed:
            extra.append(f"已删除过期文件 {removed} 个")
        if failed:
            extra.append(f"删除失败 {failed} 个（可能权限不足或文件被占用）")
        _log("清理完成：" + "，".join(extra) + "。")


def _signal_handler(signum: int, _frame) -> None:
    global _stop_requested, _force_stop_requested, _running_proc

    try:
        sig_name = signal.Signals(signum).name
    except Exception:
        sig_name = str(signum)

    if not _stop_requested:
        _stop_requested = True
        _log(f"收到 {sig_name}，将于本轮采集结束后优雅退出（慢退出）。")
        return

    # 第二次信号：兜底快速退出
    _force_stop_requested = True
    _log(f"再次收到 {sig_name}，将尝试中断正在运行的 perf 采集（快速退出兜底）。")
    if _running_proc is None:
        return

    try:
        # perf record 对 SIGINT 处理通常更“温和”，会尽量写完输出文件
        os.killpg(os.getpgid(_running_proc.pid), signal.SIGINT)
    except Exception:
        try:
            _running_proc.terminate()
        except Exception:
            pass


def _run_perf_record(output_file: Path) -> int:
    """
    启动 perf record 并等待完成。
    返回 exit code（0 表示正常）。
    """
    global _running_proc

    tmp_output = output_file.with_suffix(output_file.suffix + ".tmp")
    if tmp_output.exists():
        try:
            tmp_output.unlink()
        except Exception:
            pass

    cmd = [
        "perf",
        "record",
        "-F",
        str(SAMPLE_FREQ_HZ),
        "-a",
        "-g",
        "-o",
        str(tmp_output),
        "--",
        "sleep",
        str(INTERVAL_SECONDS),
    ]

    _log(f"正在采集全局 CPU 性能数据（{INTERVAL_SECONDS}s），输出：{output_file} ...")

    # 使用独立进程组：便于信号时对整个 perf 进程组做处理
    _running_proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=os.setsid,  # Linux/Unix: setsid
    )

    out, err = _running_proc.communicate()
    rc = _running_proc.returncode
    _running_proc = None

    if rc != 0:
        # 失败样本直接清理，避免 analyzer 误选到损坏/空文件
        try:
            if tmp_output.exists():
                tmp_output.unlink()
        except Exception:
            pass

    if rc == 0:
        # 原子落盘：只有“看起来有效”的样本才改名为正式文件
        try:
            size = tmp_output.stat().st_size
        except FileNotFoundError:
            size = 0

        if size <= 0:
            try:
                tmp_output.unlink()
            except Exception:
                pass
            _log("本轮采集结束，但生成了零字节数据文件，已自动丢弃。")
            return 2

        try:
            tmp_output.replace(output_file)
        except Exception as e:
            _log(f"临时数据文件转正失败：{e}（已保留临时文件：{tmp_output}）")
            return 2

        _log(f"本轮采集完成，样本有效（{size} bytes）。")
        return 0

    # perf 的错误信息通常在 stderr
    err_text = (err or b"").decode(errors="replace").strip()
    out_text = (out or b"").decode(errors="replace").strip()
    tail = "\n".join([x for x in [out_text, err_text] if x])
    if tail:
        _log(f"采集异常：perf 返回码={rc}，输出如下（节选）：\n{tail}")
    else:
        _log(f"采集异常：perf 返回码={rc}，但未捕获到输出。")

    return rc


def main() -> int:
    global _stop_requested, _force_stop_requested

    _ensure_data_dir()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    _log("采集器已启动（7x24 常驻）。提示：停止可发送 SIGTERM（慢退出），或连发两次以快速退出。")

    while True:
        ts = _ts_now()
        output = DATA_DIR / f"perf_{ts}.data"

        rc = _run_perf_record(output)

        # 每轮结束都做一次清理，避免无人值守时磁盘逐步打满
        _cleanup_old_data_files(RETENTION_DAYS)

        if _stop_requested:
            _log("已按要求优雅退出。")
            return 0

        # 如果 perf 失败，为了生产稳定性：稍微退避一下再重试
        if rc != 0:
            backoff = 5
            _log(f"将于 {backoff}s 后重试下一轮采集。")
            for _ in range(backoff):
                if _force_stop_requested:
                    _log("快速退出请求已触发，采集器退出。")
                    return 1
                time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())

