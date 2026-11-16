"""Royal Home voice-separator: убирает голос из дорожки видео.

POST /separate  -> FLAC с музыкой без голоса + заголовки проверки речи
GET  /health    -> {"ok": true, "model": ...}

Один запрос за раз (HTTPServer без потоков = очередь).
"""
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import quote

CORES = int(os.environ.get("OMP_NUM_THREADS") or 0) or os.cpu_count() or 1
os.environ.setdefault("OMP_NUM_THREADS", str(CORES))
os.environ.setdefault("MKL_NUM_THREADS", str(CORES))

PORT = int(os.environ.get("PORT", "8090"))
SEPARATOR_MODEL = os.environ.get("SEPARATOR_MODEL", "Kim_Vocal_2.onnx")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
SEPARATOR_DIR = os.environ.get("SEPARATOR_MODEL_DIR", os.path.join(MODELS_DIR, "separator"))
WHISPER_DIR = os.environ.get("WHISPER_MODEL_DIR", os.path.join(MODELS_DIR, "whisper"))
WORK_ROOT = os.environ.get("WORK_ROOT", "/tmp")
MAX_BYTES = 200 * 1024 * 1024
MAX_SECONDS = 600.0
CHUNK = 1024 * 1024

logging.getLogger("audio_separator").setLevel(logging.WARNING)

separator = None
whisper = None


def load_models():
    global separator, whisper
    import torch

    torch.set_num_threads(CORES)
    from audio_separator.separator import Separator
    from faster_whisper import WhisperModel

    separator = Separator(
        model_file_dir=SEPARATOR_DIR,
        output_dir=WORK_ROOT,
        output_format="FLAC",
        output_single_stem="Instrumental",
        sample_rate=44100,
        log_level=logging.WARNING,
    )
    separator.load_model(model_filename=SEPARATOR_MODEL)
    whisper = WhisperModel(
        WHISPER_MODEL,
        device="cpu",
        compute_type="int8",
        cpu_threads=CORES,
        download_root=WHISPER_DIR,
    )


class BadInput(Exception):
    def __init__(self, status, text):
        super().__init__(text)
        self.status = status
        self.text = text


def run(cmd):
    return subprocess.run(cmd, capture_output=True, timeout=300)


def probe_duration(path):
    p = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
    try:
        return float(p.stdout.decode().strip())
    except ValueError:
        raise BadInput(400, "not an audio file")


def find_instrumental(result, workdir):
    for name in result or []:
        path = name if os.path.isabs(name) else os.path.join(workdir, name)
        if os.path.exists(path):
            return path
    for name in sorted(os.listdir(workdir)):
        if "Instrumental" in name and name.endswith(".flac"):
            return os.path.join(workdir, name)
    raise RuntimeError("separator produced no instrumental")


def decode_16k_mono(path):
    # декодируем сами: faster-whisper через PyAV капризен к версиям av
    import numpy as np

    p = run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"])
    if p.returncode != 0:
        raise RuntimeError("cannot decode instrumental")
    return np.frombuffer(p.stdout, dtype=np.float32)


def check_speech(path):
    audio = decode_16k_mono(path)
    segments, _info = whisper.transcribe(audio, vad_filter=True, language=None, beam_size=1)
    words, sec, texts = 0, 0.0, []
    for seg in segments:
        t = seg.text.strip()
        words += len(t.split())
        sec += max(0.0, seg.end - seg.start)
        if t:
            texts.append(t)
    return words, sec, " ".join(texts)


def process(body_path, workdir):
    duration = probe_duration(body_path)
    if duration > MAX_SECONDS:
        raise BadInput(400, "audio longer than %d s" % MAX_SECONDS)
    wav = os.path.join(workdir, "in.wav")
    p = run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", body_path, "-vn",
             "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav])
    if p.returncode != 0 or not os.path.exists(wav):
        raise BadInput(400, "cannot decode audio")
    outdir = os.path.join(workdir, "out")
    os.mkdir(outdir)
    separator.output_dir = outdir
    separator.model_instance.output_dir = outdir  # модель держит свою копию папки
    t0 = time.time()
    res = separator.separate(wav)
    sep_ms = int((time.time() - t0) * 1000)
    inst = find_instrumental(res, outdir)
    t1 = time.time()
    words, sec, text = check_speech(inst)
    check_ms = int((time.time() - t1) * 1000)
    with open(inst, "rb") as f:
        data = f.read()
    return duration, data, words, sec, text, sep_ms, check_ms


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def send_json(self, status, obj):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            ready = separator is not None and whisper is not None
            return self.send_json(200 if ready else 503, {"ok": ready, "model": SEPARATOR_MODEL})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/separate":
            return self.send_json(404, {"error": "not found"})
        started = time.time()
        workdir = tempfile.mkdtemp(prefix="sep-", dir=WORK_ROOT)
        try:
            raw_len = self.headers.get("Content-Length")
            if raw_len is None or not raw_len.isdigit():
                self.close_connection = True
                return self.send_json(400, {"error": "Content-Length required"})
            length = int(raw_len)
            if length == 0:
                return self.send_json(400, {"error": "empty body"})
            if length > MAX_BYTES:
                self.close_connection = True
                return self.send_json(413, {"error": "body larger than 200 MB"})
            body_path = os.path.join(workdir, "body.bin")
            left = length
            with open(body_path, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(CHUNK, left))
                    if not chunk:
                        self.close_connection = True
                        return self.send_json(400, {"error": "body truncated"})
                    f.write(chunk)
                    left -= len(chunk)
            duration, data, words, sec, text, sep_ms, check_ms = process(body_path, workdir)
            self.send_response(200)
            self.send_header("Content-Type", "audio/flac")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Speech-Words", str(words))
            self.send_header("X-Speech-Seconds", "%.1f" % sec)
            self.send_header("X-Separate-Ms", str(sep_ms))
            self.send_header("X-Check-Ms", str(check_ms))
            self.send_header("X-Speech-Text", quote(text[:200], safe=""))
            self.end_headers()
            self.wfile.write(data)
            print("separate ok dur=%.1fs sep_ms=%d check_ms=%d words=%d total_ms=%d" % (
                duration, sep_ms, check_ms, words, int((time.time() - started) * 1000)), flush=True)
        except BadInput as e:
            print("separate bad-input %d %s" % (e.status, e.text), flush=True)
            self.send_json(e.status, {"error": e.text})
        except Exception as e:  # never kill the process
            print("separate failed %s: %s" % (type(e).__name__, str(e)[:200]), flush=True)
            try:
                self.close_connection = True
                self.send_json(500, {"error": "separation failed"})
            except Exception:
                pass
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


def main():
    t = time.time()
    load_models()
    print("models loaded in %.1fs (%s, whisper %s, threads %d)" % (
        time.time() - t, SEPARATOR_MODEL, WHISPER_MODEL, CORES), flush=True)
    srv = HTTPServer(("0.0.0.0", PORT), Handler)
    print("listening on :%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
