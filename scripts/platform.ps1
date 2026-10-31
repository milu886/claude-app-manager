$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Installer-Signature($file) {
    # PowerShell 7 can pass its module search path to the Windows PowerShell child.
    # Load the OS module explicitly instead of accidentally selecting the PS7 copy.
    $securityModule = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module $securityModule -ErrorAction Stop
    return Get-AuthenticodeSignature -LiteralPath $file
}
function Find-ClaudePackage {
    $packages = @(Get-AppxPackage -Name 'Claude' | Where-Object { $_.Publisher -match 'CN="Anthropic, PBC"' })
    foreach ($pkg in $packages) {
        $manifest = $pkg | Get-AppxPackageManifest
        $entry = @($manifest.Package.Applications.Application | Where-Object { $_.Executable -match '(^|[\\/])claude\.exe$' }) | Select-Object -First 1
        if ($entry) { return @{ Package = $pkg; Entry = $entry } }
    }
    return $null
}
function Claude-Services($pkg) {
    $service = Get-CimInstance Win32_Service -Filter "Name='CoworkVMService'" -ErrorAction Stop
    if (-not $service) { return }
    $expected = Join-Path $pkg.InstallLocation 'app\resources\cowork-svc.exe'
    $binary = if ($service.PathName -match '^"([^"]+)"') { $Matches[1] } elseif ($service.PathName -match '^(.+?\.exe)(?:\s|$)') { $Matches[1] } else { '' }
    # A service name alone is not proof of ownership. Only control the service
    # whose executable is the cowork binary inside the installed Claude package.
    if (-not [String]::Equals($binary, $expected, [StringComparison]::OrdinalIgnoreCase)) { return }
    return @{ name = $service.Name; displayName = $service.DisplayName; state = $service.State; running = ($service.State -eq 'Running'); processId = [int]$service.ProcessId }
}
function Package-Processes($family) {
    # Windows decides "app still running" by package identity, not by path: a program started from Claude
    # (seen: a java.exe test server) inherits the identity outside the package folder. Returns $null when the
    # probe cannot be compiled (e.g. constrained language), so callers fall back to the path scan.
    try {
        if (-not ('ClaudeManager.PackageProbe' -as [type])) {
            Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
namespace ClaudeManager { public static class PackageProbe {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref uint length);
  public static string[] Of(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      uint length = 0;
      if (GetPackageFamilyName(handle, ref length, null) != 122) return null;
      var family = new StringBuilder((int)length);
      if (GetPackageFamilyName(handle, ref length, family) != 0) return null;
      uint size = 1024; var path = new StringBuilder(1024);
      return new[] { family.ToString(), QueryFullProcessImageName(handle, 0, path, ref size) ? path.ToString() : null };
    } finally { CloseHandle(handle); }
  }
} }
'@
        }
    } catch { return $null }
    $found = @(foreach ($p in Get-Process) { $probe = [ClaudeManager.PackageProbe]::Of($p.Id); if ($probe -and $probe[0] -eq $family) { @{ pid = $p.Id; name = $p.ProcessName; path = $probe[1] } } })
    return ,$found
}
function Package-Members($family, $root, $servicePids) {
    $inPackage = { param($path) $path -and $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) }
    $identity = Package-Processes $family
    if ($null -eq $identity) {
        # Win32_Process gives the same paths as Get-Process .Path in ~0.2 s instead of ~2.7 s.
        $desktop = @(Get-CimInstance Win32_Process -Property ProcessId, Name, ExecutablePath | Where-Object { $_.ProcessId -notin $servicePids -and (& $inPackage $_.ExecutablePath) } | ForEach-Object { @{ pid = [int]$_.ProcessId; name = $_.Name -replace '\.exe$', ''; path = $_.ExecutablePath } })
        return @{ desktop = $desktop; leftovers = @() }
    }
    $members = @($identity | Where-Object { $_.pid -notin $servicePids })
    return @{ desktop = @($members | Where-Object { & $inPackage $_.path }); leftovers = @($members | Where-Object { -not (& $inPackage $_.path) }) }
}
function Desktop-Running($before) {
    if (-not $before.family) { return @(Get-Process -Name Claude -ErrorAction SilentlyContinue).Count -gt 0 }
    return @((Package-Members $before.family $before.root @($before.services | ForEach-Object { $_.processId })).desktop).Count -gt 0
}
function Close-Leftovers($leftovers) {
    foreach ($item in @($leftovers)) { Stop-Process -Id $item.pid -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @($leftovers | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue }).Count) { Start-Sleep -Milliseconds 200 }
}
function Assert-Signature($file) {
    $sig = Installer-Signature $file
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '(^|,\s*)CN="Anthropic, PBC"(,|$)') { throw "Claude 安装包签名无效或发布者不匹配：$($sig.Status)" }
}
function Wait-ProcessExit($service) {
    # SCM reports Stopped before the service process has finished shutting down (e.g. its VM). That process
    # still carries the Claude package identity, so deploying at that moment is deferred as "app still running".
    $deadline = (Get-Date).AddSeconds(60)
    while ($service.processId -and (Get-Process -Id $service.processId -ErrorAction SilentlyContinue)) {
        if ((Get-Date) -gt $deadline) { throw "Claude 后台服务 $($service.name) 已停止，但其进程 $($service.processId) 在 60 秒内未退出。" }
        Start-Sleep -Milliseconds 250
    }
}
function Deferral-Reason($since, $family) {
    # Read Windows' own reason from the deployment log: 638 names the running app, 9641 an active service.
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-AppXDeploymentServer/Operational'; Id = 638, 9641; StartTime = $since } -ErrorAction SilentlyContinue)
    $apps = @($events | Where-Object { $_.Id -eq 638 -and [string]$_.Properties[0].Value -like "$family!*" } | ForEach-Object { [string]$_.Properties[0].Value } | Select-Object -Unique)
    $service = @($events | Where-Object { $_.Id -eq 9641 -and [string]$_.Properties[1].Value -like "$family!*" }).Count -gt 0
    return @{ runningApps = $apps; activeService = $service }
}
function Install-Claude($file, $before) {
    $restore = @()
    $script:serviceWarnings = @()
    try {
        # An active desktop session must not be disrupted. For an idle desktop,
        # gracefully pause the package-owned service instead of waiting forever.
        if (-not $before.running) {
            foreach ($service in @($before.services)) {
                if ($service.running) {
                    $restore += $service.name
                    Stop-Service -Name $service.name -ErrorAction Stop
                    (Get-Service -Name $service.name -ErrorAction Stop).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
                    Wait-ProcessExit $service
                }
            }
        }
        # CoworkVMService is trigger-started and package components can keep the Claude identity in processes a
        # standard user cannot see, so an idle desktop could still be deferred forever. Without a visible desktop,
        # let Windows close the package's leftover processes; with one (even if it just started), keep deferring.
        $script:forcedShutdown = -not $before.running -and -not (Desktop-Running $before)
        if ($script:forcedShutdown) { Add-AppxPackage -Path $file -ForceApplicationShutdown -ErrorAction Stop }
        else { Add-AppxPackage -Path $file -DeferRegistrationWhenPackagesAreInUse -ErrorAction Stop }
    } finally {
        foreach ($name in $restore) {
            try {
                Start-Service -Name $name -ErrorAction Stop
                (Get-Service -Name $name -ErrorAction Stop).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
            } catch { $script:serviceWarnings += "Claude 后台服务 $name 未能恢复：$($_.Exception.Message)" }
        }
    }
}
function Status {
    $found = Find-ClaudePackage
    if ($found) {
        $pkg = $found.Package
        $root = $pkg.InstallLocation.TrimEnd('\') + '\'
        $services = @(Claude-Services $pkg)
        $servicePids = @($services | ForEach-Object { $_.processId })
        # Not by process name: the standalone Claude Code CLI is also claude.exe but is not this package.
        $members = Package-Members $pkg.PackageFamilyName $root $servicePids
        $desktop = @($members.desktop); $leftovers = @($members.leftovers | Select-Object -First 10)
        return @{ installed = $true; kind = 'msix'; version = $pkg.Version.ToString(); path = $pkg.InstallLocation; packageFullName = $pkg.PackageFullName; aumid = "$($pkg.PackageFamilyName)!$($found.Entry.Id)"; family = $pkg.PackageFamilyName; root = $root; running = ($desktop.Count -gt 0); runningProcesses = @($desktop | ForEach-Object { $_.name } | Select-Object -Unique); leftovers = $leftovers; services = $services }
    }
    $running = @(Get-Process -Name Claude -ErrorAction SilentlyContinue).Count -gt 0
    $classic = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'
    $legacy = Join-Path $env:LOCALAPPDATA 'Claude\claude.exe'
    foreach ($candidate in @($classic, $legacy)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $version = (Get-Item -LiteralPath $candidate).VersionInfo.ProductVersion -replace '[-+].*$', ''
            if ($version -match '^\d+(\.\d+){1,3}$') { return @{ installed=$true; kind='classic'; version=$version; path=$candidate; running=$running } }
        }
    }
    return @{ installed=$false; running=$running; kind=$null; version=$null }
}
try {
    switch ($managerParams.action) {
        'status' { $result = Status }
        'signature' {
            $sig = Installer-Signature $managerParams.file
            $result = @{ status = [string]$sig.Status; subject = $sig.SignerCertificate.Subject }
        }
        'install' {
            if ($managerParams.version -notmatch '^\d+(\.\d+){1,3}$') { throw '安装目标版本无效。' }
            $parts = @($managerParams.version -split '\.')
            while ($parts.Count -lt 4) { $parts += '0' }
            $targetVersion = [Version]($parts -join '.')
            $before = Status
            if ($before.version -and [Version]$before.version -gt $targetVersion) { throw '检测到更新的已安装版本，已阻止降级。' }
            if ($before.kind -eq 'classic' -and $before.running) { throw '传统版本 Claude 正在运行，请退出后再安装。' }
            if (-not $before.running -and @($before.leftovers).Count) {
                # Windows would wait ~90 s for these to close and then kill them anyway. Close only the processes the
                # user approved by PID, and only while they still carry Claude's identity; otherwise ask first.
                $approved = @($managerParams.closeProcesses | ForEach-Object { [int]$_ })
                if (@($before.leftovers | Where-Object { $_.pid -notin $approved }).Count) { $result = @{ needsConfirmation = $true; leftovers = @($before.leftovers) }; break }
                Close-Leftovers $before.leftovers
            }
            Assert-Signature $managerParams.file
            $started = (Get-Date).AddSeconds(-1)
            Install-Claude $managerParams.file $before
            $result = Status
            if (-not $result.installed -or $result.kind -ne 'msix') { throw '安装命令完成，但未检测到 Claude MSIX。请检查 Windows 应用安装服务。' }
            $result.pending = [Version]$result.version -lt $targetVersion
            if ($result.pending) {
                $reason = Deferral-Reason $started ($result.aumid -replace '!.*$', '')
                $result.deferral = @{ runningApps = $reason.runningApps; activeService = $reason.activeService; desktopRunning = [bool]$before.running; forcedShutdown = [bool]$script:forcedShutdown; stoppedServices = @($before.services | Where-Object { $_.running -and -not $before.running } | ForEach-Object { $_.name }) }
            }
            $result.targetVersion = $managerParams.version
            $result.warnings = @($script:serviceWarnings)
        }
        'stage' {
            # Unpacks the package into WindowsApps without registering it; a running Claude is unaffected.
            Assert-Signature $managerParams.file
            Add-AppxPackage -Path $managerParams.file -Stage -ErrorAction Stop
            $result = @{ staged = $true }
        }
        'launch' {
            $current = Status
            if (-not $current.installed) { throw '未检测到已安装的 Claude。' }
            if ($current.kind -eq 'msix') { Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($current.aumid)" }
            else { Start-Process -FilePath $current.path }
            $result = @{ launched=$true }
        }
        'uninstall' {
            $found = Find-ClaudePackage
            if (-not $found) { throw '未检测到 Claude MSIX。传统安装请在 Windows 设置中卸载。' }
            if (@(Get-Process -Name Claude -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Claude 正在运行，请退出后再卸载。' }
            Remove-AppxPackage -Package $found.Package.PackageFullName -PreserveApplicationData -ErrorAction Stop
            $result = Status
            if ($result.kind -eq 'msix') { throw '卸载后仍检测到 Claude MSIX。' }
        }
        default { throw '未知操作' }
    }
    @{ ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 6
} catch {
    $detail = $_.Exception.Message
    if ($script:serviceWarnings) { $detail += "`n" + ($script:serviceWarnings -join "`n") }
    $code = if ($detail -match '0x[0-9A-Fa-f]{8}') { $Matches[0] } else { '0x{0:X8}' -f $_.Exception.HResult }
    @{ ok = $false; error = @{ message = $detail; code = $code; action = $managerParams.action; category = [string]$_.CategoryInfo.Category } } | ConvertTo-Json -Compress -Depth 6
    exit 1
}
