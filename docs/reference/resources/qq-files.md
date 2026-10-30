# QQ 文件

OneBot11 的 `notice.group_upload` 使用独立 ChannelFileNotice 处理器，不伪装成 message.created。只索引提供方、频道、群、文件 ID、名称、声明大小、busid 和观察时间；平台提供消息标识时再关联来源。未触发消息正文不进入 Transcript。

携带稳定 fileId 的消息附件也在触发判断之前索引。回复附件消息时优先提供精确来源关系；其他情况只提供少量最近文件元数据。多个同名候选需要确认，不能猜测唯一项。

NapCat 的 `file.get` 与 `file.list` 映射群文件 URL、根目录和子目录查询。Files 的「同步 QQ 文件」接受频道 ID、群号与可选文件夹 ID，只补偿索引。多级目录按需要分别同步，不无限后台轮询。私聊没有可靠查询映射时明确不支持，不套用群文件 busid 语义。

读取时重新向平台取得临时地址，再检查协议、DNS、重定向、体积和时间。检查与连接使用同一 DNS 结果。私网下载主机必须在 files.remoteAllowedHosts 精确批准。临时 URL 不进入来源主键或运行依赖。

失败显示 fetch-failed，明确缺失显示 remote-unavailable，不创建伪版本。用户可以再次获取文件；外部上传等操作若回执 uncertain，仍禁止自动重放。Files 重命名与删除只改变本地记录，不提供容易混淆的远端破坏性操作。
