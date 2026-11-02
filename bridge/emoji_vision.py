"""Received sticker previews, without opening or sending anything in WeChat."""
import glob
import hashlib
import html
import io
import os
import re
from urllib.parse import urlparse, urljoin

MAX_BYTES = 8 * 1024 * 1024


def attributes(content):
    tag = re.search(r'<emoji\b([^>]*)>', str(content or ''), re.I)
    if not tag:
        return {}
    return {m.group(1).lower(): html.unescape(m.group(3)) for m in re.finditer(
        r'([a-zA-Z]\w*)\s*=\s*([\"\x27])(.*?)\2', tag.group(1), re.S)}


def trusted_url(url):
    try:
        value = urlparse(url)
        return (value.scheme in ('http', 'https') and not value.username and not value.password
                and value.port in (None, 80, 443)
                and (value.hostname or '').lower().endswith('.tc.qq.com'))
    except ValueError:
        return False


def fetch_asset(url):
    import requests
    with requests.Session() as session:
        session.trust_env = False
        for _ in range(3):
            if not trusted_url(url):
                return None
            with session.get(url, stream=True, allow_redirects=False, timeout=(5, 10)) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get('Location', ''))
                    continue
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        return None
                return bytes(data)
    return None


def sources(account_dir, attrs, digest, allow_network, fetch):
    cache = os.path.realpath(os.path.join(account_dir, 'cache'))
    for path in sorted(glob.glob(os.path.join(cache, '*', 'Emoticon', digest[:2], digest)), reverse=True):
        real = os.path.realpath(path)
        if os.path.commonpath([cache, real]) != cache or not os.path.isfile(real):
            continue
        if 0 < os.path.getsize(real) <= MAX_BYTES:
            with open(real, 'rb') as stream:
                yield stream.read(MAX_BYTES + 1)
    if not allow_network:
        return
    for url in dict.fromkeys(attrs.get(k, '') for k in ('cdnurl', 'encrypturl')):
        if not url or not trusted_url(url):
            continue
        try:
            data = fetch(url)
            if not data or len(data) > MAX_BYTES:
                continue
            if hashlib.md5(data).hexdigest() == digest:
                yield data
                return
            key = attrs.get('aeskey', '')
            if re.fullmatch(r'[0-9a-fA-F]{32}', key) and len(data) % 16 == 0:
                from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
                key = bytes.fromhex(key)
                for mode in (modes.CBC(bytes(16)), modes.ECB(), modes.CBC(key)):
                    dec = Cipher(algorithms.AES(key), mode).decryptor()
                    plain = dec.update(data) + dec.finalize()
                    if plain and 0 < plain[-1] <= 16 and plain.endswith(bytes([plain[-1]]) * plain[-1]):
                        plain = plain[:-plain[-1]]
                    if hashlib.md5(plain).hexdigest() == digest:
                        yield plain
                        return
        except Exception:
            continue


def load_preview(account_dir, content, allow_network=False, fetch=None):
    attrs = attributes(content)
    digest = attrs.get('md5', '').lower()
    if not re.fullmatch(r'[0-9a-f]{32}', digest):
        return None
    from PIL import Image
    for data in sources(account_dir, attrs, digest, allow_network, fetch or fetch_asset):
        if len(data) > MAX_BYTES:
            continue
        try:
            with Image.open(io.BytesIO(data)) as image:
                if image.width * image.height > 16_000_000:
                    continue
                count = getattr(image, 'n_frames', 1)
                if count > 500:
                    continue
                frames = []
                for index in sorted({0, count // 2, count - 1}):
                    image.seek(index)
                    frame = image.convert('RGBA')
                    frame.thumbnail((768, 768) if count > 1 else (1600, 1600))
                    tile = Image.new('RGB', frame.size, 'white')
                    tile.paste(frame, mask=frame.getchannel('A'))
                    frames.append(tile)
                preview = Image.new('RGB', (sum(f.width for f in frames) + 8 * (len(frames) - 1),
                                            max(f.height for f in frames)), 'white')
                x = 0
                for frame in frames:
                    preview.paste(frame, (x, 0))
                    x += frame.width + 8
                output = io.BytesIO()
                preview.save(output, format='PNG')
                if output.tell() <= MAX_BYTES:
                    return output.getvalue(), len(frames)
        except (OSError, ValueError, EOFError, Image.DecompressionBombError):
            continue
    return None
