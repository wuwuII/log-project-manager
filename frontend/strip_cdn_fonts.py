#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剥掉构建产物 CSS 里指向 cdn.svar.dev 的 @font-face。

为什么必须做（离线交付要求）：
  SVAR 甘特图的样式表里自带 6 段 @font-face，字体文件指向 https://cdn.svar.dev/...。
  目标机是不联网的 Windows，这些请求必然失败；离线包不应该有任何外部依赖。
  这些字体（Roboto / Open Sans）只是 SVAR 的默认西文字体，删掉后会自动回落到
  系统字体（Windows 上是微软雅黑 / Segoe UI），界面不受影响。

用法: python3 strip_cdn_fonts.py <dist 目录或 css 文件...>
"""
import re
import sys
import glob
import os

FONT_FACE_RE = re.compile(r"@font-face\{[^}]*\}")


def strip_css(path: str) -> int:
    src = open(path, encoding="utf-8", errors="replace").read()
    removed = []

    def repl(m):
        blk = m.group(0)
        if "cdn.svar.dev" in blk or "svar.dev" in blk:
            removed.append(blk[:60])
            return ""
        return blk

    out = FONT_FACE_RE.sub(repl, src)
    if removed:
        open(path, "w", encoding="utf-8").write(out)
    return len(removed)


def main(argv):
    targets = []
    for a in argv[1:]:
        if os.path.isdir(a):
            targets += glob.glob(os.path.join(a, "**", "*.css"), recursive=True)
        else:
            targets.append(a)
    total = 0
    for t in targets:
        if not t.endswith(".css") or not os.path.exists(t):
            continue
        n = strip_css(t)
        if n:
            print(f"  {os.path.basename(t)}: 剥掉 {n} 段 CDN @font-face")
        total += n
    # 复查
    for t in targets:
        if not t.endswith(".css") or not os.path.exists(t):
            continue
        left = open(t, encoding="utf-8", errors="replace").read().count("svar.dev")
        print(f"  复查 {os.path.basename(t)}: 残留 svar.dev 引用 {left} 处")
    print(f"合计剥掉 {total} 段")
    return 0 if total >= 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
