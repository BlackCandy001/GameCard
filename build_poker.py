"""Gộp poker.html + CSS + JS + MQTT.js thành một file PokerMode.html duy nhất.
Chạy: python liars_poker/build_poker.py
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent
html = (root / 'poker.html').read_text(encoding='utf-8')
css1 = (root / 'style.css').read_text(encoding='utf-8')
css2 = (root / 'poker.css').read_text(encoding='utf-8')

html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css1 + '\n</style>')
html = html.replace('<link rel="stylesheet" href="poker.css">', '<style>\n' + css2 + '\n</style>')

for name in ('poker_engine.js', 'poker_bots.js'):
    js = (root / name).read_text(encoding='utf-8')
    html = html.replace('<script src="' + name + '"></script>', '<script>\n' + js + '\n</script>')

mqttjs = (root / 'vendor' / 'mqtt.min.js').read_text(encoding='utf-8')
html = html.replace('<script src="vendor/mqtt.min.js"></script>', '<script>\n' + mqttjs + '\n</script>')

js = (root / 'poker_app.js').read_text(encoding='utf-8')
html = html.replace('<script src="poker_app.js"></script>', '<script>\n' + js + '\n</script>')

out = root / 'PokerMode.html'
out.write_text(html, encoding='utf-8')
print('Built', out, '(', len(html), 'chars )')
