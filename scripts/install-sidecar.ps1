# Windows counterpart of install-sidecar.sh: installs the anki-wait-sidecar
# release pinned in sidecar.lock into bin\ beside the plugin, checking it
# against the pinned SHA-256, and prints one JSON line.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root 'bin'
$bin = Join-Path $binDir 'anki-wait-sidecar.exe'
$lock = Join-Path $root 'sidecar.lock'

function Ok($source) {
  @{ ok = $true; path = $bin; source = $source } | ConvertTo-Json -Compress
  exit 0
}
function Fail($code, $message) {
  @{ ok = $false; code = $code; message = $message } | ConvertTo-Json -Compress
  exit 1
}
function Field($key) {
  if (-not (Test-Path $lock)) { return $null }
  foreach ($line in Get-Content $lock) {
    $parts = $line.Trim() -split '\s+'
    if ($parts[0] -eq $key -and $parts.Count -ge 2) { return $parts[1] }
  }
  return $null
}
function Sha256($path) {
  (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if ((Test-Path (Join-Path $binDir '.dev')) -and (Test-Path $bin)) { Ok 'dev' }

# Windows on ARM runs the x64 build under emulation.
$key = 'windows-x64'
$repo = Field 'repo'
$version = Field 'version'
$sha = Field $key
if (-not $version -or -not $sha) { Fail 'missing' 'no sidecar release pinned yet; set sidecarPath to a local build' }

if ((Test-Path $bin) -and ((Sha256 $bin) -eq $sha)) { Ok 'release' }

$base = if ($env:ANKI_WAIT_RELEASE_URL) { $env:ANKI_WAIT_RELEASE_URL } else { "https://github.com/$repo/releases/download/$version" }
$url = "$base/anki-wait-sidecar-$key.gz"
$tmp = "$bin.download.$PID"
try {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  try { Invoke-WebRequest -Uri $url -OutFile "$tmp.gz" -UseBasicParsing -TimeoutSec 120 }
  catch { Fail 'network' "couldn't download $url" }

  $in = [IO.File]::OpenRead("$tmp.gz")
  $out = [IO.File]::Create($tmp)
  try {
    $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
    $gz.CopyTo($out)
  } finally {
    $out.Dispose(); $in.Dispose()
  }

  if ((Sha256 $tmp) -ne $sha) { Fail 'checksum' "the downloaded sidecar doesn't match sidecar.lock; not installing it" }
  Move-Item -Force -Path $tmp -Destination $bin
  Ok 'release'
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue "$tmp.gz", $tmp
}
