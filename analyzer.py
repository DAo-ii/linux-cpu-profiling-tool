#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyzer.py - 根因定位与火焰图生成器（生产可用）

用法：
  ./analyzer.py 20260427_163000
  ./analyzer.py 20260427_1630        # 也支持无秒格式（自动补 00 秒）

功能：
  - 在 data/ 目录中寻找距离“输入时间”最近的 perf 数据文件（perf_YYYYMMDD_HHMMSS.data）
  - 基于该归档文件生成火焰图：
      perf script -i <file> | FlameGraph/stackcollapse-perf.pl | FlameGraph/flamegraph.pl > flamegraph_<ts>.svg

实现要点（生产实践）：
  - 尽量不依赖 shell 管道，使用 Popen 串联，避免 shell 注入与 quoting 坑
  - 当文件名时间戳可解析时，优先用“文件名时间”做最近匹配；解析失败则回退到 mtime
"""

from __future__ import annotations

import argparse
import datetime as _dt
import re
import subprocess
from pathlib import Path


DATA_DIR = Path("data")
FG_DIR = Path("FlameGraph")
STACKCOLLAPSE = FG_DIR / "stackcollapse-perf.pl"
FLAMEGRAPH = FG_DIR / "flamegraph.pl"

_PERF_FILE_RE = re.compile(r"^perf_(\d{8}_\d{6})\.data$")


def _log(msg: str) -> None:
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{now}] {msg}", flush=True)


def _parse_user_time(s: str) -> _dt.datetime:
    """
    支持两种输入：
      - YYYYMMDD_HHMMSS（标准）
      - YYYYMMDD_HHMM（常见口头输入；默认补 00 秒）
    """
    s = s.strip()
    for fmt in ("%Y%m%d_%H%M%S", "%Y%m%d_%H%M"):
        try:
            dt = _dt.datetime.strptime(s, fmt)
            if fmt == "%Y%m%d_%H%M":
                dt = dt.replace(second=0)
            return dt
        except ValueError:
            continue
    raise ValueError(f"时间格式不正确：{s}（期望 YYYYMMDD_HHMMSS 或 YYYYMMDD_HHMM）")


def _extract_ts_from_filename(p: Path) -> _dt.datetime | None:
    m = _PERF_FILE_RE.match(p.name)
    if not m:
        return None
    try:
        return _dt.datetime.strptime(m.group(1), "%Y%m%d_%H%M%S")
    except ValueError:
        return None


def _find_nearest_perf_data(target_time: _dt.datetime) -> Path:
    if not DATA_DIR.exists():
        raise FileNotFoundError("未找到 data/ 目录。请先运行 collector.py 采集数据。")

    candidates = list(DATA_DIR.glob("perf_*.data"))
    if not candidates:
        raise FileNotFoundError("data/ 目录下没有找到 perf_*.data 文件。")

    # 优先用“文件名时间戳”找最近；若解析失败则用 mtime 兜底
    # 同时过滤零字节文件：它们通常是采集中断/失败留下的无效样本。
    scored: list[tuple[float, Path, str]] = []
    skipped_zero_sized = 0
    for p in candidates:
        try:
            st = p.stat()
        except FileNotFoundError:
            continue

        if st.st_size <= 0:
            skipped_zero_sized += 1
            continue

        ts = _extract_ts_from_filename(p)
        if ts is not None:
            delta = abs((ts - target_time).total_seconds())
            scored.append((delta, p, "filename_ts"))
        else:
            mtime = _dt.datetime.fromtimestamp(st.st_mtime)
            delta = abs((mtime - target_time).total_seconds())
            scored.append((delta, p, "mtime"))

    if not scored:
        if skipped_zero_sized > 0:
            raise FileNotFoundError(
                f"找到 {skipped_zero_sized} 个 perf_*.data 文件，但全部为零字节无效样本。"
                "请检查 collector.py 运行状态、权限与 perf 采集日志。"
            )
        raise FileNotFoundError("未能对任何 perf_*.data 文件进行时间匹配（文件可能被删除或不可读）。")

    scored.sort(key=lambda x: x[0])
    best_delta, best_path, best_mode = scored[0]
    if skipped_zero_sized > 0:
        _log(f"已自动跳过 {skipped_zero_sized} 个零字节无效样本。")
    _log(f"已选择最近的采样文件：{best_path}（匹配方式={best_mode}，时间差≈{int(best_delta)}s）。")
    return best_path


def _check_dependencies() -> None:
    # 这些检查是“提前失败”的生产习惯：避免跑一半才发现缺命令/脚本不可执行
    if not STACKCOLLAPSE.exists():
        raise FileNotFoundError(f"未找到 {STACKCOLLAPSE}（请确认 FlameGraph 仓库已克隆在项目根目录）。")
    if not FLAMEGRAPH.exists():
        raise FileNotFoundError(f"未找到 {FLAMEGRAPH}（请确认 FlameGraph 仓库已克隆在项目根目录）。")

    # perl 脚本不一定有可执行位，这里统一用 perl 调起，最大化兼容性
    # perf 命令是否存在由后续 Popen 直接报错即可；这里不额外依赖 which。


def _run_pipeline(perf_data: Path, out_svg: Path) -> None:
    """
    等价于：
      perf script -i perf_data | perl stackcollapse-perf.pl | perl flamegraph.pl > out_svg
    """
    _log("正在解析 perf 数据并生成火焰图（可能需要一些时间）...")

    with out_svg.open("wb") as f_out:
        p1 = subprocess.Popen(
            ["perf", "script", "-i", str(perf_data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        p2 = subprocess.Popen(
            ["perl", str(STACKCOLLAPSE)],
            stdin=p1.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert p1.stdout is not None
        p1.stdout.close()  # 让 p1 在下游退出时能收到 SIGPIPE

        p3 = subprocess.Popen(
            ["perl", str(FLAMEGRAPH)],
            stdin=p2.stdout,
            stdout=f_out,
            stderr=subprocess.PIPE,
        )
        assert p2.stdout is not None
        p2.stdout.close()

        _, err1 = p1.communicate()
        _, err2 = p2.communicate()
        err3 = p3.stderr.read() if p3.stderr is not None else b""
        rc3 = p3.wait()

    if p1.returncode != 0:
        raise RuntimeError(f"perf script 失败（rc={p1.returncode}）：{(err1 or b'').decode(errors='replace').strip()}")
    if p2.returncode != 0:
        raise RuntimeError(
            f"stackcollapse-perf.pl 失败（rc={p2.returncode}）：{(err2 or b'').decode(errors='replace').strip()}"
        )
    if rc3 != 0:
        raise RuntimeError(f"flamegraph.pl 失败（rc={rc3}）：{(err3 or b'').decode(errors='replace').strip()}")

 
def _run_pipeline_with_fallback(perf_data: Path, out_svg: Path) -> None:
    """
    首选普通模式；若遇到 perf.data ownership 限制，则自动回退到 perf script -f。
    这能覆盖“采集用户与分析用户不一致”这种生产现场常见场景。
    """
    try:
        _run_pipeline(perf_data, out_svg)
        return
    except RuntimeError as e:
        msg = str(e)
        ownership_issue = (
            "not owned by current user or root" in msg
            or "use -f to override" in msg
        )
        if not ownership_issue:
            raise

        _log("检测到 perf.data 归属限制，自动切换为强制模式：perf script -f ...")

    with out_svg.open("wb") as f_out:
        p1 = subprocess.Popen(
            ["perf", "script", "-f", "-i", str(perf_data)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        p2 = subprocess.Popen(
            ["perl", str(STACKCOLLAPSE)],
            stdin=p1.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert p1.stdout is not None
        p1.stdout.close()

        p3 = subprocess.Popen(
            ["perl", str(FLAMEGRAPH)],
            stdin=p2.stdout,
            stdout=f_out,
            stderr=subprocess.PIPE,
        )
        assert p2.stdout is not None
        p2.stdout.close()

        _, err1 = p1.communicate()
        _, err2 = p2.communicate()
        err3 = p3.stderr.read() if p3.stderr is not None else b""
        rc3 = p3.wait()

    if p1.returncode != 0:
        raise RuntimeError(
            f"perf script -f 失败（rc={p1.returncode}）：{(err1 or b'').decode(errors='replace').strip()}"
        )
    if p2.returncode != 0:
        raise RuntimeError(
            f"stackcollapse-perf.pl 失败（rc={p2.returncode}）：{(err2 or b'').decode(errors='replace').strip()}"
        )
    if rc3 != 0:
        raise RuntimeError(f"flamegraph.pl 失败（rc={rc3}）：{(err3 or b'').decode(errors='replace').strip()}")


def main() -> int:
    ap = argparse.ArgumentParser(description="根据指定时间点生成最近 perf 采样的 CPU 火焰图")
    ap.add_argument("time", help="时间点：YYYYMMDD_HHMMSS 或 YYYYMMDD_HHMM（如 20260427_163000）")
    ap.add_argument(
        "--output",
        default=None,
        help="输出 SVG 文件名（默认 flamegraph_<采样文件时间戳>.svg）",
    )
    args = ap.parse_args()

    try:
        target_time = _parse_user_time(args.time)
    except ValueError as e:
        _log(str(e))
        return 2

    try:
        _check_dependencies()
        perf_data = _find_nearest_perf_data(target_time)
    except Exception as e:
        _log(f"准备阶段失败：{e}")
        return 2

    ts = _extract_ts_from_filename(perf_data)
    out_name = args.output
    if not out_name:
        # 输出名默认使用“采样文件时间戳”，便于事后溯源（火焰图与采样一一对应）
        out_ts = ts.strftime("%Y%m%d_%H%M%S") if ts else _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        out_name = f"flamegraph_{out_ts}.svg"
    out_svg = Path(out_name)

    try:
        _run_pipeline_with_fallback(perf_data, out_svg)
    except FileNotFoundError as e:
        _log(f"命令不存在或不可执行：{e}（请确认已安装 perf 与 perl，并具备读取 perf.data 的权限）")
        return 3
    except Exception as e:
        _log(f"生成失败：{e}")
        return 3

    # 简单 sanity check：文件非空才算成功（防止输出被错误重定向成空文件）
    try:
        size = out_svg.stat().st_size
    except FileNotFoundError:
        size = 0
    if size <= 0:
        _log("火焰图生成完成，但输出文件为空；请检查 perf 采样是否有效、符号是否可解析。")
        return 4

    _log(f"成功生成模板图：{out_svg}（大小 {size} bytes）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

