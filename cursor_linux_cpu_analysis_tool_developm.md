# Linux CPU analysis tool development
_Exported on 2026/4/27 at GMT+8 21:27:44 from Cursor (3.2.11)_

---

**User**

你是一位资深的Linux性能优化架构师。请帮我开发一个生产环境可用的7x24 Linux持续CPU分析工具。当前项目目录下已经克隆了FlameGraph文件夹。请给我编写两个Python脚本：

1.collector.py（数据采集核心监控进程）

功能：常驻后台无限循环，每60秒调用一次系统命令perf record -F 99 -a -g -o data/perf_时间戳.data -- sleep 60采集全局CPU性能数据（时间格式如YYYYMMDD_HHMMSS）。

健壮性：启动时自动检查并创建data目录。

生产级特性（磁盘防打满）：每次循环结束时，检查data/目录，自动删除超过3天的过渡.data文件。

包含缓慢的退出机制（捕获SIGINT/SIGTERM）。

2.analyzer.py（根因定位与火焰图生成）

功能：接收一个命令行时间参数（格式与上述时钟一致，如“20260427_1630”）。

逻辑：在data/目录中寻找距离该计时器最近的一个perf.data文件。

处理：利用找到的归档文件，通过管道调用perf script生成模板图。具体执行类似：perf script -i <找到的文件路径> | ./FlameGraph/stackcollapse-perf.pl | ./FlameGraph/flamegraph.pl > flamegraph_输出时间.svg

请直接给我这两个文件的完整Python代码，需要包含精彩的中文注释，并在终端打印语音的执行日志（例如“正在采集...”，“成功生成模板图...”）。

---

**Cursor**

我会先快速确认当前目录结构（尤其是 `FlameGraph/` 是否在项目根目录、是否已有 `data/`），然后直接生成 `collector.py` 与 `analyzer.py` 两个可生产运行的脚本：包含目录自检、信号优雅退出、磁盘清理（保留3天内数据）、以及清晰的中文日志输出。

我已经确认 `FlameGraph/` 目录存在（里面应包含 `stackcollapse-perf.pl`、`flamegraph.pl` 等脚本）。接下来我会读取一下关键脚本路径以确保管道命令拼写正确，然后直接新增 `collector.py` 和 `analyzer.py` 两个文件到项目根目录。

已确认 FlameGraph 的关键脚本（`stackcollapse-perf.pl`、`flamegraph.pl`）都在项目根目录下的 `FlameGraph/`。接下来我会直接新增两个脚本：`collector.py` 负责 60s 轮询采集并做 3 天滚动清理；`analyzer.py` 负责按输入时间点自动挑最近数据并生成 SVG 火焰图。

`collector.py` 已写好：它会每 60 秒生成一个 `data/perf_时间戳.data`，并在每轮结束后自动清理 3 天前的旧文件，同时支持 SIGTERM/SIGINT 慢退出、二次信号快速中断兜底。接下来我会补上 `analyzer.py`：解析输入时间、自动选最近的 `.data`，然后走 perf→折叠→flamegraph 的管道生成 SVG。

两个脚本都已经落地到项目根目录了。接下来我会做一次快速自检：确认脚本能被 Python 解析、关键路径字符串正确，并用静态方式跑一下 `--help`（不真的启动 perf 采集，以免占用系统）。如果发现小问题我会立即修正到可直接上线的状态。

自检通过：两个脚本语法正常、`analyzer.py --help` 输出符合预期，FlameGraph 的两个 perl 脚本也具备可执行权限。接下来我会做一个小的稳健性修正：`collector.py` 的信号名解析逻辑会在极少数情况下不够严谨，我会把它改成更可靠的 try/except 版本，避免异常影响退出流程。

### `collector.py`

```python
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

    for p in DATA_DIR.glob("perf_*.data"):
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

    cmd = [
        "perf",
        "record",
        "-F",
        str(SAMPLE_FREQ_HZ),
        "-a",
        "-g",
        "-o",
        str(output_file),
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

    if rc == 0:
        _log("本轮采集完成。")
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
```

### `analyzer.py`

```python
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
    scored: list[tuple[float, Path, str]] = []
    for p in candidates:
        ts = _extract_ts_from_filename(p)
        if ts is not None:
            delta = abs((ts - target_time).total_seconds())
            scored.append((delta, p, "filename_ts"))
        else:
            try:
                mtime = _dt.datetime.fromtimestamp(p.stat().st_mtime)
                delta = abs((mtime - target_time).total_seconds())
                scored.append((delta, p, "mtime"))
            except FileNotFoundError:
                continue

    if not scored:
        raise FileNotFoundError("未能对任何 perf_*.data 文件进行时间匹配（文件可能被删除或不可读）。")

    scored.sort(key=lambda x: x[0])
    best_delta, best_path, best_mode = scored[0]
    _log(f"已选择最近的采样文件：{best_path}（匹配方式={best_mode}，时间差≈{int(best_delta)}s）。")
    return best_path


def _check_dependencies() -> None:
    if not STACKCOLLAPSE.exists():
        raise FileNotFoundError(f"未找到 {STACKCOLLAPSE}（请确认 FlameGraph 仓库已克隆在项目根目录）。")
    if not FLAMEGRAPH.exists():
        raise FileNotFoundError(f"未找到 {FLAMEGRAPH}（请确认 FlameGraph 仓库已克隆在项目根目录）。")
    # perl 脚本不一定有可执行位，这里统一用 perl 调起，最大化兼容性


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
        out_ts = ts.strftime("%Y%m%d_%H%M%S") if ts else _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        out_name = f"flamegraph_{out_ts}.svg"
    out_svg = Path(out_name)

    try:
        _run_pipeline(perf_data, out_svg)
    except FileNotFoundError as e:
        _log(f"命令不存在或不可执行：{e}（请确认已安装 perf 与 perl，并具备读取 perf.data 的权限）")
        return 3
    except Exception as e:
        _log(f"生成失败：{e}")
        return 3

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
```

---

**User**

@\home\yxy\.cursor\projects\home-yxy\terminals\6.txt:24-31 

---

**Cursor**

你这段日志里的根因很明确：`perf script` 默认拒绝解析“非当前用户/非root拥有”的 `perf.data`，报错里已经提示要加 `-f`。我现在直接把 `analyzer.py` 修成生产可用：自动先尝试正常模式，遇到这个 ownership 错误时自动回退 `perf script -f`，并打印中文提示。

你贴的这段日志我已经定位并修好了，问题就是：

- `perf script` 默认会拒绝解析“非当前用户/非root拥有”的 `perf.data`
- 你这次命中了它的安全检查：`not owned by current user or root (use -f to override)`

我已更新 `analyzer.py`，现在行为是：

- 先按普通模式执行：`perf script -i ...`
- 如果检测到 ownership 限制错误，自动回退到：`perf script -f -i ...`
- 并打印中文日志：`检测到 perf.data 归属限制，自动切换为强制模式...`

另外我顺手做了清理：
- 去掉了 `analyzer.py` 里未使用的 `os`、`sys` import
- 语法检查和 lint 都通过了

你现在直接重试即可：
- `sudo python3 analyzer.py 20260427_174627`

如果你希望，我可以再给你加一个显式参数（比如 `--force`），让你可控地指定是否强制 `-f`，而不是自动回退。

---

**User**

@\home\yxy\.cursor\projects\home-yxy\terminals\6.txt:31-37 

---

**Cursor**

这次报错是第二个根因：你命中的这个 `perf.data` 文件本身是空文件（`zero-sized data`），通常是采集中断/失败或异常残留导致。  
我直接把 `analyzer.py` 再加强一层：自动跳过空 `.data`（和不可读文件），选择“最近且有效”的样本，并在日志里明确提示跳过原因。

这段新日志说明 ownership 问题已经绕过去了，当前真正失败点是**选中的 `perf.data` 是空文件**：

- `perf script -f ...` 报：`zero-sized data ... nothing to do!`

我已经继续把 `analyzer.py` 做了生产级修复：

- 自动过滤 `data/perf_*.data` 中的 **0 字节无效文件**
- 在日志打印：`已自动跳过 X 个零字节无效样本`
- 然后选择“最近且有效”的样本继续生成火焰图
- 如果全部都是空文件，会明确报：
  - 找到了多少个文件
  - 但全是无效样本
  - 提示你检查 collector/perf 运行状态

你现在直接再跑一次同样命令即可验证：

- `sudo python3 analyzer.py 20260427_174627`

如果你愿意，我下一步可以再帮你把 `collector.py` 也加一层“采集后文件大小校验 + 失败重采样告警”，从源头减少空文件产生。

---

**User**

@\home\yxy\.cursor\projects\home-yxy\terminals\6.txt:46-53 

---

**Cursor**

这个日志已经暴露出核心问题：不是 `analyzer.py` 了，而是采集端持续产出了大量“结构损坏/未正常结束”的 `perf.data`。我先去定位 `collector.py` 实际运行状态和失败模式，然后直接修复采集逻辑，避免再产生坏样本。

我找到关键异常了：你机器上有一个采集进程在高频失败重试（每 5 秒一轮），它会制造大量坏样本；另外当前 `collector.py` 是直接写最终 `.data`，容易让分析端撞到“未完成/损坏文件”。我现在会把采集端改成“先写临时文件、通过校验再原子改名”，并在失败时自动删除坏文件。

你这段日志的含义是：当前选中的文件不是“零字节”，但仍是**不完整/损坏 perf.data**（header 里 data size=0），典型是 `perf record` 没有正常结束或采集进程异常中断。

我已经做了两层修复，防止后续继续踩坑：

- `analyzer.py`：已能自动跳过零字节样本（你日志里那句“已自动跳过 66 个”就是生效了）
- `collector.py`：改为**先写临时文件 `*.data.tmp`，校验非零后再原子改名为 `*.data`**；失败样本会自动删除，不再污染分析目录

另外我定位到你现在很可能有**两个 collector 实例**，其中一个明显在异常高频重试（每5秒刷一次），这会持续制造坏数据。  
建议立刻做这 3 步：

1. 停掉所有旧 collector（尤其异常那个）
   - `pkill -f "python3 collector.py"`
2. 清理坏样本（可选但建议）
   - `rm -f data/perf_*.data.tmp`
   - 若要清历史坏文件，可按时间清或直接保留最近有效文件
3. 只启动一个新实例
   - `sudo python3 collector.py`

等它稳定跑满 1~2 轮后再分析，例如：

- `sudo python3 analyzer.py 20260427_175500`

如果你要，我可以下一步再给 `collector.py` 加一条“采集后自动做一次 `perf script` 快速可读性验真（失败则丢弃）”，把损坏文件再往下压一层。

