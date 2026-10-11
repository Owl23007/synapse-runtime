FROM python:3.13-slim

# 依赖和中文字体在镜像构建阶段准备，任务执行时保持无网络与只读根目录
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir python-docx==1.2.0 openpyxl==3.1.5 reportlab==4.4.3 matplotlib==3.10.6
ENV MPLCONFIGDIR=/tmp/matplotlib
ENV HOME=/work
WORKDIR /work
USER 65534:65534
