$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function FetchOnce([string]$url) {
    Write-Output ("=== " + $url + " ===")
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.UserAgent = $ua
        $req.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        $req.AllowAutoRedirect = $false
        $req.Method = "GET"
        $req.Timeout = 20000
        $resp = $req.GetResponse()
        Write-Output ("Status: " + [int]$resp.StatusCode + " " + $resp.StatusCode)
        foreach ($k in @("Location","Content-Type","Content-Length")) {
            $v = $resp.Headers[$k]; if ($v) { Write-Output ($k + ": " + $v) }
        }
        if ([int]$resp.StatusCode -ge 200 -and [int]$resp.StatusCode -lt 300) {
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $sr.ReadToEnd(); $sr.Close()
            Write-Output ("Body length: " + $body.Length)
            $hits = [regex]::Matches($body, "https?://[A-Za-z0-9.\-_/]+\.(?:msix|msixbundle|exe)") | ForEach-Object { $_.Value } | Sort-Object -Unique
            if ($hits) { Write-Output "MSIX/EXE links:"; $hits | ForEach-Object { Write-Output ("  " + $_) } }
            $linkHits = [regex]::Matches($body, 'href="([^"]*download[^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
            if ($linkHits) { Write-Output "download href links:"; $linkHits | Select-Object -First 30 | ForEach-Object { Write-Output ("  " + $_) } }
            $win = [regex]::Matches($body, '"[^"]*windows[^"]*"', 'IgnoreCase') | ForEach-Object { $_.Value } | Sort-Object -Unique
            if ($win) { Write-Output "windows mentions:"; $win | Select-Object -First 20 | ForEach-Object { Write-Output ("  " + $_) } }
        }
        $resp.Close()
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($resp) {
            Write-Output ("Status: " + [int]$resp.StatusCode)
            foreach ($k in @("Location","Content-Type","Content-Length")) {
                $v = $resp.Headers[$k]; if ($v) { Write-Output ($k + ": " + $v) }
            }
            $resp.Close()
        } else {
            Write-Output ("err: " + $_.Exception.Message)
        }
    }
}

foreach ($u in @("https://claude.ai/download", "https://claude.com/download")) {
    FetchOnce $u
}
