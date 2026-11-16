$ErrorActionPreference = 'Stop'
$port = 41209
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)

function Send-Response {
  param(
    [System.IO.Stream] $Stream,
    [int] $Status,
    [string] $Reason,
    [string] $Headers = '',
    [string] $Body = ''
  )

  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $response = "HTTP/1.1 $Status $Reason`r`n$Headers" +
    "Content-Type: text/plain; charset=utf-8`r`n" +
    "Cache-Control: no-store`r`n" +
    "Connection: close`r`n" +
    "Content-Length: $($bodyBytes.Length)`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($response)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($bodyBytes.Length -gt 0) {
    $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
  }
  $Stream.Flush()
}

function Get-QueryValues {
  param([string] $Query)

  $values = @{}
  foreach ($part in $Query.TrimStart('?').Split('&')) {
    if (-not $part) { continue }
    $pair = $part.Split('=', 2)
    $name = [System.Uri]::UnescapeDataString(($pair[0] -replace '\+', ' '))
    $value = if ($pair.Length -gt 1) {
      [System.Uri]::UnescapeDataString(($pair[1] -replace '\+', ' '))
    } else {
      ''
    }
    $values[$name] = $value
  }
  return $values
}

try {
  $listener.Start()
} catch {
  Write-Host "Could not start the Framecall sign-in helper on port $port. Close any other helper window and try again." -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host "Framecall sign-in helper is ready on 127.0.0.1:$port." -ForegroundColor Green
Write-Host 'Keep this window open while you sign in. You can close it after your account appears in Framecall.'

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $stream.ReadTimeout = 10000
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      while ($null -ne ($headerLine = $reader.ReadLine()) -and $headerLine -ne '') { }

      if (-not $requestLine) {
        Send-Response -Stream $stream -Status 400 -Reason 'Bad Request' -Body 'Invalid request.'
        continue
      }

      $requestParts = $requestLine.Split(' ')
      if ($requestParts.Length -lt 2 -or $requestParts[0] -ne 'GET') {
        Send-Response -Stream $stream -Status 405 -Reason 'Method Not Allowed' -Headers "Allow: GET`r`n" -Body 'GET only.'
        continue
      }

      $uri = [System.Uri]::new("http://127.0.0.1:$port$($requestParts[1])")
      if ($uri.AbsolutePath -eq '/healthz') {
        Send-Response -Stream $stream -Status 200 -Reason 'OK' -Body 'ready'
        continue
      }

      if ($uri.AbsolutePath -ne '/oauth-callback') {
        Send-Response -Stream $stream -Status 404 -Reason 'Not Found' -Body 'Not found.'
        continue
      }

      $query = Get-QueryValues -Query $uri.Query
      $state = [string]$query['state']
      $code = [string]$query['code']
      $oauthError = [string]$query['error']
      if (-not $state -or (-not $code -and -not $oauthError)) {
        Send-Response -Stream $stream -Status 400 -Reason 'Bad Request' -Body 'Google sign-in response is incomplete.'
        continue
      }

      $forward = [System.Collections.Generic.List[string]]::new()
      $forward.Add('state=' + [System.Uri]::EscapeDataString($state))
      if ($code) {
        $forward.Add('code=' + [System.Uri]::EscapeDataString($code))
      }
      if ($oauthError) {
        $forward.Add('error=' + [System.Uri]::EscapeDataString($oauthError))
      }
      $destination = 'https://framecall.site/oauth/callback?' + ($forward -join '&')
      $headers = "Location: $destination`r`n"
      Send-Response -Stream $stream -Status 302 -Reason 'Found' -Headers $headers
      Write-Host 'Google callback forwarded to Framecall.' -ForegroundColor Green
    } catch {
      Write-Host "Relay request failed ($($_.Exception.GetType().Name)); no sign-in code was logged." -ForegroundColor Red
      try { Send-Response -Stream $client.GetStream() -Status 500 -Reason 'Internal Server Error' -Body 'Relay error.' } catch { }
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
