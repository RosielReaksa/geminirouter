# Builds the Framecall helper for Windows, macOS and Linux.
#
# Windows signing (optional, enabled when credentials are present):
#   WINDOWS_CERT_PATH        path to a .pfx code-signing certificate
#   WINDOWS_CERT_PASSWORD    password for that .pfx
#   WINDOWS_CERT_THUMBPRINT  alternative: thumbprint of a cert in Cert:\CurrentUser\My
#   WINDOWS_TIMESTAMP_URL    timestamp server (default http://timestamp.digicert.com)
#
# signtool.exe is used when the Windows SDK is installed; otherwise the build
# falls back to Set-AuthenticodeSignature. Without credentials the binaries are
# built unsigned and a warning is printed.
#
# macOS signing + notarization must run on macOS: see sign-macos.sh.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null

go test ./...
if ($LASTEXITCODE -ne 0) { throw "tests failed" }

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")
  foreach ($root in $roots) {
    if ($root -and (Test-Path $root)) {
      $found = Get-ChildItem $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  }
  return $null
}

function Get-SigningCertificate {
  if ($env:WINDOWS_CERT_PATH) {
    # Get-PfxCertificate has no -Password on Windows PowerShell 5.1, so load it
    # through .NET directly (user key set avoids requiring admin rights).
    $keyFlags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]
    $flags = $keyFlags::UserKeySet -bor $keyFlags::Exportable -bor $keyFlags::PersistKeySet
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:WINDOWS_CERT_PATH, $env:WINDOWS_CERT_PASSWORD, $flags)
  }
  if ($env:WINDOWS_CERT_THUMBPRINT) {
    return Get-ChildItem Cert:\CurrentUser\My |
      Where-Object { $_.Thumbprint -eq $env:WINDOWS_CERT_THUMBPRINT } |
      Select-Object -First 1
  }
  return $null
}

function Sign-Binary([string] $path) {
  $cert = Get-SigningCertificate
  if (-not $cert) {
    Write-Warning "unsigned: $path (set WINDOWS_CERT_PATH or WINDOWS_CERT_THUMBPRINT to sign)"
    return
  }
  $timestamp = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
  $signtool = Find-SignTool

  if ($signtool) {
    Write-Host "  signing with signtool: $signtool"
    if ($env:WINDOWS_CERT_PATH) {
      & $signtool sign /fd SHA256 /td SHA256 /tr $timestamp /f $env:WINDOWS_CERT_PATH /p $env:WINDOWS_CERT_PASSWORD $path
    } else {
      & $signtool sign /fd SHA256 /td SHA256 /tr $timestamp /sha1 $env:WINDOWS_CERT_THUMBPRINT $path
    }
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for $path" }
  } else {
    Write-Host "  signing with Set-AuthenticodeSignature"
    $result = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -TimestampServer $timestamp -HashAlgorithm SHA256
    if ($result.Status -eq 'NotSigned') { throw "signing failed for $path" }
    if ($result.Status -ne 'Valid') { Write-Warning "signature status for $path is $($result.Status) (self-signed or untrusted chain?)" }
  }

  $check = Get-AuthenticodeSignature -FilePath $path
  if ($check.Status -eq 'NotSigned') { throw "no signature on $path after signing" }
  Write-Host "  signature: $($check.Status)"
}

$targets = @(
  @{ GOOS = 'windows'; GOARCH = 'amd64'; Name = 'framecall-helper-windows-amd64.exe' },
  @{ GOOS = 'windows'; GOARCH = 'arm64'; Name = 'framecall-helper-windows-arm64.exe' },
  @{ GOOS = 'darwin';  GOARCH = 'arm64'; Name = 'framecall-helper-macos-arm64' },
  @{ GOOS = 'darwin';  GOARCH = 'amd64'; Name = 'framecall-helper-macos-amd64' },
  @{ GOOS = 'linux';   GOARCH = 'amd64'; Name = 'framecall-helper-linux-amd64' }
)

foreach ($t in $targets) {
  $env:GOOS = $t.GOOS
  $env:GOARCH = $t.GOARCH
  $env:CGO_ENABLED = '0'
  $target = Join-Path $out $t.Name
  Write-Host "building $($t.GOOS)/$($t.GOARCH) -> $target"
  go build -trimpath -ldflags "-s -w" -o $target .
  if ($LASTEXITCODE -ne 0) { throw "build failed for $($t.GOOS)/$($t.GOARCH)" }
  if ($t.GOOS -eq 'windows') { Sign-Binary $target }
}

Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
Get-ChildItem $out | Select-Object Name, Length
