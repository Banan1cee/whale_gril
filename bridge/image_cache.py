"""Keep image-key validation tied to the image being decoded, not an old cache file."""
import threading

V2_MAGIC = b'\x07\x08V2\x08\x07'


def bind_target_probe(downloader):
    if getattr(downloader, '_target_probe_bound', False):
        return
    original = downloader.decrypt_image
    lock = threading.RLock()

    def decrypt(path, *args, **kwargs):
        with lock:
            with open(path, 'rb') as stream:
                header = stream.read(32)
            if header[:6] == V2_MAGIC and len(header) >= 31:
                probe = header[15:31]
                if getattr(downloader, '_key_probe', None) != probe:
                    downloader._key_probe = probe
                    downloader._xor_key = None
            return original(path, *args, **kwargs)

    downloader.decrypt_image = decrypt
    downloader._target_probe_bound = True
