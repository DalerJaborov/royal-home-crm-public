FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MODELS_DIR=/models \
    PORT=8090

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && apt-get clean && find /var/lib/apt/lists -type f -delete

# torch только CPU (без CUDA-колёс образ был бы на гигабайты больше)
# torchvision нужен onnx2torch; обязательно из того же CPU-индекса, иначе версия с PyPI не совпадёт с torch
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.15.0 torchvision==0.29.2

COPY requirements.txt /tmp/requirements.txt
# diffq (зависимость audio-separator) собирается из исходников: gcc нужен только на время установки
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && pip install -r /tmp/requirements.txt \
 && apt-get purge -y --auto-remove gcc libc6-dev \
 && apt-get clean && find /var/lib/apt/lists -type f -delete

# Модели скачиваются при сборке; во время работы сеть не нужна
RUN mkdir -p /models/separator /models/whisper \
 && python -c "\
import logging; \
from audio_separator.separator import Separator; \
s = Separator(model_file_dir='/models/separator', log_level=logging.WARNING); \
s.load_model('Kim_Vocal_2.onnx')" \
 && python -c "\
from faster_whisper import WhisperModel; \
WhisperModel('small', device='cpu', compute_type='int8', download_root='/models/whisper')"

RUN useradd --system --uid 10001 --home-dir /app app \
 && mkdir -p /app \
 && chown -R app:app /app /models
WORKDIR /app
COPY --chown=app:app server.py /app/server.py

# Корень контейнера может быть read-only: писать можно только в /tmp
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HOME=/tmp \
    NUMBA_CACHE_DIR=/tmp \
    MPLCONFIGDIR=/tmp \
    XDG_CACHE_HOME=/tmp \
    WORK_ROOT=/tmp
USER app

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8090'), timeout=4)" || exit 1

CMD ["python", "server.py"]
