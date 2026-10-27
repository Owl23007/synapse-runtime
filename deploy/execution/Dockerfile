FROM python:3.13-slim
RUN pip install --no-cache-dir python-pptx==1.0.2 Pillow==11.3.0 openpyxl==3.1.5 reportlab==4.4.4 matplotlib==3.10.6
WORKDIR /workspace
ENV HOME=/tmp MPLCONFIGDIR=/tmp/matplotlib
USER 65534:65534
