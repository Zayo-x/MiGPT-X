#!/usr/bin/env python3
"""TTS 微服务：支持小米 MiMo 与微软 edge-tts 两套引擎。

engine=clone  小米 MiMo 音色复刻（参考音频克隆，3~25 秒，需 API Key）
engine=mimo   小米 MiMo 文字描述音色（1~2 秒，需 API Key）
engine=edge   微软 edge-tts（免费、无需 Key、1~2 秒、音色多）

MiMo 分支带长度守卫：复刻偶尔会生成远超文本长度的音频（实测 18 字生成了 48 秒），
超限自动重试，两次都不合格则回退到风格引擎。

微软分支的变速由 edge-tts 自身完成（rate 参数），所以不再走 apply_speed，
否则会变速两次。语速字段 speed 会自动换算成 edge 的 rate 百分比。
"""
import base64, json, os, subprocess, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TTS_DIR = os.environ.get('MIGPT_TTS_DIR', '/root/migpt-panel/tts')
EDITABLE = os.environ.get('MIGPT_EDITABLE', '/root/migpt-next-2/editable.json')
PORT = int(os.environ.get('MIGPT_TTS_PORT', '36594'))
MIMO_API = 'https://api.xiaomimimo.com/v1/chat/completions'
os.makedirs(TTS_DIR, exist_ok=True)


def load_cfg():
    try:
        with open(EDITABLE, 'r', encoding='utf-8') as f:
            return (json.load(f).get('tts') or {})
    except Exception:
        return {}


def _post(body, key, timeout):
    req = urllib.request.Request(
        MIMO_API, data=json.dumps(body).encode('utf-8'),
        headers={'api-key': key, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(r.read().decode('utf-8'))
    if j.get('error'):
        raise RuntimeError(str(j['error'])[:200])
    b64 = (j.get('choices') or [{}])[0].get('message', {}).get('audio', {}).get('data')
    if not b64:
        raise RuntimeError('API 未返回 audio.data')
    return base64.b64decode(b64)


def synth_mimo(text, style, model, key):
    return _post({
        'model': model,
        'messages': [
            {'role': 'user', 'content': style or '自然流畅地朗读'},
            {'role': 'assistant', 'content': text},
        ],
        'audio': {'format': 'mp3'},
        'stream': False,
    }, key, 60)


def synth_clone(text, ref, key, timeout):
    with open(ref, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    mime = 'audio/wav' if ref.lower().endswith('.wav') else 'audio/mpeg'
    return _post({
        'model': 'mimo-v2.5-tts-voiceclone',
        'messages': [
            {'role': 'user', 'content': ''},
            {'role': 'assistant', 'content': text},
        ],
        'audio': {'format': 'mp3', 'voice': 'data:%s;base64,%s' % (mime, b64)},
        'stream': False,
    }, key, timeout)


def synth_edge(text, voice, rate, pitch, volume):
    """微软 edge-tts：免费、无需 Key、延迟约 1~2 秒，返回 mp3 字节。

    rate/pitch/volume 形如 '+50%' / '+0Hz' / '+0%'，为空则用默认值。
    变速由 edge 自己完成，调用方不要再 apply_speed。
    """
    import asyncio
    import edge_tts

    async def go():
        kw = {}
        if rate:
            kw['rate'] = rate
        if pitch:
            kw['pitch'] = pitch
        if volume:
            kw['volume'] = volume
        chunks = []
        async for ch in edge_tts.Communicate(text, voice, **kw).stream():
            if ch.get('type') == 'audio' and ch.get('data'):
                chunks.append(ch['data'])
        return b''.join(chunks)

    data = asyncio.run(go())
    if not data:
        raise RuntimeError('edge-tts 未返回音频数据')
    return data


def edge_voices(locale='zh-CN'):
    """列出 edge-tts 可用音色（供面板做下拉选择）。"""
    import asyncio
    import edge_tts

    async def go():
        vs = await edge_tts.list_voices()
        out = []
        for v in vs:
            loc = v.get('Locale') or ''
            if loc.startswith(locale):
                out.append({'name': v.get('ShortName'), 'gender': v.get('Gender'),
                            'locale': loc, 'friendly': v.get('FriendlyName')})
        return sorted(out, key=lambda x: x['name'] or '')

    return asyncio.run(go())


def speed_to_rate(speed):
    """把统一的语速倍数换算成 edge-tts 的 rate 百分比：1.5 → '+50%'，0.8 → '-20%'。"""
    try:
        sp = float(speed)
    except Exception:
        sp = 1.0
    if sp <= 0:
        sp = 1.0
    return '%+d%%' % int(round((sp - 1.0) * 100))


def apply_speed(path, speed):
    """ffmpeg atempo 变速，保持音调（atempo 不改基频）。单次 0.5~2.0，超出链式。"""
    try:
        sp = float(speed)
    except Exception:
        return
    if abs(sp - 1.0) < 0.01 or sp <= 0:
        return
    filters, s2 = [], sp
    while s2 > 2.0:
        filters.append('atempo=2.0'); s2 /= 2.0
    while s2 < 0.5:
        filters.append('atempo=0.5'); s2 /= 0.5
    filters.append('atempo=%.4f' % s2)
    tmp = path + '.spd.mp3'
    r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', path,
                        '-af', ','.join(filters), '-b:a', '64k', tmp], capture_output=True)
    if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 800:
        os.replace(tmp, path)
    else:
        print('变速失败(%.2fx): %s' % (sp, r.stderr.decode()[:150]), flush=True)


def dur_of(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True)
    try:
        return float(r.stdout)
    except Exception:
        return 0.0


def length_limit(text, speed):
    """中文约 4.5 字/秒（1x）。给 4 倍冗余，只拦真正的异常（如 18 字生成 48 秒）。"""
    try:
        sp = float(speed)
    except Exception:
        sp = 1.0
    sp = sp if sp > 0.1 else 1.0
    return max(6.0, len(text) / 4.5 / sp * 4.0)


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        cfg = load_cfg()

        def one(k, default=''):
            v = (q.get(k) or [''])[0]
            return v if v else default

        if u.path == '/health':
            eng = cfg.get('engine', 'clone')
            provider = {'clone': 'MiMo-V2.5-TTS(音色复刻)',
                        'mimo': 'MiMo-V2.5-TTS(文字描述)',
                        'edge': 'Microsoft edge-tts'}.get(eng, eng)
            return self._json(200, {'ok': True, 'engine': eng, 'provider': provider,
                                    'engines': ['clone', 'mimo', 'edge']})

        if u.path == '/voices':
            loc = one('locale', 'zh-CN')
            try:
                vs = edge_voices(loc)
            except Exception as e:
                return self._json(500, {'ok': False, 'error': str(e)[:200]})
            return self._json(200, {'ok': True, 'locale': loc, 'count': len(vs), 'voices': vs})

        if u.path == '/say':
            text = one('text')
            if not text.strip():
                return self._json(400, {'ok': False, 'error': 'text 为空'})
            engine = one('engine', cfg.get('engine', 'clone'))
            name = os.path.basename(one('name') or ('t-%d.mp3' % int(time.time() * 1000)))
            out = os.path.join(TTS_DIR, name)
            key = one('key', cfg.get('mimoApiKey', ''))
            ref = one('ref', cfg.get('cloneRef', '/root/tts-samples/ref7.mp3'))
            style = one('style', cfg.get('mimoStyle', ''))
            model = one('model', cfg.get('mimoModel', 'mimo-v2.5-tts-voicedesign'))
            speed = one('speed', cfg.get('speed', 1))
            # ── 微软 edge-tts 相关 ──
            # 语速统一用 speed 倍数表达（面板只有一个语速字段），
            # edge 需要百分比形式，所以 1.5 → '+50%'；rate 显式给了就优先用它。
            voice = one('voice', cfg.get('voice', 'zh-CN-XiaoxiaoNeural'))
            # config.js 总会带一个 --rate（默认 '+0%'）。'+0%' 表示「不变速」，
            # 那就该由 speed 换算得来，否则面板上调语速对微软引擎就失效了。
            rate = one('rate', cfg.get('rate', ''))
            if not rate or rate.replace(' ', '') in ('+0%', '0%', '-0%'):
                rate = speed_to_rate(speed)
            pitch = one('pitch', cfg.get('pitch', '+0Hz'))
            volume = one('volume', cfg.get('volume', '+0%'))
            cto = int(cfg.get('cloneTimeout', 15))
            fb_style = cfg.get('cloneFallbackStyle', '') or style
            fb_model = cfg.get('cloneFallbackModel', 'mimo-v2.5-tts-voicedesign')
            limit = length_limit(text, speed)
            t0 = time.time()

            def produce(eng):
                if eng == 'edge':
                    return synth_edge(text, voice, rate, pitch, volume)
                if eng == 'clone':
                    return synth_clone(text, ref, key, cto)
                return synth_mimo(text, style, model, key)

            data, used, note = None, engine, ''
            for attempt in (1, 2):
                try:
                    data = produce(engine)
                except Exception as e:
                    note = str(e)[:120]
                    print('尝试%d(%s) 失败: %s' % (attempt, engine, note), flush=True)
                    data = None
                if not data:
                    continue
                with open(out, 'wb') as f:
                    f.write(data)
                # 微软分支的变速已由 edge 的 rate 参数完成，再 apply_speed 会变速两次
                if engine != 'edge':
                    apply_speed(out, speed)
                d = dur_of(out)
                if d <= limit:
                    break
                note = '第%d次生成长度异常 %.1fs > 上限 %.1fs' % (attempt, d, limit)
                print(note + '，重试', flush=True)
                data = None

            if not data:
                if engine == 'edge':
                    # 微软引擎失败就直接报错，交给 config.js 回退音箱内置语音；
                    # 不静默换成小米音色 —— 用户选微软是有原因的。
                    return self._json(500, {'ok': False,
                                            'error': 'edge-tts 合成失败: %s' % (note or '未知')})
                print('复刻两次都不合格，回退风格引擎：%s' % note, flush=True)
                used = engine + '->style'
                try:
                    data = synth_mimo(text, fb_style, fb_model, key)
                except Exception as e:
                    return self._json(500, {'ok': False, 'error': '全部失败: %s' % str(e)[:150]})
                with open(out, 'wb') as f:
                    f.write(data)
                apply_speed(out, speed)

            size = os.path.getsize(out) if os.path.exists(out) else 0
            if size < 800:
                return self._json(500, {'ok': False, 'error': '音频为空'})
            return self._json(200, {'ok': True, 'name': name, 'size': size,
                                    'ms': int((time.time() - t0) * 1000), 'engine': used,
                                    'dur': round(dur_of(out), 2), 'limit': round(limit, 2)})

        return self._json(404, {'ok': False, 'error': 'not found'})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    print('TTS 微服务已启动（引擎: clone/mimo=小米MiMo, edge=微软 edge-tts），端口 %d' % PORT, flush=True)
    srv.serve_forever()
