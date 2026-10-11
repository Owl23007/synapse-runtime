// 通过标准输入传递用户命令，宿主机只执行固定 Docker 参数，不解释模型生成的 shell
/** 容器侧执行与产物提取脚本，限制输出大小并拒绝工作区外的产物 */
export const runnerScript = String.raw`
import base64, json, os, pathlib, subprocess, sys, tempfile
request = json.load(sys.stdin)
with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
    result = subprocess.run(request["command"], shell=True, cwd="/workspace", stdout=out, stderr=err, timeout=request["timeoutMs"] / 1000)
    out.seek(0)
    err.seek(0)
    output = {"exitCode": result.returncode, "stdout": out.read(24000).decode("utf-8", "replace"), "stderr": err.read(24000).decode("utf-8", "replace"), "artifacts": []}
attachments = []
total = 0
if result.returncode == 0:
    for artifact in request["artifacts"]:
        path = pathlib.Path("/workspace", artifact["path"]).resolve()
        if not path.is_relative_to(pathlib.Path("/workspace")) or not path.is_file():
            raise ValueError("Artifact must be a regular file inside /workspace: " + artifact["path"])
        with path.open("rb") as file:
            if not __import__("stat").S_ISREG(os.fstat(file.fileno()).st_mode):
                raise ValueError("Artifact is not a regular file")
            data = file.read(request["maxArtifactBytes"] - total + 1)
        total += len(data)
        if total > request["maxArtifactBytes"]:
            raise ValueError("Artifacts exceed the configured size limit")
        name = path.name
        url = "base64://" + base64.b64encode(data).decode("ascii")
        output["artifacts"].append({"name": name, "sizeBytes": len(data), "type": artifact["type"]})
        attachments.append({"type": "image", "url": url, "alt": name} if artifact["type"] == "image" else {"type": "file", "name": name, "url": url, "sizeBytes": len(data)})
print(json.dumps({"schemaVersion": "runtime-tool-output/v1", "modelOutput": output, "attachments": attachments}))
`;
