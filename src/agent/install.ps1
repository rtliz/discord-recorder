# Discord Recorder agent installer for Windows, served by the bot at /agent/install.ps1 (public, generic, no secrets).
#   $env:DRA_TOKEN='<pairing token>'; irm <PUBLIC_URL>/agent/install.ps1 | iex
# Installs its OWN pinned Node and ffmpeg (SHA-256 from the manifest, checked before anything is extracted) and the agent
# files into %USERPROFILE%\.discord-recorder-agent. The system node/ffmpeg are never used. Running it again updates
# everything; a spent or missing token keeps the existing pairing. The bot fills in the quoted server placeholder below.
# Everything lives in one function and never calls `exit`: under `| iex` that would close the user's window.
# Test hooks: DRA_HOME (install dir), DRA_NO_START=1 (install only), DRA_AUTOSTART=1|0 (skip the question),
# DRA_CONSENT=y|n (answers the consent question; an existing config.json means the owner already agreed).

function Install-DraAgent {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on PowerShell 5.1
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }   # Thai output

  $Server = '__SERVER__'
  $Token = $env:DRA_TOKEN
  Remove-Item Env:DRA_TOKEN -ErrorAction SilentlyContinue   # not inherited by the processes started below
  $Dir = if ($env:DRA_HOME) { $env:DRA_HOME } else { Join-Path $env:USERPROFILE '.discord-recorder-agent' }
  $Tmp = Join-Path $Dir 'tmp'
  $Target = 'win-x64'

  function Fail($msg) { Write-Host "❌ $msg" -ForegroundColor Red }

  # a pairing token is base64url: refuse anything else (\A..\z: '$' would let a trailing newline through)
  if ($Token -and $Token -notmatch '\A[A-Za-z0-9_-]+\z') { Fail 'โทเคนไม่ถูกต้อง คัดลอกคำสั่งจาก /agent ใน Discord มาใหม่ทั้งบรรทัด'; return }
  if (-not [Environment]::Is64BitOperatingSystem) { Fail 'รองรับเฉพาะ Windows 64 บิต'; return }

  # verify FILE EXPECTED LABEL: throws before anything is extracted or replaced
  function Test-Hash($file, $expected, $label) {
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower()
    if ($got -ne $expected.ToLower()) { throw "ไฟล์ $label ไม่ตรงกับค่า SHA-256 ที่กำหนด (ถูกแก้ไขหรือโหลดมาไม่ครบ) ยกเลิกการติดตั้ง ของเดิมไม่ถูกแตะ" }
  }
  function Get-File($url, $out, $label) {
    Write-Host "⬇️  กำลังโหลด $label ... (อาจใช้เวลาสักครู่)"
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out } catch { throw "โหลด $label ไม่สำเร็จ" }
  }
  function Swap-Dir($new, $dest) {
    $old = "$dest.old"
    if (Test-Path -LiteralPath $old) { Remove-Item -Recurse -Force -LiteralPath $old }
    try {
      if (Test-Path -LiteralPath $dest) { Move-Item -LiteralPath $dest -Destination $old }
      Move-Item -LiteralPath $new -Destination $dest
    } catch {
      if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $old -Destination $dest }
      throw 'แทนที่ไฟล์ไม่ได้ ถ้าตัวอัดเปิดอยู่ให้ปิดก่อน (กด q) แล้วรันคำสั่งนี้ใหม่'
    }
    if (Test-Path -LiteralPath $old) { Remove-Item -Recurse -Force -LiteralPath $old -ErrorAction SilentlyContinue }
  }

  # consent, once, before anything is downloaded or paired; the bot never asks again at recording time
  if (-not (Test-Path -LiteralPath (Join-Path $Dir 'config.json'))) {
    Write-Host 'ℹ️  ตัวอัดจะให้บอทอัดทั้งจอที่เลือกของเครื่องนี้ได้ทุกครั้งที่มีคนกดอัดหรือเปิดอัดอัตโนมัติ โดยไม่ถามอีก กด s ที่ตัวอัดเพื่อหยุดได้ทุกเมื่อ'
    $ok = $env:DRA_CONSENT
    if (-not $ok) {
      if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { Write-Host 'ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร (ต้องรันคำสั่งนี้ในหน้าต่าง PowerShell เพื่อตอบคำถาม)'; return }
      try { $ok = Read-Host 'ให้บอทอัดจอเครื่องนี้ไหม? (y/N)' } catch { $ok = '' }
    }
    if ($ok -notmatch '^(y|yes)$') { Write-Host 'ยกเลิกการติดตั้ง ไม่ได้ติดตั้งอะไร'; return }
  }

  try {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    if (Test-Path -LiteralPath $Tmp) { Remove-Item -Recurse -Force -LiteralPath $Tmp }
    New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

    Write-Host '⬇️  กำลังดึงรายการไฟล์จากบอท...'
    try { $m = Invoke-RestMethod -UseBasicParsing -Uri "$Server/agent/manifest.json" } catch { throw "ดึง $Server/agent/manifest.json ไม่ได้ ตรวจอินเทอร์เน็ตหรือให้แอดมินเช็ค PUBLIC_URL" }
    $node = $m.node.$Target; $ff = $m.ffmpeg.$Target
    if (-not ($node.url -and $node.sha256 -and $ff.url -and $ff.sha256)) { throw 'บอทยังไม่มีข้อมูล Node/ffmpeg สำหรับเครื่องนี้ (win-x64) แจ้งแอดมินให้รัน npm run build:agent' }
    foreach ($u in @($node.url, $ff.url)) { if (-not ($u -match '^(https://|http://localhost:|http://127\.0\.0\.1:)')) { throw 'ลิงก์ดาวน์โหลดในรายการไม่ใช่ https ยกเลิก' } }
    if (-not $m.files -or $m.files.Count -eq 0) { throw 'รายการไฟล์ตัวอัดจากบอทว่างเปล่า' }

    # --- Node (own copy, replaced as a whole) ---
    $nodeExe = Join-Path $Dir 'node\node.exe'
    $nodeStamp = Join-Path $Dir 'node\.sha256'
    if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $nodeStamp) -and ((Get-Content -LiteralPath $nodeStamp -Raw).Trim() -eq $node.sha256.ToLower())) {
      Write-Host '✅ Node เป็นเวอร์ชันล่าสุดแล้ว'
    } else {
      $zip = Join-Path $Tmp 'node.zip'
      Get-File $node.url $zip 'Node'
      Test-Hash $zip $node.sha256 'Node'
      $x = Join-Path $Tmp 'node-x'
      Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
      $root = Get-ChildItem -LiteralPath $x -Directory | Select-Object -First 1
      if (-not $root -or -not (Test-Path -LiteralPath (Join-Path $root.FullName 'node.exe'))) { throw 'ไฟล์ Node ที่โหลดมาไม่มี node.exe' }
      Set-Content -LiteralPath (Join-Path $root.FullName '.sha256') -Value $node.sha256.ToLower()
      Swap-Dir $root.FullName (Join-Path $Dir 'node')
      Write-Host '✅ ติดตั้ง Node แล้ว'
    }

    # --- ffmpeg (own copy in <home>\bin, where the agent looks first) ---
    $ffExe = Join-Path $Dir 'bin\ffmpeg.exe'
    $ffStamp = Join-Path $Dir 'bin\.ffmpeg.sha256'
    if ((Test-Path -LiteralPath $ffExe) -and (Test-Path -LiteralPath $ffStamp) -and ((Get-Content -LiteralPath $ffStamp -Raw).Trim() -eq $ff.sha256.ToLower())) {
      Write-Host '✅ ffmpeg เป็นเวอร์ชันล่าสุดแล้ว'
    } else {
      $zip = Join-Path $Tmp 'ffmpeg.zip'
      Get-File $ff.url $zip 'ffmpeg'
      Test-Hash $zip $ff.sha256 'ffmpeg'
      $x = Join-Path $Tmp 'ffmpeg-x'
      Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
      $exe = Get-ChildItem -LiteralPath $x -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
      if (-not $exe) { throw 'ไฟล์ ffmpeg ที่โหลดมาไม่มี ffmpeg.exe' }
      New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'bin') | Out-Null
      try { Copy-Item -LiteralPath $exe.FullName -Destination $ffExe -Force } catch { throw 'แทนที่ ffmpeg ไม่ได้ ถ้าตัวอัดเปิดอยู่ให้ปิดก่อน (กด q) แล้วรันคำสั่งนี้ใหม่' }
      Set-Content -LiteralPath $ffStamp -Value $ff.sha256.ToLower()
      Write-Host '✅ ติดตั้ง ffmpeg แล้ว'
    }

    # --- agent files ---
    $appNew = Join-Path $Tmp 'app-new'
    New-Item -ItemType Directory -Force -Path $appNew | Out-Null
    foreach ($f in $m.files) {
      if ($f.name -notmatch '^[a-z][a-z0-9-]*\.js$') { throw 'ชื่อไฟล์ในรายการไม่ถูกต้อง ยกเลิก' }
      $out = Join-Path $appNew $f.name
      try { Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/files/$($f.name)" -OutFile $out } catch { throw "โหลดไฟล์ตัวอัด $($f.name) ไม่สำเร็จ" }
      Test-Hash $out $f.sha256 $f.name
    }
    if (-not (Test-Path -LiteralPath (Join-Path $appNew 'main.js'))) { throw 'ไม่พบ main.js ในรายการไฟล์ตัวอัด' }
    # the agent is ESM; without this a bare folder of .js files is read as CommonJS
    [IO.File]::WriteAllText((Join-Path $appNew 'package.json'), '{"type":"module"}' + "`n")
    Swap-Dir $appNew (Join-Path $Dir 'app')
    Write-Host '✅ อัปเดตไฟล์ตัวอัดแล้ว'

    # launcher used by autostart and by hand; it finds its own folder, nothing is baked in
    $launcher = "@echo off`r`nset `"DRA_HOME=%~dp0.`"`r`ncd /d `"%~dp0`"`r`n`"%~dp0node\node.exe`" `"%~dp0app\main.js`"`r`n"
    [IO.File]::WriteAllText((Join-Path $Dir 'start.cmd'), $launcher)
    # uninstaller: autostart off, then this folder (backups included); (goto) lets a batch file delete its own folder.
    # The bot's side of the pairing goes with 🗑️ in /agent
    $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'discord-recorder-agent.cmd'
    $uninstall = "@echo off`r`nchcp 65001 >nul`r`nset `"D=%~dp0`"`r`nset `"D=%D:~0,-1%`"`r`n" +
      "if not exist `"%D%\app\main.js`" (echo ไม่ใช่โฟลเดอร์ตัวอัด & exit /b 1)`r`n" +
      "set `"ans=%DRA_UNINSTALL%`"`r`nif not defined ans set /p `"ans=ลบตัวอัดและไฟล์สำรองใน %D% ทั้งหมดไหม? (ปิดตัวอัดก่อนด้วย q) (y/N) `"`r`n" +
      "if /i not `"%ans%`"==`"y`" if /i not `"%ans%`"==`"yes`" (echo ยกเลิก ไม่ได้ลบอะไร & exit /b 0)`r`n" +
      "del /f /q `"$startup`" 2>nul`r`ncd /d `"%TEMP%`"`r`n" +
      "echo ลบตัวอัดแล้ว อย่าลืมกด 🗑️ ยกเลิกเครื่องนี้ใน /agent ใน Discord`r`n(goto) 2>nul & rmdir /s /q `"%D%`"`r`n"
    [IO.File]::WriteAllText((Join-Path $Dir 'uninstall.cmd'), $uninstall)

    $main = Join-Path $Dir 'app\main.js'
    $env:DRA_HOME = $Dir
    $config = Join-Path $Dir 'config.json'
    $hasCred = (Test-Path -LiteralPath $config) -and ((Get-Content -LiteralPath $config -Raw) -match '"secret"')

    # --- pairing ---
    if ($Token) {
      Write-Host '🔗 กำลังเชื่อมกับบัญชี Discord ของคุณ...'
      # the token goes in the environment of this one call, not argv (visible to other users in the process list)
      $env:DRA_TOKEN = $Token
      try { & $nodeExe $main --server $Server --pair-only --consent } finally { Remove-Item Env:DRA_TOKEN -ErrorAction SilentlyContinue }
      if ($LASTEXITCODE -eq 0) { $hasCred = $true }
      elseif ($hasCred) { Write-Host 'ℹ️  โทเคนนี้ใช้ไปแล้ว ใช้การเชื่อมต่อเดิมที่ตั้งไว้ (ถ้าต้องการเปลี่ยนบัญชี ให้ขอคำสั่งใหม่จาก /agent)' }
      else { throw 'เชื่อมกับบอทไม่สำเร็จ ขอคำสั่งใหม่จาก /agent ใน Discord แล้วลองอีกครั้ง' }
    } elseif (-not $hasCred) {
      throw 'ยังไม่ได้เชื่อมกับบอท พิมพ์ /agent ใน Discord แล้วคัดลอกคำสั่งทั้งบรรทัดมาวาง'
    }

    Write-Host ''
    Write-Host "ติดตั้งเสร็จแล้ว อยู่ที่ $Dir"
    Write-Host 'ℹ️  ตัวอัดจะอัดเฉพาะตอนที่บอทสั่ง (มีคนกดอัด หรือ server เปิดอัดอัตโนมัติ) กด s ที่ตัวอัดเพื่อหยุดได้ทุกเมื่อ'

    # --- optional autostart (opt-in): a .cmd in the Startup folder that opens the agent in its own window ---
    $ans = $env:DRA_AUTOSTART
    if (-not $ans) { try { $ans = Read-Host 'เปิดตัวอัดอัตโนมัติทุกครั้งที่เข้าเครื่องไหม? (y/N)' } catch { $ans = '' } }
    if ($ans -match '^(y|yes|1)$') {
      $cmd = "@echo off`r`nstart `"Discord Recorder`" `"$(Join-Path $Dir 'start.cmd')`"`r`n"
      [IO.File]::WriteAllText($startup, $cmd)
      Write-Host "✅ เปิดอัตโนมัติแล้ว ยกเลิกได้โดยลบไฟล์ $startup"
    } else {
      Write-Host 'ℹ️  ไม่ได้ตั้งเปิดอัตโนมัติ'
    }

    Write-Host ''
    Write-Host '📌 คำสั่งที่ใช้ภายหลัง (วางใน PowerShell หรือดับเบิลคลิกไฟล์)'
    Write-Host "   เปิดตัวอัด:  & `"$(Join-Path $Dir 'start.cmd')`""
    Write-Host "   ลบตัวอัด:    & `"$(Join-Path $Dir 'uninstall.cmd')`""
    Write-Host '   อัปเดต:      ขอคำสั่งใหม่จาก /agent ใน Discord แล้ววางอีกครั้ง'

    if ($env:DRA_NO_START -eq '1') { return }
    Write-Host ''
    Write-Host '▶️  เริ่มตัวอัด (กด q เพื่อออก)'
    & $nodeExe $main
  } catch {
    Fail $_.Exception.Message
  } finally {
    if (Test-Path -LiteralPath $Tmp) { Remove-Item -Recurse -Force -LiteralPath $Tmp -ErrorAction SilentlyContinue }
  }
}

Install-DraAgent
