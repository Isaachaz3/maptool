"""Проставляет версию в адреса скриптов и импортов (?v=...), чтобы браузер не смешивал
старые модули из кэша GitHub Pages с новыми. Запускать перед каждым коммитом:
    python3 tools/bump.py
"""
import glob
import hashlib
import re

files = ['index.html', 'player.html'] + sorted(glob.glob('js/*.js'))
h = hashlib.sha1()
for f in sorted(glob.glob('js/*.js')) + ['css/style.css', 'assets/fonts.css']:
    src = re.sub(r'\?v=[0-9a-f]+', '', open(f, encoding='utf-8').read())
    h.update(src.encode())
v = h.hexdigest()[:8]
pat = re.compile(r"""((?:from\s+|import\s*\(\s*|src=|href=)['"])((?:\./|js/|css/|assets/)[\w./-]+\.(?:js|css))(?:\?v=[0-9a-f]+)?(['"])""")
for f in files:
    s = open(f, encoding='utf-8').read()
    n = pat.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={v}{m.group(3)}', s)
    if n != s:
        open(f, 'w', encoding='utf-8').write(n)
print('version', v)
