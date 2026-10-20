@echo off
rem Royal Home - office bridge installer. Double-click this ONE file. Remove: run-bridge.cmd uninstall
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%1' -Verb RunAs"
  exit /b
)
set "RH_UNINSTALL=0"
if /i "%~1"=="uninstall" set "RH_UNINSTALL=1"
set "RH_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:RH_SELF,[Text.Encoding]::UTF8); $i=$t.IndexOf('#'+'PS-BEGIN'); Invoke-Expression $t.Substring($i)"
echo.
pause
exit /b
#PS-BEGIN
# Royal Home — офисный мост телефонной станции.
# Запускать на офисном компьютере (Windows) ОДИН раз: правый клик -> «Выполнить с помощью PowerShell».
# Повторный запуск безопасен. Удаление:  .\install-office-bridge.ps1 -Uninstall
$Uninstall = ($env:RH_UNINSTALL -eq '1')

$ErrorActionPreference = 'Stop'
$dir = 'C:\RoyalHomeBridge'

# --- права администратора -------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    if (-not $PSCommandPath) { Write-Host 'Откройте PowerShell «от имени администратора» и запустите файл снова.' -ForegroundColor Red; exit 1 }
    $extra = ''; if ($Uninstall) { $extra = ' -Uninstall' }
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"$extra"
    exit
}

if ($Uninstall) {
    foreach ($n in 'RH-Bridge-station', 'RH-Bridge-vps', 'RH-Bridge-udp', 'RH-UdpRelay') {
        Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match 'RoyalHomeBridge' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host 'Мост удалён. Папку C:\RoyalHomeBridge можно стереть вручную.' -ForegroundColor Green
    exit
}

Write-Host '=== Royal Home: офисный мост станции ===' -ForegroundColor Cyan

# --- 1. клиент ssh --------------------------------------------------------
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
if (-not (Test-Path $ssh)) {
    Write-Host 'Ставлю клиент OpenSSH (нужен интернет)...'
    Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null
}
if (-not (Test-Path $ssh)) { Write-Host 'Не получилось поставить OpenSSH. Напишите об этом Claude.' -ForegroundColor Red; exit 1 }
$keygen = "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe"

New-Item -ItemType Directory -Force $dir | Out-Null

# --- 2. ключ (создаётся один раз, секретная часть не покидает компьютер) ---
$key = "$dir\bridge_key"
if (-not (Test-Path $key)) {
    & $keygen -q -t ed25519 -N '""' -C "office-bridge-$env:COMPUTERNAME" -f $key | Out-Null
}
# по SID, а не по имени: на русской Windows группа называется «Администраторы».
# Окончательно права приводит в порядок сама петля (из-под SYSTEM): ssh отказывается читать ключ с чужим владельцем.
icacls $key /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null

# --- 3. отпечатки серверов (защита от подмены) ------------------------------
@(
    '85.198.70.182 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDHj/xz1ccSh6LglWhrisJvwvNLQqH/BU3BwhprngFkE',
    '10.155.0.95 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOCjHbvEmuNCqN5UmKCeOdm/7U25RoujhAb3phm5wXxK'
) | Set-Content -Path "$dir\known_hosts" -Encoding ASCII

# --- 4. петля моста ---------------------------------------------------------
$loop = @'
param([ValidateSet('station','vps','udp')][string]$Side)
$dir = 'C:\RoyalHomeBridge'
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$log = "$dir\bridge-$Side.log"
$o = @('-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',
       '-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$dir\known_hosts",'-i',"$dir\bridge_key")
while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item $log "$log.old" -Force }
  # ssh под SYSTEM берёт ключ только если владелец и единственный доступ — SYSTEM
  & icacls "$dir\bridge_key" /reset 2>&1 | Out-Null
  & icacls "$dir\bridge_key" /setowner '*S-1-5-18' 2>&1 | Out-Null
  & icacls "$dir\bridge_key" /inheritance:r 2>&1 | Out-Null
  & icacls "$dir\bridge_key" /grant:r '*S-1-5-18:F' 2>&1 | Out-Null
  Add-Content $log ((Get-Date).ToString('s') + " start $Side")
  if ($Side -eq 'station') {
    # компьютер -> станция: свои порты на этом компьютере смотрят на станцию
    $a = $o + @('-L','127.0.0.1:38088:127.0.0.1:8088','-L','127.0.0.1:35038:127.0.0.1:5038','-L','127.0.0.1:38090:127.0.0.1:8090','-L','127.0.0.1:32222:127.0.0.1:22','root@10.155.0.95')
  } elseif ($Side -eq 'udp') {
    # обратный проброс: на станции 127.0.0.1:11194 приходит сюда, в ретранслятор (порт выбирает он и пишет в файл)
    $pf = "$dir\relay-port.txt"
    for ($i = 0; $i -lt 30 -and -not (Test-Path $pf); $i++) { Start-Sleep 1 }
    $lp = (Get-Content $pf -Raw -ErrorAction SilentlyContinue)
    if (-not $lp) { Add-Content $log 'нет файла порта ретранслятора'; Start-Sleep 5; continue }
    $a = $o + @('-R',"127.0.0.1:11194:127.0.0.1:$($lp.Trim())",'root@10.155.0.95')
  } else {
    # компьютер -> сервер CRM: порты сервера выведены на этот компьютер
    $a = $o + @('-R','0.0.0.0:8088:127.0.0.1:38088','-R','0.0.0.0:5038:127.0.0.1:35038','-R','0.0.0.0:8090:127.0.0.1:38090','-R','127.0.0.1:2222:127.0.0.1:32222','rh-tunnel@85.198.70.182')
  }
  & $ssh @a 2>&1 | Add-Content $log
  Start-Sleep 5
}
'@
Set-Content -Path "$dir\bridge-loop.ps1" -Value $loop -Encoding UTF8

$relayB64 = @'
IyDQoNC10YLRgNCw0L3RgdC70Y/RgtC+0YAgT3BlblZQTjogVENQICjQuNC3IFNTSC3RgtC+0L3QvdC10LvRjyDRgdGC0LDQvdGG
0LjQuCkgPC0+IFVEUCAo0L3QsCDRgdC10YDQstC10YAgQ1JNKS4KIyDQodGC0LDQvdGG0LjRjyDQt9CwIE5BVCDQuCDRgdCw0LzQ
sCDQvdCw0YDRg9C20YMg0L3QtSDQstGL0YXQvtC00LjRgiwg0L/QvtGN0YLQvtC80YMg0LXRkSBPcGVuVlBOINGA0LDQsdC+0YLQ
sNC10YIg0LrQsNC6IHRjcC1jbGllbnQKIyDQvdCwIDEyNy4wLjAuMToxMTE5NCDRgdGC0LDQvdGG0LjQuCAo0Y3RgtC+INC+0LHR
gNCw0YLQvdGL0LkgU1NILdC/0YDQvtCx0YDQvtGBINC00L4g0L/QvtGA0YLQsCwg0LrQvtGC0L7RgNGL0Lkg0LLRi9Cx0YDQsNC7
INGN0YLQvtGCINGB0LrRgNC40L/RgiksINCwINC30LTQtdGB0Ywg0L/QsNC60LXRgtGLINGBIDIt0LHQsNC50YLQvtCy0L7QuSDQ
tNC70LjQvdC+0LkKIyAo0YTQvtGA0LzQsNGCIE9wZW5WUE4tb3Zlci1UQ1ApINC/0YDQtdCy0YDQsNGJ0LDRjtGC0YHRjyDQvtCx
0YDQsNGC0L3QviDQsiBVRFAt0LTQsNGC0LDQs9GA0LDQvNC80Ysg0LTQviA4NS4xOTguNzAuMTgyOjExOTQuCiMg0KHQvtC00LXR
gNC20LjQvNC+0LUg0L3QtSDRgNCw0LfQsdC40YDQsNC10YLRgdGPOiDQv9Cw0LrQtdGC0Ysg0LfQsNGI0LjRhNGA0L7QstCw0L3R
iyDRgdGC0LDRgtC40YfQtdGB0LrQuNC8INC60LvRjtGH0L7QvCDRgdGC0LDQvdGG0LjQuCDQuCDRgdC10YDQstC10YDQsC4KcGFy
YW0oCiAgICBbaW50XSRGaXJzdFBvcnQgPSAxMTE5NCwKICAgIFtzdHJpbmddJFVkcEhvc3QgPSAnODUuMTk4LjcwLjE4MicsCiAg
ICBbaW50XSRVZHBQb3J0ID0gMTE5NCwKICAgIFtzdHJpbmddJExvZ1BhdGggPSAiJFBTU2NyaXB0Um9vdFxyZWxheS5sb2ciLAog
ICAgW3N0cmluZ10kUG9ydEZpbGUgPSAiJFBTU2NyaXB0Um9vdFxyZWxheS1wb3J0LnR4dCIKKQoKQWRkLVR5cGUgLVR5cGVEZWZp
bml0aW9uIEAnCnVzaW5nIFN5c3RlbTsKdXNpbmcgU3lzdGVtLklPOwp1c2luZyBTeXN0ZW0uTmV0Owp1c2luZyBTeXN0ZW0uTmV0
LlNvY2tldHM7CnVzaW5nIFN5c3RlbS5UaHJlYWRpbmc7CgpwdWJsaWMgc3RhdGljIGNsYXNzIFJoVWRwUmVsYXkKewogICAgc3Rh
dGljIHN0cmluZyBsb2dQYXRoOwogICAgc3RhdGljIHJlYWRvbmx5IG9iamVjdCBsb2dMb2NrID0gbmV3IG9iamVjdCgpOwoKICAg
IHN0YXRpYyB2b2lkIExvZyhzdHJpbmcgbSkKICAgIHsKICAgICAgICB0cnkgeyBsb2NrIChsb2dMb2NrKSB7IEZpbGUuQXBwZW5k
QWxsVGV4dChsb2dQYXRoLCBEYXRlVGltZS5Ob3cuVG9TdHJpbmcoInMiKSArICIgIiArIG0gKyAiXHJcbiIpOyB9IH0gY2F0Y2gg
eyB9CiAgICB9CgogICAgc3RhdGljIGJvb2wgUmVhZEZ1bGwoU3RyZWFtIHMsIGJ5dGVbXSBiLCBpbnQgbikKICAgIHsKICAgICAg
ICBpbnQgZ290ID0gMDsKICAgICAgICB3aGlsZSAoZ290IDwgbikKICAgICAgICB7CiAgICAgICAgICAgIGludCByID0gcy5SZWFk
KGIsIGdvdCwgbiAtIGdvdCk7CiAgICAgICAgICAgIGlmIChyIDw9IDApIHJldHVybiBmYWxzZTsKICAgICAgICAgICAgZ290ICs9
IHI7CiAgICAgICAgfQogICAgICAgIHJldHVybiB0cnVlOwogICAgfQoKICAgIHB1YmxpYyBzdGF0aWMgdm9pZCBSdW4oaW50IGZp
cnN0UG9ydCwgc3RyaW5nIHVkcEhvc3QsIGludCB1ZHBQb3J0LCBzdHJpbmcgbG9nLCBzdHJpbmcgcG9ydEZpbGUpCiAgICB7CiAg
ICAgICAgbG9nUGF0aCA9IGxvZzsKICAgICAgICAvLyDQv9C+0YDRgtGLINCyINC30LDRgNC10LfQtdGA0LLQuNGA0L7QstCw0L3Q
vdGL0YUgV2luZG93cyDQtNC40LDQv9Cw0LfQvtC90LDRhSAobmV0c2ggZXhjbHVkZWRwb3J0cmFuZ2UpINC90LUg0YHQu9GD0YjQ
sNGO0YLRgdGPOiDQsdC10YDRkdC8INC/0LXRgNCy0YvQuSDRgdCy0L7QsdC+0LTQvdGL0LkKICAgICAgICBUY3BMaXN0ZW5lciBs
ID0gbnVsbDsKICAgICAgICBpbnQgbGlzdGVuUG9ydCA9IDA7CiAgICAgICAgZm9yIChpbnQgcCA9IGZpcnN0UG9ydDsgcCA8IGZp
cnN0UG9ydCArIDYwICYmIGwgPT0gbnVsbDsgcCsrKQogICAgICAgIHsKICAgICAgICAgICAgdHJ5IHsgdmFyIHQgPSBuZXcgVGNw
TGlzdGVuZXIoSVBBZGRyZXNzLkxvb3BiYWNrLCBwKTsgdC5TdGFydCgpOyBsID0gdDsgbGlzdGVuUG9ydCA9IHA7IH0gY2F0Y2gg
eyB9CiAgICAgICAgfQogICAgICAgIGlmIChsID09IG51bGwpIHRocm93IG5ldyBFeGNlcHRpb24oItC90LXRgiDRgdCy0L7QsdC+
0LTQvdC+0LPQviDQv9C+0YDRgtCwINGA0Y/QtNC+0Lwg0YEgIiArIGZpcnN0UG9ydCk7CiAgICAgICAgRmlsZS5Xcml0ZUFsbFRl
eHQocG9ydEZpbGUsIGxpc3RlblBvcnQuVG9TdHJpbmcoKSk7CiAgICAgICAgTG9nKCLRgdC70YPRiNCw0Y4gMTI3LjAuMC4xOiIg
KyBsaXN0ZW5Qb3J0ICsgIiAtPiB1ZHAgIiArIHVkcEhvc3QgKyAiOiIgKyB1ZHBQb3J0KTsKICAgICAgICB3aGlsZSAodHJ1ZSkK
ICAgICAgICB7CiAgICAgICAgICAgIFRjcENsaWVudCBjID0gbC5BY2NlcHRUY3BDbGllbnQoKTsKICAgICAgICAgICAgdmFyIHQg
PSBuZXcgVGhyZWFkKCgpID0+IEhhbmRsZShjLCB1ZHBIb3N0LCB1ZHBQb3J0KSk7CiAgICAgICAgICAgIHQuSXNCYWNrZ3JvdW5k
ID0gdHJ1ZTsKICAgICAgICAgICAgdC5TdGFydCgpOwogICAgICAgIH0KICAgIH0KCiAgICBzdGF0aWMgdm9pZCBIYW5kbGUoVGNw
Q2xpZW50IGMsIHN0cmluZyBob3N0LCBpbnQgcG9ydCkKICAgIHsKICAgICAgICBMb2coItGB0YLQsNC90YbQuNGPINC/0L7QtNC6
0LvRjtGH0LjQu9Cw0YHRjCIpOwogICAgICAgIFVkcENsaWVudCB1ZHAgPSBudWxsOwogICAgICAgIHRyeQogICAgICAgIHsKICAg
ICAgICAgICAgYy5Ob0RlbGF5ID0gdHJ1ZTsKICAgICAgICAgICAgU3RyZWFtIG5zID0gYy5HZXRTdHJlYW0oKTsKICAgICAgICAg
ICAgdWRwID0gbmV3IFVkcENsaWVudCgpOwogICAgICAgICAgICB1ZHAuQ29ubmVjdChob3N0LCBwb3J0KTsKICAgICAgICAgICAg
VWRwQ2xpZW50IHUgPSB1ZHA7CiAgICAgICAgICAgIHZhciBiYWNrID0gbmV3IFRocmVhZCgoKSA9PgogICAgICAgICAgICB7CiAg
ICAgICAgICAgICAgICB0cnkKICAgICAgICAgICAgICAgIHsKICAgICAgICAgICAgICAgICAgICB2YXIgZXAgPSBuZXcgSVBFbmRQ
b2ludChJUEFkZHJlc3MuQW55LCAwKTsKICAgICAgICAgICAgICAgICAgICB3aGlsZSAodHJ1ZSkKICAgICAgICAgICAgICAgICAg
ICB7CiAgICAgICAgICAgICAgICAgICAgICAgIGJ5dGVbXSBkID0gdS5SZWNlaXZlKHJlZiBlcCk7CiAgICAgICAgICAgICAgICAg
ICAgICAgIHZhciBmcmFtZSA9IG5ldyBieXRlW2QuTGVuZ3RoICsgMl07CiAgICAgICAgICAgICAgICAgICAgICAgIGZyYW1lWzBd
ID0gKGJ5dGUpKGQuTGVuZ3RoID4+IDgpOwogICAgICAgICAgICAgICAgICAgICAgICBmcmFtZVsxXSA9IChieXRlKShkLkxlbmd0
aCAmIDB4ZmYpOwogICAgICAgICAgICAgICAgICAgICAgICBCdWZmZXIuQmxvY2tDb3B5KGQsIDAsIGZyYW1lLCAyLCBkLkxlbmd0
aCk7CiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2sgKG5zKSB7IG5zLldyaXRlKGZyYW1lLCAwLCBmcmFtZS5MZW5ndGgpOyBu
cy5GbHVzaCgpOyB9CiAgICAgICAgICAgICAgICAgICAgfQogICAgICAgICAgICAgICAgfQogICAgICAgICAgICAgICAgY2F0Y2gg
eyB9CiAgICAgICAgICAgICAgICB0cnkgeyBjLkNsb3NlKCk7IH0gY2F0Y2ggeyB9CiAgICAgICAgICAgIH0pOwogICAgICAgICAg
ICBiYWNrLklzQmFja2dyb3VuZCA9IHRydWU7CiAgICAgICAgICAgIGJhY2suU3RhcnQoKTsKCiAgICAgICAgICAgIHZhciBoZHIg
PSBuZXcgYnl0ZVsyXTsKICAgICAgICAgICAgd2hpbGUgKFJlYWRGdWxsKG5zLCBoZHIsIDIpKQogICAgICAgICAgICB7CiAgICAg
ICAgICAgICAgICBpbnQgbGVuID0gKGhkclswXSA8PCA4KSB8IGhkclsxXTsKICAgICAgICAgICAgICAgIHZhciBidWYgPSBuZXcg
Ynl0ZVtsZW5dOwogICAgICAgICAgICAgICAgaWYgKCFSZWFkRnVsbChucywgYnVmLCBsZW4pKSBicmVhazsKICAgICAgICAgICAg
ICAgIHVkcC5TZW5kKGJ1ZiwgbGVuKTsKICAgICAgICAgICAgfQogICAgICAgIH0KICAgICAgICBjYXRjaCAoRXhjZXB0aW9uIGUp
IHsgTG9nKCLQvtGI0LjQsdC60LA6ICIgKyBlLk1lc3NhZ2UpOyB9CiAgICAgICAgZmluYWxseQogICAgICAgIHsKICAgICAgICAg
ICAgdHJ5IHsgaWYgKHVkcCAhPSBudWxsKSB1ZHAuQ2xvc2UoKTsgfSBjYXRjaCB7IH0KICAgICAgICAgICAgdHJ5IHsgYy5DbG9z
ZSgpOyB9IGNhdGNoIHsgfQogICAgICAgICAgICBMb2coItGB0YLQsNC90YbQuNGPINC+0YLQutC70Y7Rh9C40LvQsNGB0YwiKTsK
ICAgICAgICB9CiAgICB9Cn0KJ0AKCndoaWxlICgkdHJ1ZSkgewogICAgaWYgKChUZXN0LVBhdGggJExvZ1BhdGgpIC1hbmQgKChH
ZXQtSXRlbSAkTG9nUGF0aCkuTGVuZ3RoIC1ndCAxTUIpKSB7IE1vdmUtSXRlbSAkTG9nUGF0aCAiJExvZ1BhdGgub2xkIiAtRm9y
Y2UgfQogICAgdHJ5IHsgW1JoVWRwUmVsYXldOjpSdW4oJEZpcnN0UG9ydCwgJFVkcEhvc3QsICRVZHBQb3J0LCAkTG9nUGF0aCwg
JFBvcnRGaWxlKSB9CiAgICBjYXRjaCB7IEFkZC1Db250ZW50ICRMb2dQYXRoICgoR2V0LURhdGUpLlRvU3RyaW5nKCdzJykgKyAn
IHJlbGF5INGD0L/QsNC7OiAnICsgJF8uRXhjZXB0aW9uLk1lc3NhZ2UpIH0KICAgIFN0YXJ0LVNsZWVwIDUKfQo=
'@
[IO.File]::WriteAllText("$dir\rh-udp-relay.ps1", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($relayB64 -replace '\s', ''))), (New-Object Text.UTF8Encoding($true)))

# --- 5. задачи планировщика (старые копии петли гасим, иначе их станет две)
foreach ($n in 'RH-Bridge-station', 'RH-Bridge-vps', 'RH-Bridge-udp', 'RH-UdpRelay') { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bridge-loop\.ps1|rh-udp-relay\.ps1' -or ($_.Name -eq 'ssh.exe' -and $_.CommandLine -match 'RoyalHomeBridge') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
# --- задачи планировщика: запуск при старте Windows, от SYSTEM, без входа -
function Register-RhTask($name, $psArgs) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
    $trg = New-ScheduledTaskTrigger -AtStartup
    $pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $name -Action $act -Trigger $trg -Principal $pri -Settings $set | Out-Null
    Start-ScheduledTask -TaskName $name
}
Remove-Item "$dir\relay-port.txt" -Force -ErrorAction SilentlyContinue
Register-RhTask 'RH-UdpRelay' "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\rh-udp-relay.ps1`""
foreach ($side in 'station', 'vps', 'udp') {
    Register-RhTask "RH-Bridge-$side" "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\bridge-loop.ps1`" -Side $side"
}

# --- 6. компьютер не засыпает ---------------------------------------------
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-dc 0 | Out-Null
powercfg /change hibernate-timeout-dc 0 | Out-Null

# --- 7. что видно с этого компьютера ----------------------------------------
$pub = (Get-Content "$key.pub" -Raw).Trim()
Set-Content -Path "$dir\PUBLIC-KEY.txt" -Value $pub -Encoding ASCII
try { Set-Clipboard -Value $pub } catch {}
function Test-Port($h, $p) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $r = $c.BeginConnect($h, $p, $null, $null)
        $ok = $r.AsyncWaitHandle.WaitOne(5000) -and $c.Connected
        $c.Close(); return $ok
    } catch { return $false }
}
$okSrv = Test-Port '85.198.70.182' 22
$okPbx = Test-Port '10.155.0.95' 22
$ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress

Write-Host ''
Write-Host "Компьютер: $env:COMPUTERNAME   адрес: $ip"
Write-Host ("Достаёт до сервера CRM (85.198.70.182:22): " + $(if ($okSrv) { 'ДА' } else { 'НЕТ  <- скажите Claude' }))
Write-Host ("Достаёт до станции (10.155.0.95:22):       " + $(if ($okPbx) { 'ДА' } else { 'НЕТ  <- скажите Claude' }))
Write-Host 'Жду 20 секунд и смотрю, подключился ли мост...'
Start-Sleep 20
foreach ($side in 'station', 'vps', 'udp') {
    Write-Host "--- журнал $side (последние строки) ---"
    if (Test-Path "$dir\bridge-$side.log") { Get-Content "$dir\bridge-$side.log" -Tail 6 }
}
Write-Host ''
Write-Host 'ОТПРАВЬТЕ ЭТУ СТРОКУ CLAUDE (она уже скопирована в буфер, это ОТКРЫТЫЙ ключ, его можно показывать):' -ForegroundColor Yellow
Write-Host $pub -ForegroundColor White
Write-Host ''
Write-Host 'Пока Claude не разрешит ключ, мост будет пробовать подключиться каждые 5 секунд. После разрешения всё заработает само.'
Write-Host 'Не выключайте компьютер. Закрепите ему постоянный адрес в роутере (DHCP-резервирование) и по возможности подключите кабелем, не Wi-Fi.'
Read-Host 'Нажмите Enter, чтобы закрыть окно'
