# Резерв на ноутбуке владельца: обратный проброс станции -> ретранслятор звука (rh-udp-relay.ps1).
# На станции порт 127.0.0.1:11195 (11194 занимает офисный компьютер) приходит сюда.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$key = "$env:USERPROFILE\.ssh\royalhome_ops"
$log = "$dir\laptop-udp-leg.log"
$pf = "$dir\relay-port.txt"
$o = @('-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','ConnectTimeout=15','-i',$key)
while ($true) {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item $log "$log.old" -Force }
  for ($i = 0; $i -lt 30 -and -not (Test-Path $pf); $i++) { Start-Sleep 1 }
  $lp = (Get-Content $pf -Raw -ErrorAction SilentlyContinue)
  if (-not $lp) { Add-Content $log 'нет файла порта ретранслятора'; Start-Sleep 5; continue }
  Add-Content $log ((Get-Date).ToString('s') + ' start udp-leg -> порт ' + $lp.Trim())
  & ssh @o -R "127.0.0.1:11195:127.0.0.1:$($lp.Trim())" root@10.155.0.95 2>&1 | Add-Content $log
  Start-Sleep 5
}
