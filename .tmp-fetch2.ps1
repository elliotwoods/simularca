$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$req = [System.Net.HttpWebRequest]::Create("https://claude.com/download")
$req.UserAgent = $ua
$req.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
$req.AllowAutoRedirect = $true
$req.Method = "GET"
$req.Timeout = 20000
$resp = $req.GetResponse()
$sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
$body = $sr.ReadToEnd(); $sr.Close(); $resp.Close()

Write-Output ("Body length: " + $body.Length)

# Find all hrefs related to win/msix/exe
$hrefs = [regex]::Matches($body, 'href="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Output "=== hrefs containing win/msix/exe/download/anthropic/claude (excluding nav) ==="
$hrefs | Where-Object { $_ -match '(?i)(win|msix|\.exe|/release|installer|anthropic-cdn|cdn\.claude|downloads\.claude)' -and $_ -notmatch '^/[a-z]{2,3}/' } | ForEach-Object { Write-Output ("  " + $_) }

Write-Output ""
Write-Output "=== all distinct hosts found in URLs ==="
[regex]::Matches($body, 'https?://[^"''<>\s/]+') | ForEach-Object { $_.Value } | Sort-Object -Unique | Where-Object { $_ -match '(?i)(claude|anthropic)' } | ForEach-Object { Write-Output ("  " + $_) }

Write-Output ""
Write-Output "=== data-app-download attribute context ==="
[regex]::Matches($body, 'data-app-download="(win[^"]*)"[^>]{0,400}') | Select-Object -First 8 | ForEach-Object { Write-Output ("  " + $_.Value) }
