#!/usr/bin/env python3
"""index.html + style.css + game.js + assets → dist/reaction-gp.html (단일 파일, 서버 없이 더블클릭 실행)."""
import base64, pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).parent
MIME = {'.woff2': 'font/woff2', '.webp': 'image/webp'}

def data_uri(rel):
    p = ROOT / rel
    return f"data:{MIME[p.suffix]};base64,{base64.b64encode(p.read_bytes()).decode()}"

def sub(text, old, new):
    assert old in text, f'빌드 실패: {old!r} 를 찾을 수 없음 (소스가 바뀌었으면 build.py도 고치세요)'
    return text.replace(old, new)

css = (ROOT / 'style.css').read_text('utf-8')
for f in ('assets/fonts/PressStart2P.woff2', 'assets/fonts/Galmuri11.woff2'):
    css = sub(css, f'url({f})', f'url({data_uri(f)})')

js = (ROOT / 'game.js').read_text('utf-8')
# file:// 페이지에서 그린 이미지는 canvas getImageData가 막힘 → data: URI로 넣으면 해결
js = sub(js, "'assets/bg.webp'", f"'{data_uri('assets/bg.webp')}'")
assert '</script' not in js

html = (ROOT / 'index.html').read_text('utf-8')
html = sub(html, '<link rel="preload" href="assets/fonts/PressStart2P.woff2" as="font" type="font/woff2" crossorigin>\n', '')
html = sub(html, '<link rel="preload" href="assets/fonts/Galmuri11.woff2" as="font" type="font/woff2" crossorigin>\n', '')
html = sub(html, '<link href="style.css" rel="stylesheet">', f'<style>{css}</style>')
html = sub(html, '<script src="game.js"></script>', f'<script>{js}</script>')

out = ROOT / 'dist/reaction-gp.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html, 'utf-8')
print(f'{out} ({out.stat().st_size / 1e6:.1f} MB)')

# 실행 파일: HTML을 내장한 localhost 서버 (YouTube BGM 재생 가능). bun 필요, 각 OS 런타임을 처음 한 번 내려받음
if not shutil.which('bun'):
    sys.exit('bun이 없어 실행 파일은 건너뜁니다. (https://bun.sh)')
for target, name in [('bun-windows-x64', 'reaction-gp-windows.exe'), ('bun-darwin-arm64', 'reaction-gp-mac-apple'),
                     ('bun-darwin-x64', 'reaction-gp-mac-intel'), ('bun-linux-x64', 'reaction-gp-linux')]:
    subprocess.run(['bun', 'build', 'server.js', '--compile', f'--target={target}', '--outfile', f'dist/{name}'], cwd=ROOT, check=True)
