"""DesiCaps Studio desktop app: starts the local server and shows it in a native window."""
import multiprocessing
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import paths  # noqa: E402


class _Log:
    """Frozen GUI apps have no console - send print/tracebacks to a log file."""
    def __init__(self, f, stream=None):
        self.f, self.stream = f, stream

    def write(self, s):
        try:
            self.f.write(s)
            self.f.flush()
            if self.stream:
                self.stream.write(s)
        except Exception:
            pass

    def flush(self):
        pass

    def isatty(self):
        return False


def setup_logging():
    log = open(os.path.join(paths.LOGS, "desicaps.log"), "w", encoding="utf-8")
    sys.stdout = _Log(log, None if paths.FROZEN else sys.__stdout__)
    sys.stderr = _Log(log, None if paths.FROZEN else sys.__stderr__)
    print(f"DesiCaps starting  frozen={paths.FROZEN}  res={paths.RES}  data={paths.DATA}")


def free_port(preferred=7870):
    for port in [preferred] + list(range(7871, 7900)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Api:
    """Functions the web UI can call via window.pywebview.api.*"""
    def __init__(self):
        self._window = None

    def pick_video(self):
        import webview
        types = ("Video files (*.mp4;*.mov;*.mkv;*.webm;*.m4v;*.avi)", "All files (*.*)")
        kind = webview.FileDialog.OPEN if hasattr(webview, "FileDialog") else webview.OPEN_DIALOG
        res = self._window.create_file_dialog(kind, allow_multiple=False, file_types=types)
        if not res:
            return None
        return res[0] if isinstance(res, (list, tuple)) else res

    def open_url(self, url):
        import webbrowser
        if str(url).startswith("https://"):
            webbrowser.open(url)
        return True


def main():
    setup_logging()
    import warnings
    warnings.filterwarnings("ignore")
    import server
    port = free_port(int(server.CONFIG.get("port", 7870)))
    t = threading.Thread(target=lambda: server.serve(port), daemon=True)
    t.start()
    url = f"http://127.0.0.1:{port}/"
    for _ in range(100):  # wait until the server answers
        try:
            urllib.request.urlopen(url + "api/health", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    print("server up on", url)

    if "--browser" in sys.argv:  # debug: use the normal browser instead of a window
        import webbrowser
        webbrowser.open(url)
        t.join()
        return

    import webview
    api = Api()
    win = webview.create_window("DesiCaps Studio", url, js_api=api, width=1440, height=900,
                                min_size=(960, 640), background_color="#0c0d10", text_select=True)
    api._window = win
    webview.start(private_mode=False, storage_path=os.path.join(paths.DATA, "webview"))
    os._exit(0)  # stop the server thread too


if __name__ == "__main__":
    multiprocessing.freeze_support()
    try:
        main()
    except Exception:
        traceback.print_exc()
        try:
            open(os.path.join(paths.LOGS, "crash.log"), "w").write(traceback.format_exc())
        except Exception:
            pass
        raise
