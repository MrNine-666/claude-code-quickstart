# 网络工具 - CCQ
# 功能: 提供端点可达性检测、文件下载等网络工具函数

#Requires -Version 5.1

Set-StrictMode -Version Latest

function Test-EndpointReachable {
    <#
    .SYNOPSIS
    测试单个端点的可达性
    .PARAMETER Url
    要测试的 URL
    .PARAMETER TimeoutSeconds
    超时时间（秒，默认 8）
    .RETURNS
    包含 Url, Reachable, StatusCode, ErrorMessage 的对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,

        [int]$TimeoutSeconds = 8
    )

    $result = [PSCustomObject]@{
        Url          = $Url
        Reachable    = $false
        StatusCode   = $null
        ErrorMessage = ""
        LatencyMs    = -1
    }

    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()

        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = "HEAD"
        $request.Timeout = $TimeoutSeconds * 1000
        $request.AllowAutoRedirect = $true
        $request.UserAgent = "ClaudeEnvInstaller/1.0"

        # 应用系统代理（如果已配置）
        $request.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $request.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials

        $response = $request.GetResponse()
        $sw.Stop()

        $result.Reachable = $true
        $result.StatusCode = [int]$response.StatusCode
        $result.LatencyMs = $sw.ElapsedMilliseconds
        $response.Close()

    } catch [System.Net.WebException] {
        $sw.Stop()
        $result.LatencyMs = $sw.ElapsedMilliseconds

        $webEx = $_.Exception
        if ($webEx.Response) {
            $result.StatusCode = [int]$webEx.Response.StatusCode
            # 4xx/5xx 也算可达（服务器有响应）
            if ($result.StatusCode -ge 200 -and $result.StatusCode -lt 600) {
                $result.Reachable = $true
            }
        }
        $result.ErrorMessage = $webEx.Message
    } catch {
        $sw.Stop()
        $result.ErrorMessage = $_.Exception.Message
    }

    return $result
}

function Invoke-FileDownload {
    <#
    .SYNOPSIS
    统一的文件下载函数，带进度条显示
    .DESCRIPTION
    使用 HttpWebRequest + 异步轮询（APM 模式）实现带实时进度条的文件下载。
    所有网络 I/O 均为异步发起 + Start-Sleep 轮询，确保 CTRL+C 可随时中断。
    .PARAMETER Url
    下载地址
    .PARAMETER OutputPath
    输出文件路径
    .PARAMETER Description
    下载描述（可选，用于显示）
    .PARAMETER TimeoutSeconds
    超时时间（秒，默认 300）
    .RETURNS
    @{Success; FilePath; ErrorMessage; FileSize}
    .EXAMPLE
    $result = Invoke-FileDownload -Url "https://example.com/file.zip" -OutputPath "C:\temp\file.zip"
    if ($result.Success) {
        Write-Host "下载成功: $($result.FilePath)"
    }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string] $Url,

        [Parameter(Mandatory = $true)]
        [string] $OutputPath,

        [Parameter(Mandatory = $false)]
        [string] $Description = "",

        [Parameter(Mandatory = $false)]
        [int] $TimeoutSeconds = 300
    )

    $result = @{
        Success      = $false
        FilePath     = $OutputPath
        ErrorMessage = ""
        FileSize     = 0
    }

    try {
        # 确保输出目录存在
        $outputDir = Split-Path -Path $OutputPath -Parent
        if ($outputDir -and -not (Test-Path $outputDir)) {
            New-Item -Path $outputDir -ItemType Directory -Force | Out-Null
        }

        # 显示下载信息
        $fileName = Split-Path -Path $OutputPath -Leaf
        if ($Description) {
            Write-UiDim "  正在下载: $Description"
        } else {
            Write-UiDim "  正在下载: $fileName"
        }
        Write-UiDim "  下载地址: $Url"

        # 仅允许 TLS 1.2+，禁用不安全的旧协议；TLS 1.3 在部分 PS 5.1/.NET Framework 环境不存在，需兼容探测。
        $securityProtocol = [System.Net.SecurityProtocolType]::Tls12
        try {
            $securityProtocol = $securityProtocol -bor [System.Enum]::Parse([System.Net.SecurityProtocolType], "Tls13")
        } catch {
            # 当前运行时不支持 TLS 1.3 时仅使用 TLS 1.2。
        }
        [System.Net.ServicePointManager]::SecurityProtocol = $securityProtocol

        # 使用 HttpWebRequest + 异步轮询（CTRL+C 可中断）
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = "GET"
        $request.Timeout = $TimeoutSeconds * 1000
        $request.ReadWriteTimeout = $TimeoutSeconds * 1000
        $request.AllowAutoRedirect = $true
        $request.UserAgent = "ClaudeEnvInstaller/1.0"
        $request.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $request.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials

        $response = $null
        $responseStream = $null
        $fileStream = $null
        $downloadSuccess = $false

        try {
            # ── 阶段 1：异步连接（CTRL+C 可中断） ──
            Write-UiDim "  正在连接..." -NoNewline
            $asyncConnect = $request.BeginGetResponse($null, $null)
            $connectDeadline = (Get-Date).AddSeconds($TimeoutSeconds)
            $lastConnectProgressTime = [DateTime]::MinValue

            while (-not $asyncConnect.IsCompleted) {
                $now = Get-Date
                if ($now -gt $connectDeadline) {
                    $request.Abort()
                    throw "连接超时 ($TimeoutSeconds 秒)"
                }

                if (($now - $lastConnectProgressTime).TotalSeconds -ge 2) {
                    $lastConnectProgressTime = $now
                    $elapsedSeconds = [math]::Floor(($now - ($connectDeadline.AddSeconds(-$TimeoutSeconds))).TotalSeconds)
                    Write-UiPrimary "`r  正在连接... ${elapsedSeconds}s    " -NoNewline
                }

                Start-Sleep -Milliseconds 300
            }

            $response = $request.EndGetResponse($asyncConnect)
            Write-UiSuccess "`r  已连接，开始下载...          "

            $totalBytes = $response.ContentLength  # -1 if unknown
            if ($totalBytes -gt 0) {
                Write-UiDim "  文件大小: $([math]::Round($totalBytes / 1MB, 2)) MB"
            } else {
                Write-UiDim "  文件大小: 未知（将显示已接收大小与速度）"
            }
            $responseStream = $response.GetResponseStream()
            $fileStream = [System.IO.File]::Create($OutputPath)

            $buffer = New-Object byte[] 8192
            $totalRead = [long]0
            $lastPercent = -1
            $lastProgressTime = [DateTime]::MinValue
            $lastReadActivity = Get-Date
            $startTime = Get-Date

            # ── 阶段 2：异步读取 + 进度显示（CTRL+C 可中断） ──
            while ($true) {
                $asyncRead = $responseStream.BeginRead($buffer, 0, $buffer.Length, $null, $null)

                while (-not $asyncRead.IsCompleted) {
                    $now = Get-Date
                    if (($now - $lastReadActivity).TotalSeconds -ge $TimeoutSeconds) {
                        $request.Abort()
                        throw "下载读取超时 ($TimeoutSeconds 秒未收到数据)"
                    }

                    if (($now - $lastProgressTime).TotalMilliseconds -ge 500) {
                        $lastProgressTime = $now
                        $elapsed = $now - $startTime
                        $speed = if ($elapsed.TotalSeconds -gt 0) { $totalRead / $elapsed.TotalSeconds } else { 0 }
                        $speedMB = [math]::Round($speed / 1MB, 2)
                        $receivedMB = [math]::Round($totalRead / 1MB, 2)
                        Write-UiPrimary "`r  等待数据... $receivedMB MB | $speedMB MB/s    " -NoNewline
                    }

                    Start-Sleep -Milliseconds 50
                }

                $bytesRead = $responseStream.EndRead($asyncRead)
                if ($bytesRead -le 0) { break }
                $lastReadActivity = Get-Date

                $fileStream.Write($buffer, 0, $bytesRead)
                $totalRead += $bytesRead

                # 主线程更新进度条
                $now = Get-Date
                $elapsed = $now - $startTime
                $speed = if ($elapsed.TotalSeconds -gt 0) { $totalRead / $elapsed.TotalSeconds } else { 0 }
                $speedMB = [math]::Round($speed / 1MB, 2)
                $receivedMB = [math]::Round($totalRead / 1MB, 2)

                if ($totalBytes -gt 0) {
                    # 已知总大小：显示百分比进度条
                    $percent = [math]::Min([math]::Floor($totalRead * 100 / $totalBytes), 100)
                    if ($percent -ne $lastPercent) {
                        $lastPercent = $percent
                        $totalMB = [math]::Round($totalBytes / 1MB, 2)

                        $barLength = 40
                        $completed = [math]::Floor($barLength * $percent / 100)
                        $remaining = $barLength - $completed
                        $bar = "[" + ("=" * $completed) + (">" * [math]::Min(1, $remaining)) + (" " * [math]::Max(0, $remaining - 1)) + "]"

                        Write-UiPrimary "`r  $bar $percent% ($receivedMB/$totalMB MB) $speedMB MB/s    " -NoNewline
                    }
                } else {
                    # 未知总大小：节流刷新（每 500ms 更新一次）
                    if (($now - $lastProgressTime).TotalMilliseconds -ge 500) {
                        $lastProgressTime = $now
                        Write-UiPrimary "`r  正在下载... $receivedMB MB | $speedMB MB/s    " -NoNewline
                    }
                }
            }

            $fileStream.Flush()
            $fileStream.Close()
            $fileStream = $null

            # 下载完成后换行
            Write-Host ""

            # 完整性校验：已知长度时验证实际字节数
            if ($totalBytes -gt 0 -and $totalRead -ne $totalBytes) {
                throw "下载不完整: 预期 $totalBytes 字节，实际接收 $totalRead 字节"
            }

            # 验证下载文件
            if (-not (Test-Path $OutputPath)) {
                throw "下载的文件不存在"
            }

            $fileInfo = Get-Item $OutputPath
            if ($fileInfo.Length -eq 0) {
                throw "下载的文件为空"
            }

            $downloadSuccess = $true
            $result.Success = $true
            $result.FileSize = $fileInfo.Length
            Write-UiSuccess "  ✓ 下载完成: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"

        } finally {
            # 中止请求，取消任何挂起的异步操作
            try { $request.Abort() } catch { }
            if ($fileStream)     { $fileStream.Close() }
            if ($responseStream) { $responseStream.Close() }
            if ($response)       { $response.Close() }

            # 失败时清理残留的部分文件，防止污染后续重试
            if (-not $downloadSuccess -and (Test-Path $OutputPath)) {
                try { Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue } catch { }
            }
        }

    } catch {
        $result.ErrorMessage = $_.Exception.Message
        Write-Host ""
        Write-UiDanger "  下载失败: $($result.ErrorMessage)"

        # 清理失败的文件（兜底）
        if (Test-Path $OutputPath) {
            try {
                Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue
            } catch { }
        }
    }

    return $result
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
