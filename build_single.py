"""Gộp index.html + css + js thành một file LiarPoker.html duy nhất.
Chạy: python liars_poker/build_single.py
Dùng để gửi cho bạn bè — chỉ cần mở đúng 1 file là chơi được."""
import pathlib

root = pathlib.Path(__file__).resolve().parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'style.css').read_text(encoding='utf-8')

html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '\n</style>')
for name in ('engine.js', 'bots.js'):
    js = (root / name).read_text(encoding='utf-8')
    html = html.replace('<script src="' + name + '"></script>', '<script>\n' + js + '\n</script>')

mqttjs = (root / 'vendor' / 'mqtt.min.js').read_text(encoding='utf-8')
html = html.replace('<script src="vendor/mqtt.min.js"></script>', '<script>\n' + mqttjs + '\n</script>')

js = (root / 'app.js').read_text(encoding='utf-8')
html = html.replace('<script src="app.js"></script>', '<script>\n' + js + '\n</script>')

out = root / 'LiarPoker.html'
out.write_text(html, encoding='utf-8')
print('Built', out, '(', len(html), 'chars )')
