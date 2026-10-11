/** 容器内的固定驱动程序，脚本仅写入有容量限制的临时文件系统，工件通过标准输出传输 */
export const PYTHON_RUNNER = String.raw`
import sys, json, os, stat, base64, subprocess, tempfile
p = json.load(sys.stdin)
os.chdir('/work')
for item in p['inputs']:
    with open(item['name'], 'xb') as f:
        f.write(base64.b64decode(item['base64'], validate=True))
with tempfile.TemporaryFile() as logs:
    try:
        done = subprocess.run([sys.executable, '-I', '-c', p['script']], stdin=subprocess.DEVNULL, stdout=logs, stderr=logs, timeout=p['timeoutMs']/1000)
        logs.seek(0)
        output = logs.read(p['maxLogBytes'] + 1)
        if len(output) > p['maxLogBytes']:
            raise RuntimeError('task log limit exceeded')
        if done.returncode != 0:
            raise RuntimeError('task exited with code ' + str(done.returncode) + ': ' + output.decode('utf-8', errors='replace'))
        files = []
        total = 0
        for name in p['outputs']:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as f:
                info = os.fstat(f.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise RuntimeError('artifact must be a regular file with one link')
                data = f.read(p['maxArtifactBytes'] + 1)
            total += len(data)
            if len(data) > p['maxArtifactBytes'] or total > p['maxTotalBytes']:
                raise RuntimeError('artifact size limit exceeded')
            files.append({'name': name, 'base64': base64.b64encode(data).decode('ascii')})
        print(json.dumps({'files': files, 'logs': output.decode('utf-8', errors='replace')}, ensure_ascii=True))
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
`;
