$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null

go test ./... 
if ($LASTEXITCODE -ne 0) { throw "tests failed" }

$targets = @(
  @{ GOOS = 'windows'; GOARCH = 'amd64'; Ext = '.exe'; Name = 'framecall-helper-windows-amd64.exe' },
  @{ GOOS = 'windows'; GOARCH = 'arm64'; Ext = '.exe'; Name = 'framecall-helper-windows-arm64.exe' },
  @{ GOOS = 'darwin';  GOARCH = 'arm64'; Ext = '';     Name = 'framecall-helper-macos-arm64' },
  @{ GOOS = 'darwin';  GOARCH = 'amd64'; Ext = '';     Name = 'framecall-helper-macos-amd64' },
  @{ GOOS = 'linux';   GOARCH = 'amd64'; Ext = '';     Name = 'framecall-helper-linux-amd64' }
)

foreach ($t in $targets) {
  $env:GOOS = $t.GOOS
  $env:GOARCH = $t.GOARCH
  $env:CGO_ENABLED = '0'
  $target = Join-Path $out $t.Name
  Write-Host "building $($t.GOOS)/$($t.GOARCH) -> $target"
  go build -trimpath -ldflags "-s -w" -o $target .
  if ($LASTEXITCODE -ne 0) { throw "build failed for $($t.GOOS)/$($t.GOARCH)" }
}

Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
Get-ChildItem $out | Select-Object Name, Length
