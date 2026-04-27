# Linux 7x24 持续 CPU Profiling 工具

## 1. 项目简介 (Project Overview)
本项目是一款专为 Linux 环境设计的轻量级、全天候 CPU 性能监控工具。它能够像“黑匣子”一样常驻后台，持续记录全系统的 CPU 堆栈信息，并支持在需要时通过指定时间戳快速回溯生成 **火焰图 (FlameGraph)**，帮助运维与开发人员精准定位性能抖动、CPU 飙升的根因。

---

## 2. 设计说明 (Design Specification)

### 2.1 架构设计
项目采用典型的 **采集 (Collector) -> 存储 (Storage) -> 分析 (Analyzer)** 三层工程架构：
* **采集层**：利用 Linux 内核原生的 `perf_events` 子系统。通过 Python 异步子进程调度，实现对系统调用栈的非侵入式采样。
* **存储层**：采用按需归档策略。每 60 秒生成一个带时间戳的 `.data` 二进制文件，确保数据的颗粒度足以支持故障回溯。
* **分析层**：深度集成开源 FlameGraph 工具链。通过管道流式处理 `perf script` 的输出，实现从原始二进制数据到交互式矢量图（SVG）的自动化转换。

### 2.2 核心设计亮点
* **低开销生产安全**：默认采用 **99Hz** 的采样频率（非整数频率可避开系统定时器中断共振）。相比于高频采样，99Hz 既能保证统计学的准确性，又将 CPU 额外开销控制在 1% 以内，适配生产环境长期运行。
* **工业级磁盘空间保护**：脚本内置文件轮转逻辑。每一轮采样周期后会自动扫描日志目录，强制清理超过 **3 天**（可配置）的历史数据，从底层杜绝由于监控日志占满磁盘导致的次生灾害。
* **信号驱动的优雅退出**：完整实现了 `SIGINT` 和 `SIGTERM` 信号捕获。在接收到停止指令时，程序会优先完成当前采样缓冲区的数据刷盘，确保文件的完整性。
* **鲁棒的权限处理**：针对 Linux 内核权限限制，分析脚本内置了强制读取（Force Mode）机制，能够处理跨用户权限生成的采样文件。

---

## 3. 使用说明 (Usage Instructions)

### 3.1 环境要求
* **OS**: Linux (推荐 Ubuntu 20.04+, CentOS 7+ 等)
* **内核组件**: 需安装 `perf` 工具 (linux-tools)
* **运行环境**: Python 3.6+, Perl (FlameGraph 脚本依赖)

**快速安装依赖：**
```bash
sudo apt update
sudo apt install linux-tools-common linux-tools-generic linux-tools-`uname -r` git -y
第一步：准备工具链
# 克隆本项目
git clone [https://github.com/DAo-ii/linux-cpu-profiling-tool.git](https://github.com/DAo-ii/linux-cpu-profiling-tool.git)
cd linux-cpu-profiling-tool

# 拉取火焰图生成脚本
git clone [https://github.com/brendangregg/FlameGraph.git](https://github.com/brendangregg/FlameGraph.git)

第二步：开启7x24采集
为了获取全系统调用栈权限，请使用sudo启动：
sudo python3 collector.py
第三步：一键生成火焰图分析
当系统出现异常（例如在 17:53 出现卡顿）时，使用对应的时刻或最接近的计时器进行分析：
# 参数格式：YYYYMMDD_HHMMSS
sudo python3 analyzer.py 20260427_175329
